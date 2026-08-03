/**
 * s15 Agent Teams / s16 Team Protocols - Teammate
 * 队友代理：后台运行的简化 Agent，通过 MessageBus 和 Lead 通信
 *
 * 对标原项目 s15_agent_teams/code.py 的 spawn_teammate_thread + 团队工具
 *      s16_team_protocols/code.py 的 idle loop + 协议分发 + submit_plan
 * 差异：原项目用 threading.Thread 跑队友，Node.js 单线程用 async 函数挂到事件循环
 *       原项目队友 bash 用同步 subprocess（线程里不阻塞主循环），
 *       我们用异步 exec（否则会阻塞整个进程，Lead 的 REPL 会卡住）
 *
 * 两种运行模式（构造时选择）：
 *   rounds（默认，s15）：最多跑 10 轮就退出汇报
 *   idle（s16）：模型停下来后不退出，轮询收件箱等指令/协议消息，
 *               直到收到 shutdown_request 才退出
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { client, MODEL, WORKDIR, hasToolUseBlocks } from '../core/agent-loop'
import { runRead, runWrite } from '../core/tools'
import { MessageBus } from './message-bus'
import type { BusMessage } from './message-bus'
import { ProtocolManager } from './protocols'
import type { ContentBlock, ToolDefinition, ToolHandler } from '../core/types'

const execAsync = promisify(exec)

// ============================================================================
// 常量
// ============================================================================

/**
 * 队友最大轮数
 * 教学版限制 10 轮，防止队友无限跑烧 token。
 * 真实 Claude Code 用 idle loop（等收件箱 → 干活 → 再等），直到收到 shutdown_request。
 */
const MAX_TEAMMATE_TURNS = 10

/** 队友上下文窗口：只保留最近 N 条消息 */
const TEAMMATE_CONTEXT_LIMIT = 20

/** 队友 bash 超时（毫秒） */
const BASH_TIMEOUT = 120_000

/** 输出截断上限（字符数） */
const OUTPUT_LIMIT = 50_000

/** idle 模式收件箱轮询间隔（毫秒） */
const IDLE_POLL_INTERVAL = 1000

/** 队友侧需要分发的协议消息类型 */
const TEAMMATE_PROTOCOL_TYPES = ['shutdown_request', 'plan_approval_response']

// ============================================================================
// 队友工具（Lead 不可用的子集：bash / read_file / write_file / send_message）
// ============================================================================

const TEAMMATE_TOOLS: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
        limit: { type: 'integer', description: 'Maximum lines to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to another agent.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'content'],
    },
  },
]

/** s16: 队友专属的计划提交工具（idle 模式追加） */
const SUBMIT_PLAN_TOOL: ToolDefinition = {
  name: 'submit_plan',
  description: 'Submit a plan for Lead approval.',
  input_schema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan to submit' },
    },
    required: ['plan'],
  },
}

// ============================================================================
// 运行模式选项
// ============================================================================

export interface TeammateOptions {
  /**
   * 运行模式：
   *   false（默认，s15）：最多 MAX_TEAMMATE_TURNS 轮后退出汇报
   *   true（s16）：模型停下后轮询收件箱等指令，直到收到 shutdown_request
   */
  idle?: boolean
  /** s16: 协议管理器（idle 模式必需，submit_plan 要注册审批请求） */
  protocolManager?: ProtocolManager
}

// ============================================================================
// TeammateManager
// ============================================================================

/**
 * 队友管理器
 *
 * 对标原项目的 active_teammates 字典 + spawn_teammate_thread 函数。
 * 用类封装避免全局状态，和 TaskManager / BackgroundManager / CronManager 风格一致。
 *
 * 队友生命周期：
 *   spawn → 跑自己的简化 agent loop（最多 10 轮）→ 提取最后的文本总结
 *         → 通过 bus 发给 lead（type="result"）→ 从注册表移除
 *
 * 关键设计：队友 send 完 result 才移除自己，所以 result 消息可能比
 * 注册表条目活得更久——queue processor 的唤醒条件只看 bus.peek，
 * 不看队友是否还在注册表（对标原项目 inbox_poller 的注释）。
 */
export class TeammateManager {
  private active: Map<string, boolean> = new Map()

  constructor(
    private bus: MessageBus,
    private options: TeammateOptions = {},
  ) {}

