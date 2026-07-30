/**
 * s15: Agent Teams
 * 多代理团队：Lead 派生队友，队友在后台干活，通过文件邮箱异步通信
 *
 * 在 s14（定时调度）基础上新增：
 *   - MessageBus：文件邮箱消息总线（.mailboxes/*.jsonl）
 *   - TeammateManager：派生/管理后台队友代理
 *   - 三源 Queue Processor：background 通知 + cron 队列 + lead 收件箱
 *   - 3 个新工具：spawn_teammate、send_message、check_inbox
 *
 * ASCII 流程：
 *   Lead: cron队列 → messages → prompt → LLM → TOOLS ────→ loop
 *               ↑                    ↓                       |
 *               └── inbox ← MessageBus ← teammate.send_message ←┘
 *   Teammate: inbox → LLM → bash/read/write/send → loop (max 10 turns)
 */

import readline from 'node:readline'
import { client, MODEL, WORKDIR } from '../core/agent-loop'
import { BASE_TOOLS, BASE_HANDLERS } from '../core/tools'
import { MemoryManager, MEMORY_GUIDANCE } from '../persistence/memory'
import { SystemPromptBuilder } from '../persistence/prompt'
import { TaskManager, TASK_TOOLS, createTaskHandlers } from '../persistence/task-manager'
import { BackgroundManager } from '../persistence/background'
import { CronManager, CRON_TOOLS, createCronHandlers, cronMatches } from '../persistence/cron'
import { MessageBus } from '../team/message-bus'
import { TeammateManager, TEAM_TOOLS, createTeamHandlers } from '../team/teammate'
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

const S15_BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.

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

Agent teams: you are the Lead. Use spawn_teammate to delegate work to teammates
running in the background. Teammates have their own tools (bash, read_file,
write_file, send_message) and report results via send_message to 'lead'.
Use send_message to give teammates follow-up instructions, check_inbox to read
their messages. Teammate results also arrive automatically via "[Inbox]" messages.`

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
  // 注意：唤醒条件只看 bus.peek，不看 teammateManager.hasActive——
  // 队友发完 result 才注销，result 消息可能比注册表条目活得更久
  if (!ctx.bgManager.hasCompleted() && !ctx.cronManager.hasQueue() && !ctx.bus.peek('lead')) {
    return
  }

  console.log('\n  \x1b[35m[queue processor] delivering work\x1b[0m')
  ctx.setBusy()

  runAgentTurn(ctx).then(() => {
    console.log('\x1b[36ms15 >> \x1b[0m')
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
  const inbox = ctx.bus.readInbox('lead')

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

    if (response.stop_reason !== 'tool_use') {
      break
    }

    // 执行工具（同步/后台两条路径，和 s14 一致）
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
  const teammateManager = new TeammateManager(bus)

  // 2. 加载持久化的 cron 任务
  cronManager.loadDurable()

  // 3. 创建 MemoryManager
  const memoryManager = new MemoryManager()
  memoryManager.loadAll()

  // 4. 创建 SystemPromptBuilder
  const allTools = [...BASE_TOOLS, ...TASK_TOOLS, ...CRON_TOOLS, ...TEAM_TOOLS]
  const promptBuilder = new SystemPromptBuilder({
    tools: allTools,
    memoryManager,
    baseSystem: S15_BASE_SYSTEM,
  })

  // 5. 显示启动信息
  const fullPrompt = promptBuilder.build()
  console.log(`[System prompt: ${fullPrompt.length} chars]`)
  console.log('[Task system + background execution + cron scheduling + agent teams enabled]')
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
    // onSpawn: 队友开跑后要确保 queue processor 在跑，否则没人拾取 result 消息
    ...createTeamHandlers(bus, teammateManager, { onSpawn: () => ensureQueue() }),
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
    // 活跃队友或 lead 收件箱有未读消息（队友随时可能来信）
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
        rl.question('\x1b[36ms15 >> \x1b[0m', (answer) => {
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
      console.log('  /status    - Show task, background, cron, and team status')
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
