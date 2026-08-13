/**
 * s18: Worktree Isolation
 * 工作树隔离：每个任务一个独立的 git worktree + 专属分支，互不干扰
 *
 * 在 s17（自主代理）基础上新增：
 *   - WorktreeManager：创建/移除/保留 worktree + 名称校验 + 事件日志
 *   - Task 增加 worktree 字段：任务绑定到 worktree（保持 pending 等自动认领）
 *   - 队友认领带 worktree 的任务后，bash/read/write 自动切换到该目录
 *   - remove_worktree 安全检查：有未提交改动时拒绝删除
 *   - 3 个新工具：create_worktree、remove_worktree、keep_worktree
 *
 * ASCII 拓扑：
 *   Main repo (/)
 *     ├── .worktrees/auth/  (branch: wt/auth)  ← Task #1
 *     ├── .worktrees/ui/    (branch: wt/ui)     ← Task #2
 *     ├── .tasks/task_xxx.json (worktree: "auth")
 *     └── .worktrees/events.jsonl
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

const S18_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

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
discard_changes=true), or keep_worktree to preserve a worktree for review.`

// ============================================================================
// Session Context
// ============================================================================

interface SessionContext {
  history: Message[]
  handlers: Record<string, ToolHandler>
  allTools: ToolDefinition[]
  promptBuilder: SystemPromptBuilder
  bgManager: BackgroundManager
  cronManager: CronManager
  bus: MessageBus
  teammateManager: TeammateManager
  protocolManager: ProtocolManager

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
    console.log('\x1b[36ms18 >> \x1b[0m')
    ctx.setIdle()
    ctx.checkQueueStop()
  })
}

// ============================================================================
// Agent Turn
// ============================================================================

async function runAgentTurn(ctx: SessionContext): Promise<void> {
  // 注入之前积攒的异步消息（后台完成 + cron 触发 + 队友来信）
  // 收件箱走 consumeLeadInbox——协议响应要先路由进状态机
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
        results.unshift({
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
        results.push({ type: 'text', text: notif })
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
  // s18: 队友用 autonomous 模式，认领带 worktree 的任务后自动切换工作目录
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

  // 4. 创建 SystemPromptBuilder
  const allTools = [
    ...BASE_TOOLS,
    ...TASK_TOOLS,
    ...CRON_TOOLS,
    ...TEAM_TOOLS,
    ...PROTOCOL_TOOLS,
    ...WORKTREE_TOOLS,
  ]
  const promptBuilder = new SystemPromptBuilder({
    tools: allTools,
    memoryManager,
    baseSystem: S18_BASE_SYSTEM,
  })

  // 5. 显示启动信息
  const fullPrompt = promptBuilder.build()
  console.log(`[System prompt: ${fullPrompt.length} chars]`)
  console.log('[Task + background + cron + teams + protocols + autonomous + worktree enabled]')
  if (memoryManager.memories.size > 0) {
    console.log(`[${memoryManager.memories.size} memories loaded]`)
  } else {
    console.log('[No existing memories]')
  }

  // 6. 工具 handlers
  const handlers: Record<string, ToolHandler> = {
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

  // 7. 消息历史 + 空闲状态 + 定时器管理
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
    // 活跃队友或 lead 收件箱有未读消息（autonomous 队友随时可能来信）
    if (bgManager.listRunning().length > 0) return
    if (bgManager.hasCompleted()) return
    if (cronManager.hasQueue()) return
    if (teammateManager.hasActive()) return
    if (bus.peek('lead')) return
    clearInterval(queueTimer)
    queueTimer = null
    console.log('  \x1b[35m[queue processor] stopped\x1b[0m')
  }

  // 8. 构造 SessionContext
  const ctx: SessionContext = {
    history,
    handlers,
    allTools,
    promptBuilder,
    bgManager,
    cronManager,
    bus,
    teammateManager,
    protocolManager,
    isIdle,
    setBusy,
    setIdle,
    queueTimer,
    cronTimer,
    ensureQueue,
    checkQueueStop,
  }

  // 9. 启动 cron scheduler（每 1s 检查时间）
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

  // 10. REPL 主循环
  let hadTeammates = false
  while (true) {
    let query: string
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question('\x1b[36ms18 >> \x1b[0m', (answer) => {
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
      console.log('  /status    - Show task, background, cron, team, protocol, worktree status')
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
      continue
    }

    // 等待 queue processor 的 turn 完成后再处理用户输入
    while (!isIdle()) {
      await new Promise((r) => setTimeout(r, 50))
    }

    // 正常请求
    setBusy()
    history.push({ role: 'user', content: query })

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
  rl.close()
  console.log('Goodbye!')
}

main().catch(console.error)
