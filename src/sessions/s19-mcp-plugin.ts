/**
 * s19: MCP Plugin
 * 模型上下文协议：连接外部 MCP server，动态发现工具并合并进工具池
 *
 * 在 s18（工作树隔离）基础上新增：
 *   - MCPClient：单个 server 的工具发现 + 调用（教学版 mock）
 *   - MCPManager：多 server 连接管理 + assembleToolPool 工具池组装
 *   - normalizeMcpName：工具名归一化，MCP 工具命名 mcp__{server}__{tool}
 *   - 动态工具池：connect_mcp 后重新组装，系统提示词工具清单同步刷新
 *   - readOnly/destructive 注解：破坏性工具在描述里标注
 *   - 1 个新工具：connect_mcp
 *
 * ASCII 流程：
 *   connect_mcp("docs") → MCPClient discovers tools →
 *   assembleToolPool → [builtin... , mcp__docs__search, mcp__docs__get_version]
 *   agent_loop uses assembled pool
 */

import readline from 'node:readline'
import { client, MODEL, WORKDIR, hasToolUseBlocks } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import { SystemPromptBuilder } from '../persistence/prompt'
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
} from '../core/types'

// ============================================================================
// 核心指令
// ============================================================================

const S19_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

You have a memory system that persists information across sessions.
When you learn something worth remembering, use save_memory to save it.

${MEMORY_GUIDANCE}

This agent has a task system for planning and tracking multi-step work.
Key workflow: create tasks with blockedBy dependencies → claim → complete.

Background execution: bash tool supports run_in_background parameter.
For slow operations (install, build, test, deploy), set run_in_background=true.
When a background task completes, you will receive a notification automatically.

Cron scheduling: use schedule_cron to set up recurring or one-shot timed tasks.
cron expression is 5-field: minute hour day-of-month month day-of-week.
Examples: "*/5 * * * *" (every 5 min), "0 9 * * *" (daily 9am), "0 9 * * 1-5" (weekday 9am).
Set recurring=false for one-shot reminders, durable=true to persist across sessions.
When a cron job fires, you will receive "[Scheduled] {prompt}" automatically.

Agent teams: you are the Lead. Use spawn_teammate to delegate work to teammates.
Teammates are AUTONOMOUS: after finishing assigned work they enter IDLE and
scan the task board, auto-claiming pending tasks whose dependencies are done.
Teammates have their own tools (bash, read_file, write_file, send_message,
submit_plan, list_tasks, claim_task, complete_task). They stay alive until
shut down or idle-timeout after 60s without work.
Use create_task to put work on the board — teammates will pick it up by
themselves. Use request_shutdown to close a teammate gracefully.

Team protocols (request-response handshakes, correlated by request_id):
- request_shutdown: ask a teammate to shut down gracefully. The teammate
  responds with approve=true and exits; its final summary arrives as a result.
- request_plan: ask a teammate to submit a plan before acting. It will call
  submit_plan, which arrives in your inbox as a plan_approval_request.
- review_plan: approve or reject a submitted plan by request_id. The teammate
  receives the verdict and proceeds (approved) or revises (rejected).

Worktree isolation: use create_worktree to isolate risky or long-running work
into a dedicated git worktree at .worktrees/{name} with its own branch wt/{name}.
Optionally pass task_id to bind the worktree to a task — the teammate claiming
that task will automatically work inside the worktree directory.
Use remove_worktree to clean up (refuses if uncommitted changes unless
discard_changes=true), or keep_worktree to preserve a worktree for review.

MCP plugins: MCP servers are defined in .mcp.json (docs, deploy). Use connect_mcp
to spawn a server process, perform the JSON-RPC handshake, and discover its tools.
After connecting, the server's tools become available with names prefixed
mcp__{server}__{tool} (e.g. mcp__docs__search). Tool descriptions carry
(readOnly) or (destructive) annotations — treat destructive MCP tools with
the same care as destructive bash commands.

IMPORTANT MCP rules:
- MCP connections are in-memory only: if this session just started, no
  server is connected yet. Always call connect_mcp first — check the
  [mcp] connected log or /status before assuming a server is available.
