/**
 * s_full: Comprehensive Agent - 全部机制，归到一个循环
 *
 * 把 s01-s19 的所有机制整合成一个完整的 harness：
 *   工具分发 + 权限 + hooks + todo + 任务图 + skill + memory + prompt 组装
 *   + 压缩 + 错误恢复 + 后台任务 + cron + 团队/协议/自治 + worktree + MCP
 *
 * 核心不变：调用模型 → 看有没有 tool_use 块 → 执行工具 → 结果回 messages。
 * 变化的是循环周围的 harness 完整了。每个机制挂在循环的哪个位置见下方注释。
 *
 * 组件在循环中的位置：
 *   用户输入前后  → UserPromptSubmit hooks（记录/审计）
 *   LLM 前        → cron queue + background notifications + todo reminder
 *   LLM 前        → compaction pipeline（微压缩 + 超限完整压缩）
 *   LLM 前        → assemble_system_prompt（memory + skills + MCP 状态）
 *   LLM 调用      → error recovery（429 退避 / prompt too long 反应式压缩）
 *   工具执行前    → PreToolUse hooks + permission
 *   工具分发      → assemble_tool_pool（builtin + MCP 动态）
 *   工具执行时    → background dispatch（慢操作后台线程）
 *   工具执行后    → PostToolUse hooks
 *   停止时        → Stop hooks
 */

import readline from 'node:readline'
import { client, MODEL, WORKDIR, hasToolUseBlocks } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { TodoManager, TODO_TOOL_DEFINITION, createTodoHandler } from '../planning/todo'
import { TASK_TOOL_DEFINITION, createTaskHandler } from '../planning/subagent'
import {
  SkillRegistry,
  LOAD_SKILL_TOOL_DEFINITION,
  createLoadSkillHandler,
} from '../planning/skill-loader'
import {
  estimateContextSize,
  microCompact,
  compactHistory,
  COMPACT_TOOL_DEFINITION,
  createCompactState,
} from '../persistence/compact'
import { HookManager } from '../persistence/hook'
import { PermissionManager } from '../persistence/permission'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import { SystemPromptBuilder } from '../persistence/prompt'
import { classifyError, backoffDelay } from '../persistence/recovery'
import { TaskManager, TASK_TOOLS, createTaskHandlers } from '../persistence/task-manager'
import { BackgroundManager } from '../persistence/background'
import { CronManager, CRON_TOOLS, createCronHandlers, cronMatches } from '../persistence/cron'
import { MessageBus } from '../team/message-bus'
import { TeammateManager, TEAM_TOOLS, createTeamHandlers } from '../team/teammate'
import {
  ProtocolManager,
  PROTOCOL_TOOLS,
  createProtocolHandlers,
  consumeLeadInbox,
} from '../team/protocols'
import { WorktreeManager, WORKTREE_TOOLS, createWorktreeHandlers } from '../team/worktree'
import { MCPManager, MCP_TOOLS, createMcpHandlers } from '../plugin/mcp'
import Anthropic from '@anthropic-ai/sdk'
import type {
  Message,
  ToolHandler,
  ToolDefinition,
  ContentBlock,
  ToolResultBlock,
  CompactState,
} from '../core/types'

// ============================================================================
// 常量
// ============================================================================

const DEFAULT_MAX_TOKENS = 8000
const ESCALATED_MAX_TOKENS = 16000

// ============================================================================
// 核心指令
// ============================================================================

const FULL_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

${MEMORY_GUIDANCE}

Planning: use todo_write for lightweight in-session planning (keeps you from
drifting), and create_task/claim_task/complete_task for cross-session task
graph work with blockedBy dependencies.

Delegation: use task to launch a one-shot subagent with isolated context
(returns only the summary), or spawn_teammate to start a persistent autonomous
teammate that idle-polls the task board and auto-claims pending tasks.
Protocols: request_plan / review_plan (approve teammate plans),
request_shutdown (close a teammate). Teammate messages arrive as "[Inbox]".

Background & cron: bash supports run_in_background for slow operations
(install, build, test, deploy). schedule_cron sets timed tasks (5-field cron);
fired jobs arrive as "[Scheduled] {prompt}".

Worktree isolation: create_worktree to isolate work into a dedicated git
worktree (branch wt/{name}); bind to a task so teammates work in that directory.

MCP: connect_mcp spawns a server from .mcp.json and discovers tools, available
as mcp__{server}__{tool}. Never use bash to script MCP calls — call MCP tools
directly after connect_mcp.