  /**
   * 派生一个队友
   * 立即返回（不等待队友完成），队友在后台异步跑
   */
  spawn(name: string, role: string, prompt: string): string {
    if (this.active.has(name)) {
      return `Teammate '${name}' already exists`
    }

    this.active.set(name, true)
    // fire-and-forget：挂到事件循环，不阻塞 Lead
    const loop = this.options.idle ? this.runIdle(name, role, prompt) : this.run(name, role, prompt)
    void loop.catch((err) => {
      console.log(`  \x1b[31m[teammate] ${name} crashed: ${(err as Error).message}\x1b[0m`)
      this.bus.send(name, 'lead', `Error: ${(err as Error).message}`, 'result')
      this.active.delete(name)
    })

    console.log(`  \x1b[36m[teammate] ${name} spawned as ${role}\x1b[0m`)
    return `Teammate '${name}' spawned as ${role}`
  }

  /** 是否还有活跃队友 */
  hasActive(): boolean {
    return this.active.size > 0
  }

  /** 活跃队友名列表 */
  listActive(): string[] {
    return [...this.active.keys()]
  }

  // ==========================================================================
  // 队友的简化 agent loop
  // ==========================================================================

  private async run(name: string, role: string, prompt: string): Promise<void> {
    const system =
      `You are '${name}', a ${role}. ` +
      'Use tools to complete tasks. ' +
      "Send results via send_message to 'lead'."

    // 队友自己的消息历史（从 prompt 开始，干净上下文）
    const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
      { role: 'user', content: prompt },
    ]

    // 队友的工具 handlers：复用基础工具 + 自己的 send_message
    const handlers: Record<string, ToolHandler> = {
      bash: this.runBash,
      read_file: runRead,
      write_file: runWrite,
      send_message: (input) => {
        this.bus.send(name, input.to as string, input.content as string)
        return 'Sent'
      },
    }

    for (let turn = 0; turn < MAX_TEAMMATE_TURNS; turn++) {
      // 每轮开始前收信：Lead 可能在队友干活时追加指令
      const inbox = this.bus.readInbox(name)
      if (inbox.length > 0) {
        messages.push({ role: 'user', content: `<inbox>${JSON.stringify(inbox)}</inbox>` })
      }

      let response
      try {
        response = await client.messages.create({
          model: MODEL,
          system,
          messages: messages.slice(-TEAMMATE_CONTEXT_LIMIT) as never,
          tools: TEAMMATE_TOOLS as never,
          max_tokens: 8000,
        })
      } catch {
        break // API 错误：教学版直接退出，不再重试
      }

      messages.push({ role: 'assistant', content: response.content })

      // 按内容判断是否还有工具调用（兼容 stop_reason 不可靠的网关）
      if (!hasToolUseBlocks(response.content)) {
        break // 模型决定停止
      }

      messages.push({
        role: 'user',
        content: await this.executeToolCalls(response.content, handlers),
      })
    }