- Once connected, call MCP tools DIRECTLY (e.g. mcp__docs__search).
  Never use bash to write temporary scripts that import MCPManager or
  re-implement MCP calls — the tools themselves are the interface.`

// ============================================================================
// Session Context
// ============================================================================

interface SessionContext {
  history: Message[]
  allTools: ToolDefinition[]
  handlers: Record<string, ToolHandler>
  promptBuilder: SystemPromptBuilder
  bgManager: BackgroundManager
  cronManager: CronManager
  bus: MessageBus
  teammateManager: TeammateManager
  protocolManager: ProtocolManager
  mcpManager: MCPManager

  // 并发控制
  isIdle: () => boolean
  setBusy: () => void
  setIdle: () => void

  // 定时器管理
  queueTimer: NodeJS.Timeout | null
  cronTimer: NodeJS.Timeout | null
  ensureQueue: () => void
  checkQueueStop: () => void
}

// ============================================================================
// Queue Processor（三源：background + cron + lead 收件箱）
// ============================================================================

function processQueue(ctx: SessionContext): void {
  if (!ctx.isIdle()) return
  // 三源：后台完成 或 cron 队列有任务 或 lead 收件箱有信，都触发 agent turn
  if (!ctx.bgManager.hasCompleted() && !ctx.cronManager.hasQueue() && !ctx.bus.peek('lead')) {
    return
  }

  console.log('\n  \x1b[35m[queue processor] delivering work\x1b[0m')
  ctx.setBusy()

  runAgentTurn(ctx).then(() => {
    console.log('\x1b[36ms19 >> \x1b[0m')
    ctx.setIdle()
    ctx.checkQueueStop()
  })
}

// ============================================================================
// Agent Turn
// ============================================================================

async function runAgentTurn(ctx: SessionContext): Promise<void> {
  // 注入之前积攒的异步消息（后台完成 + cron 触发 + 队友来信）
  const notifications = ctx.bgManager.collectResults()
  const firedJobs = ctx.cronManager.consumeQueue()
  const inbox = consumeLeadInbox(ctx.bus, ctx.protocolManager)

  if (notifications.length > 0 || firedJobs.length > 0 || inbox.length > 0) {
    const parts: string[] = []
    for (const notif of notifications) parts.push(notif)
    for (const job of firedJobs) {
      parts.push(`[Scheduled] ${job.prompt}`)
      console.log(`  \x1b[35m[inject cron] ${job.prompt.slice(0, 50)}\x1b[0m`)
    }
    if (inbox.length > 0) {
      parts.push(
        '[Inbox]\n' + inbox.map((m) => `From ${m.from}: ${m.content.slice(0, 200)}`).join('\n'),
      )
      console.log(`  \x1b[33m[inject inbox] ${inbox.length} message(s)\x1b[0m`)
    }
    ctx.history.push({ role: 'user', content: parts.join('\n') })
  }

  const systemPrompt = ctx.promptBuilder.build()
  const anthropicTools: Anthropic.Tool[] = ctx.allTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }))

  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: systemPrompt,
      messages: ctx.history,
      tools: anthropicTools,
      max_tokens: 8000,
    })

    ctx.history.push({
      role: 'assistant',
      content: response.content as ContentBlock[],
    })

    // 按内容判断是否还有工具调用（兼容 stop_reason 不可靠的网关）
    if (!hasToolUseBlocks(response.content)) {
      break
    }

    // 执行工具（同步/后台两条路径）
    const results: (ToolResultBlock | { type: 'text'; text: string })[] = []

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      const toolBlock = block as Anthropic.Messages.ToolUseBlock
      const toolInput = toolBlock.input as Record<string, unknown>

      if (ctx.bgManager.shouldRunBackground(toolBlock.name, toolInput)) {
        // 后台路径
        const bgId = ctx.bgManager.startTask(toolBlock.name, toolInput)
        ctx.ensureQueue()
        results.push({
          type: 'tool_result' as const,
          tool_use_id: toolBlock.id,
          content: `[Background task ${bgId} started] Result will be available when complete.`,
        })
      } else {
        // 同步路径
        const handler = ctx.handlers[toolBlock.name]
        let output: string
        try {
          output = handler ? String(await handler(toolInput)) : `Unknown tool: ${toolBlock.name}`
        } catch (e) {
          output = `Error: ${(e as Error).message}`
        }
        console.log(`\x1b[36m> ${toolBlock.name}\x1b[0m`)
        console.log(output.slice(0, 300))
        results.push({
          type: 'tool_result' as const,
          tool_use_id: toolBlock.id,
          content: output,
        })
      }
    }

    // 收集本轮后台通知，合入同一条 user 消息
    const bgNotifications = ctx.bgManager.collectResults()
    if (bgNotifications.length > 0) {
      for (const notif of bgNotifications) {
        results.unshift({ type: 'text', text: notif })
      }
    }

    ctx.history.push({ role: 'user', content: results as ContentBlock[] })
  }

  // 显示最后的文本回复
  const lastContent = ctx.history[ctx.history.length - 1]?.content
  if (Array.isArray(lastContent)) {
    for (const block of lastContent) {
      if (block.type === 'text') {
        console.log(block.text)
      }
    }
  }
  console.log('')
}

// ============================================================================
// Cron Scheduler 定时器 YYYY-MM-DD HH:MM
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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 1. 创建各 Manager
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

  // 2. 加载持久化的 cron 任务
  cronManager.loadDurable()

  // 3. 创建 MemoryManager
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  // 4. 内置工具（固定部分）+ 动态 MCP 工具池
  const baseTools: ToolDefinition[] = [
    ...BASE_TOOLS,
    ...TASK_TOOLS,
    ...CRON_TOOLS,
    ...TEAM_TOOLS,
    ...PROTOCOL_TOOLS,
    ...WORKTREE_TOOLS,
    ...MCP_TOOLS,
  ]

  // 5. 创建 SystemPromptBuilder（工具清单会在 connect_mcp 后更新）
  const promptBuilder = new SystemPromptBuilder({
    tools: baseTools,
    memoryManager,
    baseSystem: S19_BASE_SYSTEM,
  })

  // 6. 显示启动信息
  console.log(`[System prompt: ${promptBuilder.build().length} chars]`)
  console.log('[All systems + MCP plugins enabled]')
  if (memoryManager.memories.size > 0) {
    console.log(`[${memoryManager.memories.size} memories loaded]`)
  } else {
    console.log('[No existing memories]')
  }

  // 7. 工具 handlers（固定部分）
  const baseHandlers: Record<string, ToolHandler> = {
    ...BASE_HANDLERS,

    save_memory: (input) => {
      const result = memoryManager.saveMemory(
        input.name as string,
        input.description as string,
        input.type as string,
        input.content as string,
      )
      promptBuilder.invalidateCache()
      return result
    },

    ...createTaskHandlers(taskManager),
    ...createCronHandlers(cronManager),
    ...createTeamHandlers(bus, teammateManager, { onSpawn: () => ensureQueue() }),
    ...createProtocolHandlers(bus, protocolManager),
    ...createWorktreeHandlers(worktreeManager, taskManager),

    // 协议感知的 check_inbox
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

  // 8. 动态工具池（s19）：内置 + MCP，connect 后重新组装
  let pool = { tools: baseTools, handlers: baseHandlers }

  const refreshPool = () => {
    pool = mcpManager.assembleToolPool(baseTools, baseHandlers)
    // 同步更新系统提示词的工具清单（updateTools 内部失效缓存）
    promptBuilder.updateTools(pool.tools)
    console.log(
      `  \x1b[31m[mcp] tool pool: ${pool.tools.length} tools (${mcpManager.listConnected().length} MCP server(s))\x1b[0m`,
    )
  }

  // connect_mcp 的 handlers 加在 baseHandlers 里，连接成功后刷新池
  Object.assign(baseHandlers, createMcpHandlers(mcpManager, { onConnect: refreshPool }))

  // 9. 消息历史 + 空闲状态 + 定时器管理
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
    // 四种情况不停：运行中的后台任务、未交付的后台通知、未交付的 cron 任务、
    // 活跃队友或 lead 收件箱有未读消息
    if (bgManager.listRunning().length > 0) return
    if (bgManager.hasCompleted()) return
    if (cronManager.hasQueue()) return
    if (teammateManager.hasActive()) return
    if (bus.peek('lead')) return
    clearInterval(queueTimer)
    queueTimer = null
    console.log('  \x1b[35m[queue processor] stopped\x1b[0m')
  }

  // 10. 构造 SessionContext
  const ctx: SessionContext = {
    history,
    handlers: pool.handlers,
    allTools: pool.tools,
    promptBuilder,
    bgManager,
    cronManager,
    bus,
    teammateManager,
    protocolManager,
    mcpManager,
    isIdle,
    setBusy,
    setIdle,
    queueTimer,
    cronTimer,
    ensureQueue,
    checkQueueStop,
  }

  // 11. 启动 cron scheduler（每 1s 检查时间）
  cronTimer = setInterval(() => {
    const now = new Date()
    const minuteMarker = formatMinuteMarker(now) // YYYY-MM-DD HH:MM

    for (const job of cronManager.listJobs()) {
      try {
        if (cronMatches(job.cron, now)) {
          const lastFired = cronManager.getLastFired(job.id)
          if (lastFired !== minuteMarker) {
            cronManager.fireJob(job.id, minuteMarker)
            console.log(`  \x1b[35m[cron fire] ${job.id} → ${job.prompt.slice(0, 40)}\x1b[0m`)
            ensureQueue() // 有 cron 任务触发了，确保 queue processor 在跑
          }
        }
      } catch (e) {
        console.log(`  \x1b[31m[cron error] ${job.id}: ${(e as Error).message}\x1b[0m`)
      }
    }
  }, 1000)
  console.log('  \x1b[35m[cron] scheduler started\x1b[0m')

  // 12. REPL 主循环
  let hadTeammates = false
  while (true) {
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms19 >> \x1b[0m', (answer) => {
          if (answer === undefined) reject(new Error('EOF'))
          else resolve(answer)
        })
      })
    } catch {
      break
    }

    // 退出命令
    if (
      query.trim().toLowerCase() === 'q' ||
      query.trim().toLowerCase() === 'exit' ||
      !query.trim()
    ) {
      break
    }

    // /help 命令
    if (query.trim() === '/help') {
      console.log('Commands:')
      console.log('  /help      - Show this help message')
      console.log(
        '  /status    - Show task, background, cron, team, protocol, worktree, MCP status',
      )
      console.log('  q/exit     - Exit the session')
      continue
    }

    // /status 命令
    if (query.trim() === '/status') {
      const tasks = await taskManager.listAll()
      const pending = tasks.filter((t) => t.status === 'pending').length
      const inProgress = tasks.filter((t) => t.status === 'in_progress').length
      const completed = tasks.filter((t) => t.status === 'completed').length
      console.log('Status:')
      console.log(
        `  Tasks: ${tasks.length} total (${pending} pending, ${inProgress} in progress, ${completed} completed)`,
      )
      const running = bgManager.listRunning()
      console.log(`  Background: ${running.length} running`)
      for (const bg of running) {
        console.log(`    ${bg.id}: ${bg.command.slice(0, 40)} [${bg.status}]`)
      }
      const cronJobs = cronManager.listJobs()
      console.log(`  Cron: ${cronJobs.length} job(s)`)
      for (const job of cronJobs) {
        const tag = job.recurring ? 'recurring' : 'one-shot'
        console.log(`    ${job.id}: '${job.cron}' → ${job.prompt.slice(0, 30)} [${tag}]`)
      }
      const teammates = teammateManager.listActive()
      console.log(`  Teammates: ${teammates.length} active`)
      for (const name of teammates) {
        console.log(`    ${name}`)
      }
      const requests = protocolManager.listAll()
      console.log(`  Protocol requests: ${requests.length}`)
      for (const r of requests) {
        console.log(`    ${r.requestId}: ${r.type} ${r.sender} → ${r.target} [${r.status}]`)
      }
      const worktrees = await worktreeManager.list()
      console.log(`  Worktrees: ${worktrees.length}`)
      for (const wt of worktrees) {
        console.log(`    ${wt.name} (${wt.branch})`)
      }
      const mcpServers = mcpManager.listConnected()
      console.log(`  MCP servers: ${mcpServers.length} connected`)
      for (const s of mcpServers) {
        console.log(`    ${s}`)
      }
      continue
    }

    // 等待 queue processor 的 turn 完成后再处理用户输入
    while (!isIdle()) {
      await new Promise((r) => setTimeout(r, 50))
    }

    // 正常请求
    setBusy()
    history.push({ role: 'user', content: query })

    // s19: 每轮开始前用最新工具池（connect_mcp 后已刷新）
    ctx.allTools = pool.tools
    ctx.handlers = pool.handlers
    await runAgentTurn(ctx)

    setIdle()
    checkQueueStop()

    // 所有队友完成且输出已交付时，提示一次
    if (teammateManager.hasActive()) {
      hadTeammates = true
    } else if (hadTeammates && !bus.peek('lead') && !bgManager.hasCompleted()) {
      console.log('\x1b[32m[all teammates done]\x1b[0m')
      hadTeammates = false
    }
  }

  // 清理
  if (queueTimer) clearInterval(queueTimer)
  if (cronTimer) clearInterval(cronTimer)
  mcpManager.disconnectAll() // kill 所有 MCP server 子进程
  rl.close()
  console.log('Goodbye!')
}

main().catch(console.error)