Context: use compact when the conversation gets long, or load_skill to pull in
specialized instructions on demand.`

// ============================================================================
// Session Context
// ============================================================================

interface SessionContext {
  history: Message[]
  handlers: Record<string, ToolHandler>
  allTools: ToolDefinition[]
  promptBuilder: SystemPromptBuilder
  compactState: CompactState

  // managers
  taskManager: TaskManager
  bgManager: BackgroundManager
  cronManager: CronManager
  bus: MessageBus
  teammateManager: TeammateManager
  protocolManager: ProtocolManager
  worktreeManager: WorktreeManager
  mcpManager: MCPManager
  hookManager: HookManager
  permissionManager: PermissionManager
  todoManager: TodoManager
  memoryManager: MemoryManager

  // 并发控制
  isIdle: () => boolean
  setBusy: () => void
  setIdle: () => void

  // 定时器
  queueTimer: NodeJS.Timeout | null
  cronTimer: NodeJS.Timeout | null
  ensureQueue: () => void
  checkQueueStop: () => void

  // 动态工具池
  pool: { tools: ToolDefinition[]; handlers: Record<string, ToolHandler> }
  refreshPool: () => void

  // 恢复状态
  maxTokens: number
  hasEscalated: boolean
  hasAttemptedReactiveCompact: boolean

  // REPL
  rl: readline.Interface
}

// ============================================================================
// 工具池组装
// ============================================================================

function assembleBuiltinTools(): {
  tools: ToolDefinition[]
  handlers: Record<string, ToolHandler>
} {
  // 注意：save_memory 的 handler 在 session 里组装（需要 memoryManager）
  return {
    tools: [
      ...BASE_TOOLS, // bash, read_file, write_file, edit_file, save_memory, glob
      TODO_TOOL_DEFINITION, // todo_write
      TASK_TOOL_DEFINITION, // task（一次性 subagent）
      LOAD_SKILL_TOOL_DEFINITION, // load_skill
      COMPACT_TOOL_DEFINITION, // compact
    ],
    handlers: {},
  }
}

// ============================================================================
// 权限询问（REPL 交互）
// ============================================================================

function askUser(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve))
}

// ============================================================================
// Queue Processor（三源：background + cron + lead 收件箱）
// ============================================================================

function processQueue(ctx: SessionContext): void {
  if (!ctx.isIdle()) return
  if (!ctx.bgManager.hasCompleted() && !ctx.cronManager.hasQueue() && !ctx.bus.peek('lead')) {
    return
  }

  console.log('\n  \x1b[35m[queue processor] delivering work\x1b[0m')
  ctx.setBusy()
  runAgentTurn(ctx).then(() => {
    console.log('\x1b[36mfull >> \x1b[0m')
    ctx.setIdle()
    ctx.checkQueueStop()
  })
}

// ============================================================================
// Agent Turn（核心循环）
// ============================================================================

async function runAgentTurn(ctx: SessionContext): Promise<void> {
  const todoManager = ctx.todoManager

  while (true) {
    // ── LLM 前：注入定时/后台/提醒 ──
    const firedJobs = ctx.cronManager.consumeQueue()
    const notifications = ctx.bgManager.collectResults()
    if (firedJobs.length > 0 || notifications.length > 0) {
      const parts: string[] = []
      for (const job of firedJobs) {
        parts.push(`[Scheduled] ${job.prompt}`)
        console.log(`  \x1b[35m[cron inject] ${job.prompt.slice(0, 60)}\x1b[0m`)
      }
      for (const n of notifications) parts.push(n)
      ctx.history.push({ role: 'user', content: parts.join('\n') })
    }

    // todo reminder：连续多轮没更新计划时提醒
    const reminder = todoManager.reminder()
    if (reminder) {
      ctx.history.push({ role: 'user', content: `<reminder>${reminder}</reminder>` })
      console.log(`  \x1b[35m${reminder}\x1b[0m`)
    }

    // ── LLM 前：压缩管线 ──
    ctx.history = microCompact(ctx.history)
    if (estimateContextSize(ctx.history) > 50_000) {
      console.log('  \x1b[33m[auto compact]\x1b[0m')
      ctx.history = await compactHistory(ctx.history, ctx.compactState)
    }

    // ── LLM 前：组装工具池 + 系统提示词 ──
    const systemPrompt = ctx.promptBuilder.build()
    const anthropicTools: Anthropic.Tool[] = ctx.allTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }))

    // ── LLM 调用 + 错误恢复 ──
    let response: Anthropic.Messages.Message
    try {
      response = await client.messages.create({
        model: MODEL,
        system: systemPrompt,
        messages: ctx.history,
        tools: anthropicTools,
        max_tokens: ctx.maxTokens,
      })
    } catch (e) {
      const category = classifyError(e)
      if (category === 'prompt_too_long' && !ctx.hasAttemptedReactiveCompact) {
        // 反应式压缩：上下文超长 → 摘要后重试
        ctx.hasAttemptedReactiveCompact = true
        console.log('  \x1b[33m[reactive compact] prompt too long, compacting\x1b[0m')
        ctx.history = await compactHistory(ctx.history, ctx.compactState)
        continue
      }
      if (category === 'connection_error') {
        console.log('  \x1b[31m[error] connection error, retrying\x1b[0m')
        await new Promise((r) => setTimeout(r, backoffDelay(0)))
        // 连接错误在下一轮重试（教学版不做完整指数退避循环，保持简单）
      }
      // 无法恢复：注入错误消息并停止
      ctx.history.push({
        role: 'assistant',
        content: [{ type: 'text', text: `[Error] ${(e as Error).name}: ${(e as Error).message}` }],
      })
      return
    }

    // max_tokens 升级：先提高 max_tokens 重试一次
    if (response.stop_reason === 'max_tokens' && !ctx.hasEscalated) {
      ctx.maxTokens = ESCALATED_MAX_TOKENS
      ctx.hasEscalated = true
      console.log(`  \x1b[33m[max_tokens] retry with ${ctx.maxTokens}\x1b[0m`)
      continue
    }
    ctx.maxTokens = DEFAULT_MAX_TOKENS
    ctx.hasEscalated = false

    ctx.history.push({ role: 'assistant', content: response.content as ContentBlock[] })

    // 没有 tool_use 块 → 停止
    if (!hasToolUseBlocks(response.content)) {
      ctx.hookManager.runHooks('Stop', { tool_name: '', tool_input: {} })
      return
    }

    // ── 执行工具 ──
    const results: (ToolResultBlock | { type: 'text'; text: string })[] = []
    let compactedNow = false

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const toolBlock = block as Anthropic.Messages.ToolUseBlock
      const toolInput = toolBlock.input as Record<string, unknown>
      console.log(`\x1b[36m> ${toolBlock.name}\x1b[0m`)

      // compact 工具：拦截处理（不走普通 handler）
      if (toolBlock.name === 'compact') {
        ctx.history = await compactHistory(
          ctx.history,
          ctx.compactState,
          toolInput.focus as string | undefined,
        )
        ctx.history.push({
          role: 'user',
          content: '[Compacted. Continue with summarized context.]',
        })
        compactedNow = true
        break
      }

      // PreToolUse hooks + 权限
      const hookResult = ctx.hookManager.runHooks('PreToolUse', {
        tool_name: toolBlock.name,
        tool_input: toolInput,
      })
      if (hookResult.blocked) {
        results.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: hookResult.blockReason || 'Blocked by hook',
        })
        continue
      }

      const decision = ctx.permissionManager.check(toolBlock.name, toolInput)
      if (decision.behavior === 'deny') {
        results.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: `Permission denied: ${decision.reason}`,
        })
        continue
      }
      if (decision.behavior === 'ask') {
        const answer = await askUser(
          ctx.rl,
          `\x1b[33m  Allow ${toolBlock.name}? (${decision.reason}) [y/n] \x1b[0m`,
        )
        if (answer.trim().toLowerCase() !== 'y') {
          results.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: 'Permission denied by user',
          })
          continue
        }
      }

      // 后台分发
      if (ctx.bgManager.shouldRunBackground(toolBlock.name, toolInput)) {
        const bgId = ctx.bgManager.startTask(toolBlock.name, toolInput)
        ctx.ensureQueue()
        results.push({
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: `[Background task ${bgId} started] Result will arrive as a task_notification.`,
        })
        continue
      }

      // 同步执行
      const handler = ctx.handlers[toolBlock.name]
      let output: string
      try {
        output = handler ? String(await handler(toolInput)) : `Unknown tool: ${toolBlock.name}`
      } catch (e) {
        output = `Error: ${(e as Error).message}`
      }

      ctx.hookManager.runHooks('PostToolUse', {
        tool_name: toolBlock.name,
        tool_input: toolInput,
        tool_output: output,
      })
      console.log(output.slice(0, 300))

      // todo 计数
      if (toolBlock.name === 'todo_write') {
        // TodoManager.update 内部已重置 roundsSinceUpdate
      } else {
        todoManager.noteRoundWithoutUpdate()
      }

      results.push({ type: 'tool_result', tool_use_id: toolBlock.id, content: output })
    }

    if (compactedNow) continue

    // 合并后台通知，追加 tool_results
    const userContent: ContentBlock[] = [...results]
    for (const note of ctx.bgManager.collectResults()) {
      userContent.unshift({ type: 'text', text: note })
    }
    ctx.history.push({ role: 'user', content: userContent })
  }
}

// ============================================================================
// Cron Scheduler 定时器
// ============================================================================

function formatMinuteMarker(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

// ============================================================================
// REPL 入口
// ============================================================================

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  // 1. 创建所有 manager
  const taskManager = new TaskManager()
  const bgManager = new BackgroundManager()
  const cronManager = new CronManager()
  const bus = new MessageBus()
  const protocolManager = new ProtocolManager()
  const worktreeManager = new WorktreeManager()
  const mcpManager = new MCPManager()
  const teammateManager = new TeammateManager(bus, {
    mode: 'autonomous',
    protocolManager,
    taskManager,
  })
  const hookManager = new HookManager()
  const permissionManager = new PermissionManager()
  const todoManager = new TodoManager()
  const skillRegistry = new SkillRegistry()
  const memoryManager = new MemoryManager()
  const compactState = createCompactState()

  cronManager.loadDurable()
  memoryManager.loadAll()

  // 2. 组装内置工具池（todo/subagent/skill/compact 的定义）
  const builtin = assembleBuiltinTools()

  // 3. base tools + base handlers
  const baseTools: ToolDefinition[] = [
    ...builtin.tools,
    ...TASK_TOOLS,
    ...CRON_TOOLS,
    ...TEAM_TOOLS,
    ...PROTOCOL_TOOLS,
    ...WORKTREE_TOOLS,
    ...MCP_TOOLS,
  ]

  const baseHandlers: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,
    todo_write: createTodoHandler(todoManager),
    task: createTaskHandler(),
    load_skill: createLoadSkillHandler(skillRegistry),
    ...createTaskHandlers(taskManager),
    ...createCronHandlers(cronManager),
    ...createTeamHandlers(bus, teammateManager, { onSpawn: () => ensureQueue() }),
    ...createProtocolHandlers(bus, protocolManager),
    ...createWorktreeHandlers(worktreeManager, taskManager),
    check_inbox: () => {
      const msgs = consumeLeadInbox(bus, protocolManager)
      if (msgs.length === 0) return '(inbox empty)'
      return msgs
        .map((m) => {
          const reqId = m.metadata?.request_id as string | undefined
          const tag = reqId ? ` [${m.type} req:${reqId}]` : ` [${m.type}]`
          return `  [${m.from}]${tag} ${m.content.slice(0, 200)}`
        })
        .join('\n')
    },
  }

  // 4. prompt builder
  const promptBuilder = new SystemPromptBuilder({
    tools: baseTools,
    memoryManager,
    baseSystem: FULL_BASE_SYSTEM,
  })

  // 5. 动态工具池（MCP）
  let pool = { tools: baseTools, handlers: baseHandlers }
  const refreshPool = () => {
    pool = mcpManager.assembleToolPool(baseTools, baseHandlers)
    promptBuilder.updateTools(pool.tools)
  }
  // save_memory 需要在 promptBuilder 就绪后组装
  baseHandlers.save_memory = (input) => {
    const result = memoryManager.saveMemory(
      input.name as string,
      input.description as string,
      input.type as string,
      input.content as string,
    )
    promptBuilder.invalidateCache()
    return result
  }
  // connect_mcp
  Object.assign(baseHandlers, createMcpHandlers(mcpManager, { onConnect: refreshPool }))

  // 6. 启动信息
  const fullPrompt = promptBuilder.build()
  console.log(`[System prompt: ${fullPrompt.length} chars]`)
  console.log('[Comprehensive agent: all s01-s19 mechanisms integrated]')
  console.log(`[${memoryManager.memories.size} memories loaded]`)

  // 7. 状态 + 定时器
  const history: Message[] = []
  let agentBusy = false
  let queueTimer: NodeJS.Timeout | null = null
  let cronTimer: NodeJS.Timeout | null = null

  const isIdle = () => !agentBusy
  const setBusy = () => {
    agentBusy = true
  }
  const setIdle = () => {
    agentBusy = false
  }
  const ensureQueue = () => {
    if (queueTimer) return
    queueTimer = setInterval(() => processQueue(ctx), 500)
    console.log('  \x1b[35m[queue processor] started\x1b[0m')
  }
  const checkQueueStop = () => {
    if (!queueTimer) return
    if (bgManager.listRunning().length > 0) return
    if (bgManager.hasCompleted()) return
    if (cronManager.hasQueue()) return
    if (teammateManager.hasActive()) return
    if (bus.peek('lead')) return
    clearInterval(queueTimer)
    queueTimer = null
    console.log('  \x1b[35m[queue processor] stopped\x1b[0m')
  }

  // 8. SessionContext
  const ctx: SessionContext = {
    history,
    handlers: pool.handlers,
    allTools: pool.tools,
    promptBuilder,
    compactState,
    taskManager,
    bgManager,
    cronManager,
    bus,
    teammateManager,
    protocolManager,
    worktreeManager,
    mcpManager,
    hookManager,
    permissionManager,
    todoManager,
    memoryManager,
    isIdle,
    setBusy,
    setIdle,
    queueTimer,
    cronTimer,
    ensureQueue,
    checkQueueStop,
    pool,
    refreshPool,
    maxTokens: DEFAULT_MAX_TOKENS,
    hasEscalated: false,
    hasAttemptedReactiveCompact: false,
    rl,
  }

  // 9. cron scheduler（每秒检查）
  cronTimer = setInterval(() => {
    const now = new Date()
    const minuteMarker = formatMinuteMarker(now)
    for (const job of cronManager.listJobs()) {
      try {
        if (cronMatches(job.cron, now)) {
          const lastFired = cronManager.getLastFired(job.id)
          if (lastFired !== minuteMarker) {
            cronManager.fireJob(job.id, minuteMarker)
            console.log(`  \x1b[35m[cron fire] ${job.id} → ${job.prompt.slice(0, 40)}\x1b[0m`)
            ensureQueue()
          }
        }
      } catch (e) {
        console.log(`  \x1b[31m[cron error] ${job.id}: ${(e as Error).message}\x1b[0m`)
      }
    }
  }, 1000)
  console.log('  \x1b[35m[cron] scheduler started\x1b[0m')

  // 10. REPL 主循环
  while (true) {
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36mfull >> \x1b[0m', (answer) => {
          if (answer === undefined) reject(new Error('EOF'))
          else resolve(answer)
        })
      })
    } catch {
      break
    }

    if (
      query.trim().toLowerCase() === 'q' ||
      query.trim().toLowerCase() === 'exit' ||
      !query.trim()
    ) {
      break
    }

    if (query.trim() === '/help') {
      console.log('Commands:')
      console.log('  /help      - Show this help message')
      console.log('  /status    - Show all subsystem status')
      console.log('  q/exit     - Exit the session')
      continue
    }

    if (query.trim() === '/status') {
      const tasks = await taskManager.listAll()
      console.log(
        `Tasks: ${tasks.length} | Teammates: ${teammateManager.listActive().length} | MCP: ${mcpManager.listConnected().join(', ') || 'none'} | Background: ${bgManager.listRunning().length} | Cron: ${cronManager.listJobs().length}`,
      )
      continue
    }

    // UserPromptSubmit hooks
    hookManager.runHooks('UserPromptSubmit', { tool_name: '', tool_input: { query } })

    // 等待 queue processor 完成
    while (!isIdle()) {
      await new Promise((r) => setTimeout(r, 50))
    }

    setBusy()
    history.push({ role: 'user', content: query })
    ctx.allTools = pool.tools
    ctx.handlers = pool.handlers
    ctx.hasAttemptedReactiveCompact = false

    await runAgentTurn(ctx)

    setIdle()
    checkQueueStop()

    // 打印最后的文本回复
    const lastContent = history[history.length - 1]?.content
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === 'text') console.log(block.text)
      }
    }
    console.log('')
  }

  // 清理
  if (queueTimer) clearInterval(queueTimer)
  if (cronTimer) clearInterval(cronTimer)
  mcpManager.disconnectAll()
  rl.close()
  console.log('Goodbye!')
}

main().catch(console.error)