    // 提取最后的文本作为总结，汇报给 Lead
    const summary = this.extractSummary(messages)
    this.bus.send(name, 'lead', summary, 'result')
    this.active.delete(name)
    console.log(`  \x1b[32m[teammate] ${name} finished\x1b[0m`)
  }

  // ==========================================================================
  // 队友的 idle agent loop（s16：等指令，直到 shutdown_request）
  // ==========================================================================

  /**
   * idle 模式：模型停下来后不退出，轮询收件箱等新消息
   *
   * 和 rounds 模式的本质区别：队友的"完成"不再由轮数或 stop_reason 决定，
   * 而是由 Lead 的 shutdown_request 协议决定——干完活就待命，随时接受
   * 新指令（普通消息）、审批结果（plan_approval_response）或关闭请求。
   *
   * 为什么需要协议分发？协议消息（shutdown_request 等）不是给模型看的文本，
   * 而是要改变队友自身运行状态的控制信号——必须在注入上下文之前拦截处理。
   */
  private async runIdle(name: string, role: string, prompt: string): Promise<void> {
    const protocolManager = this.options.protocolManager
    if (!protocolManager) {
      throw new Error('idle mode requires protocolManager')
    }

    const system =
      `You are '${name}', a ${role}. ` +
      'Use tools to complete tasks. ' +
      'Check inbox for protocol messages (shutdown_request, etc). ' +
      "Send results via send_message to 'lead'."

    const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
      { role: 'user', content: prompt },
    ]

    // idle 模式多一个 submit_plan 工具
    const tools = [...TEAMMATE_TOOLS, SUBMIT_PLAN_TOOL]
    const handlers: Record<string, ToolHandler> = {
      bash: this.runBash,
      read_file: runRead,
      write_file: runWrite,
      send_message: (input) => {
        this.bus.send(name, input.to as string, input.content as string)
        return 'Sent'
      },
      submit_plan: (input) => {
        // 注册审批请求 → 发 plan_approval_request 给 Lead
        // 注意：这只是协议级请求，不是代码级闸门——队友发完还能继续跑，
        // 是否等审批靠模型自觉（真实 CC 会阻塞工具分发直到审批到达）
        const plan = input.plan as string
        const state = protocolManager.createRequest('plan_approval', name, 'lead', plan)
        this.bus.send(name, 'lead', plan, 'plan_approval_request', {
          request_id: state.requestId,
        })
        return `Plan submitted (${state.requestId}). Waiting for approval...`
      },
    }

    let shutdown = false
    while (!shutdown) {
      // 收信 + 协议分发：协议消息改变运行状态，普通消息注入上下文
      const inbox = this.bus.readInbox(name)
      const nonProtocol = this.dispatchInbox(name, inbox, messages)
      if (nonProtocol === null) break // 收到 shutdown_request
      if (nonProtocol.length > 0) {
        messages.push({ role: 'user', content: `<inbox>${JSON.stringify(nonProtocol)}</inbox>` })
      }

      let response
      try {
        response = await client.messages.create({
          model: MODEL,
          system,
          messages: messages.slice(-TEAMMATE_CONTEXT_LIMIT) as never,
          tools: tools as never,
          max_tokens: 8000,
        })
      } catch {
        break // API 错误：直接退出
      }

      messages.push({ role: 'assistant', content: response.content })

      // 按内容判断是否还有工具调用（兼容 stop_reason 不可靠的网关）
      if (!hasToolUseBlocks(response.content)) {
        // idle 等待：轮询收件箱，直到有新消息（回到 LLM turn）或 shutdown
        // 真实 CC 这里会发 idle_notification 给 Lead
        while (!shutdown) {
          await new Promise((r) => setTimeout(r, IDLE_POLL_INTERVAL))
          const idleInbox = this.bus.readInbox(name)
          if (idleInbox.length === 0) continue

          const idleNonProtocol = this.dispatchInbox(name, idleInbox, messages)
          if (idleNonProtocol === null) {
            shutdown = true
            break
          }
          if (idleNonProtocol.length > 0) {
            messages.push({
              role: 'user',
              content: `<inbox>${JSON.stringify(idleNonProtocol)}</inbox>`,
            })
            break // 有新指令，回到 LLM turn
          }
        }
        if (shutdown) break
        continue
      }

      messages.push({
        role: 'user',
        content: await this.executeToolCalls(response.content, handlers),
      })
    }

    // 提取最后的文本作为总结，汇报给 Lead（shutdown 后的告别语）
    const summary = this.extractSummary(messages)
    this.bus.send(name, 'lead', summary, 'result')
    this.active.delete(name)
    console.log(`  \x1b[32m[teammate] ${name} finished\x1b[0m`)
  }

  /**
   * 收件箱分发：协议消息就地处理，普通消息原样返回
   *
   * 返回 null 表示收到 shutdown_request（队友该停了）；
   * 否则返回非协议消息列表（调用方注入 <inbox> 上下文）。
   */
  private dispatchInbox(
    name: string,
    inbox: BusMessage[],
    messages: { role: 'user' | 'assistant'; content: unknown }[],
  ): BusMessage[] | null {
    const nonProtocol: BusMessage[] = []
    for (const msg of inbox) {
      if (TEAMMATE_PROTOCOL_TYPES.includes(msg.type)) {
        if (this.handleProtocolMessage(name, msg, messages)) {
          return null // shutdown
        }
      } else {
        nonProtocol.push(msg)
      }
    }
    return nonProtocol
  }

  /**
   * 处理单条协议消息
   * 返回 true 表示队友应该停止（仅 shutdown_request）
   */
  private handleProtocolMessage(
    name: string,
    msg: BusMessage,
    messages: { role: 'user' | 'assistant'; content: unknown }[],
  ): boolean {
    const reqId = msg.metadata?.request_id as string

    if (msg.type === 'shutdown_request') {
      // 教学版队友总是批准关闭（真实 CC 队友可以拒绝，比如活干到一半）
      this.bus.send(name, 'lead', 'Shutting down gracefully.', 'shutdown_response', {
        request_id: reqId,
        approve: true,
      })
      console.log(`  \x1b[35m[protocol] ${name} approved shutdown (${reqId})\x1b[0m`)
      return true
    }

    if (msg.type === 'plan_approval_response') {
      const approve = msg.metadata?.approve === true
      messages.push({
        role: 'user',
        content: approve
          ? '[Plan approved] Proceed with the task.'
          : `[Plan rejected] Feedback: ${msg.content}`,
      })
    }

    return false
  }

  // ==========================================================================
  // 共享工具执行器
  // ==========================================================================

  /** 执行一轮响应里的所有工具调用，返回 tool_result 块列表 */
  private async executeToolCalls(
    content: unknown,
    handlers: Record<string, ToolHandler>,
  ): Promise<ContentBlock[]> {
    const results: ContentBlock[] = []
    for (const block of content as { type: string; id: string; name: string; input: unknown }[]) {
      if (block.type !== 'tool_use') continue
      const handler = handlers[block.name]
      let output: string
      try {
        output = handler
          ? String(await handler(block.input as Record<string, unknown>))
          : `Unknown tool: ${block.name}`
      } catch (e) {
        output = `Error: ${(e as Error).message}`
      }
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: output,
      })
    }
    return results
  }

  /**
   * 队友的 bash：异步版本
   *
   * 为什么不能复用 core/tools.ts 的 runBash（execSync）？
   * Node.js 单线程：execSync 会阻塞整个事件循环，
   * 队友跑 "npm install" 时 Lead 的 REPL、queue processor 全部卡死。
   * Python 版队友在独立线程里跑，execSync 等价物只阻塞那个线程。
   */
  private runBash: ToolHandler = async (input) => {
    const command = input.command as string
    try {
      const shell = process.platform === 'win32' ? 'powershell.exe' : undefined
      const { stdout, stderr } = await execAsync(command, {
        cwd: WORKDIR,
        timeout: BASH_TIMEOUT,
        maxBuffer: 50 * 1024 * 1024,
        shell,
      })
      const out = (stdout + stderr).trim()
      return (out || '(no output)').slice(0, OUTPUT_LIMIT)
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      const out = ((err.stdout || '') + (err.stderr || '')).trim()
      return (out || `Error: ${err.message}`).slice(0, OUTPUT_LIMIT)
    }
  }

  /**
   * 从队友消息历史里提取最后的文本块作为总结
   * 对标原项目 summary 提取逻辑：倒序找第一个 assistant 的 text block
   */
  private extractSummary(messages: { role: 'user' | 'assistant'; content: unknown }[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          return block.text
        }
      }
    }
    return 'Done.'
  }
}

// ============================================================================
// Lead 的团队工具定义
// ============================================================================

export const TEAM_TOOLS: ToolDefinition[] = [
  {
    name: 'spawn_teammate',
    description: 'Spawn a teammate agent in the background.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Teammate name (unique identifier)' },
        role: { type: 'string', description: 'Teammate role (e.g. "test engineer")' },
        prompt: { type: 'string', description: 'Initial task for the teammate' },
      },
      required: ['name', 'role', 'prompt'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a teammate via MessageBus.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name' },
        content: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'check_inbox',
    description: "Check Lead's inbox for teammate messages.",
    input_schema: { type: 'object', properties: {} },
  },
]

// ============================================================================
// Lead 的团队工具 handlers
// ============================================================================

/**
 * 工厂函数：创建团队工具的 handlers
 * 和 createTaskHandlers / createCronHandlers 模式一致
 *
 * @param options.onSpawn 派生队友后的回调（session 用来启动 queue processor，
 *                        否则队友的 result 消息没有轮询者去拾取）
 */
export function createTeamHandlers(
  bus: MessageBus,
  teammateManager: TeammateManager,
  options: { onSpawn?: () => void } = {},
): Record<string, ToolHandler> {
  return {
    spawn_teammate: (input) => {
      const result = teammateManager.spawn(
        input.name as string,
        input.role as string,
        input.prompt as string,
      )
      // 队友开跑了，确保有轮询者盯着 lead 收件箱
      options.onSpawn?.()
      return result
    },

    send_message: (input) => {
      bus.send('lead', input.to as string, input.content as string)
      return `Sent to ${input.to}`
    },

    check_inbox: () => {
      const msgs = bus.readInbox('lead')
      if (msgs.length === 0) return '(inbox empty)'
      return msgs.map((m) => `  [${m.from}] ${m.content.slice(0, 200)}`).join('\n')
    },
  }
}
