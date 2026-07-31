/**
 * s16 Team Protocols - 请求-响应协议状态机
 * Lead 和队友之间的结构化交互：shutdown 关闭协议 + plan_approval 计划审批协议
 *
 * 对标原项目 s16_team_protocols/code.py 的 ProtocolState + pending_requests +
 * match_response + consume_lead_inbox + Lead 协议工具
 *
 * 核心思想：
 *   s15 的消息是"喊话"——发出去就完了，不知道对方收没收到、同不同意。
 *   s16 的协议是"握手"——每个请求带 request_id，响应必须带同一个 id，
 *   通过 pending_requests 状态机追踪 pending → approved/rejected 的流转。
 *
 * ASCII 流程：
 *   Lead: bus.send("shutdown_request", {request_id}) ──────→ teammate 收件箱
 *   Teammate: dispatch → bus.send("shutdown_response", {request_id, approve}) ─→ Lead 收件箱
 *   Lead: consumeLeadInbox → matchResponse(request_id) → pending[rid].status = approved
 */

import type { MessageBus, BusMessage } from './message-bus'
import type { ToolDefinition, ToolHandler } from '../core/types'

// ============================================================================
// 数据结构
// ============================================================================

/** 协议类型：shutdown=关闭协议，plan_approval=计划审批协议 */
export type ProtocolType = 'shutdown' | 'plan_approval'

/** 协议状态：pending=等待响应，approved/rejected=已终态 */
export type ProtocolStatus = 'pending' | 'approved' | 'rejected'

/**
 * 一个在途协议请求
 *
 * 为什么需要这个结构？邮箱消息是"过路"的——读完就删。
 * 但协议请求需要活到响应回来为止，所以要一个注册表追踪在途请求。
 *
 * 注意两个方向的请求都进同一个注册表：
 *   Lead → teammate: shutdown 协议（Lead 发起，teammate 响应）
 *   teammate → Lead: plan_approval 协议（teammate 发起，Lead 响应）
 */
export interface ProtocolState {
  requestId: string // "req_XXXXXX"，关联请求和响应的唯一标识
  type: ProtocolType
  sender: string // 发起方
  target: string // 接收方
  status: ProtocolStatus
  payload: string // 计划文本 或 关闭原因
  createdAt: number // 创建时间戳（秒）
}

// ============================================================================
// ProtocolManager
// ============================================================================

/**
 * 协议管理器：pending_requests 注册表 + 响应匹配状态机
 *
 * 对标原项目的 pending_requests 全局字典 + match_response 函数。
 * 用类封装，和 TeammateManager / CronManager 风格一致。
 */
export class ProtocolManager {
  private pending: Map<string, ProtocolState> = new Map()

  /** 生成请求 ID：req_{6位随机数} */
  newRequestId(): string {
    return `req_${Math.floor(Math.random() * 1000000)
      .toString()
      .padStart(6, '0')}`
  }

  /**
   * 注册一个新协议请求（状态 pending），返回完整状态
   * 双方都用：Lead 发 shutdown_request 前注册，teammate submit_plan 前注册
   */
  createRequest(
    type: ProtocolType,
    sender: string,
    target: string,
    payload: string,
  ): ProtocolState {
    const state: ProtocolState = {
      requestId: this.newRequestId(),
      type,
      sender,
      target,
      status: 'pending',
      payload,
      createdAt: Date.now() / 1000,
    }
    this.pending.set(state.requestId, state)
    return state
  }

  /** 查询请求（review_plan 工具用） */
  get(requestId: string): ProtocolState | undefined {
    return this.pending.get(requestId)
  }

  /** 列出所有在途请求（/status 用） */
  listAll(): ProtocolState[] {
    return [...this.pending.values()]
  }

  /**
   * 响应匹配：把收到的响应关联回原始请求
   *
   * 三层校验（顺序不能乱）：
   *   1. request_id 必须已注册——否则是孤儿响应（可能来自上一轮会话）
   *   2. 响应类型必须匹配请求类型——shutdown 的响应不能去关掉 plan_approval 的请求
   *   3. 状态必须还是 pending——重复响应直接忽略（邮箱可能重投）
   *
   * 返回更新后的状态，校验失败返回 null
   */
  matchResponse(responseType: string, requestId: string, approve: boolean): ProtocolState | null {
    const state = this.pending.get(requestId)
    if (!state) {
      console.log(`  \x1b[31m[protocol] unknown request_id: ${requestId}\x1b[0m`)
      return null
    }

    // 类型校验：每种请求只认自己的响应类型
    const expected = state.type === 'shutdown' ? 'shutdown_response' : 'plan_approval_response'
    if (responseType !== expected) {
      console.log(
        `  \x1b[31m[protocol] type mismatch: expected ${expected}, got ${responseType}\x1b[0m`,
      )
      return null
    }

    // 幂等：已终态的请求忽略重复响应
    if (state.status !== 'pending') {
      console.log(
        `  \x1b[33m[protocol] ${requestId} already ${state.status}, ignoring duplicate\x1b[0m`,
      )
      return state
    }

    state.status = approve ? 'approved' : 'rejected'
    const icon = approve ? '✓' : '✗'
    const color = approve ? '32' : '31'
    console.log(
      `  \x1b[${color}m[protocol] ${state.type} ${icon} (${requestId}: ${state.status})\x1b[0m`,
    )
    return state
  }
}

// ============================================================================
// 统一的 Lead 收件箱消费
// ============================================================================

/** 判断消息是否是协议响应（需要路由进状态机的） */
function isProtocolResponse(msg: BusMessage): boolean {
  const reqId = msg.metadata?.request_id as string | undefined
  return Boolean(reqId) && msg.type.endsWith('_response')
}

/**
 * 统一消费 Lead 收件箱：读信 + 协议路由
 *
 * 为什么需要这个函数？Lead 有两个收信入口：
 *   1. check_inbox 工具（模型主动调用）
 *   2. queue processor 唤醒后的 runAgentTurn（被动注入）
 * 如果只有一个入口做协议路由，另一个入口读信时会把协议响应
 * 当普通消息吞掉——request_id 永远停在 pending。
 * 所以两个入口都必须走这个函数（对标原项目 consume_lead_inbox 的注释）。
 */
export function consumeLeadInbox(bus: MessageBus, protocolManager: ProtocolManager): BusMessage[] {
  const msgs = bus.readInbox('lead')
  for (const msg of msgs) {
    if (isProtocolResponse(msg)) {
      const reqId = msg.metadata!.request_id as string
      const approve = msg.metadata!.approve === true
      protocolManager.matchResponse(msg.type, reqId, approve)
    }
  }
  return msgs
}

// ============================================================================
// Lead 的协议工具定义
// ============================================================================

export const PROTOCOL_TOOLS: ToolDefinition[] = [
  {
    name: 'request_shutdown',
    description: 'Request a teammate to shut down gracefully.',
    input_schema: {
      type: 'object',
      properties: {
        teammate: { type: 'string', description: 'Teammate name to shut down' },
      },
      required: ['teammate'],
    },
  },
  {
    name: 'request_plan',
    description: 'Ask a teammate to submit a plan for review.',
    input_schema: {
      type: 'object',
      properties: {
        teammate: { type: 'string', description: 'Teammate name' },
        task: { type: 'string', description: 'Task to plan for' },
      },
      required: ['teammate', 'task'],
    },
  },
  {
    name: 'review_plan',
    description: 'Approve or reject a submitted plan by request_id.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'The plan request ID' },
        approve: { type: 'boolean', description: 'True=approve, False=reject' },
        feedback: { type: 'string', description: 'Optional feedback (especially for rejection)' },
      },
      required: ['request_id', 'approve'],
    },
  },
]

// ============================================================================
// Lead 的协议工具 handlers
// ============================================================================

/** 工厂函数：创建协议工具的 handlers，和 createTeamHandlers 模式一致 */
export function createProtocolHandlers(
  bus: MessageBus,
  protocolManager: ProtocolManager,
): Record<string, ToolHandler> {
  return {
    // Lead 发起关闭协议：注册请求 → 发 shutdown_request → 等队友响应
    request_shutdown: (input) => {
      const teammate = input.teammate as string
      const state = protocolManager.createRequest('shutdown', 'lead', teammate, '')
      bus.send('lead', teammate, 'Please shut down gracefully.', 'shutdown_request', {
        request_id: state.requestId,
      })
      console.log(`  \x1b[35m[protocol] shutdown_request → ${teammate} (${state.requestId})\x1b[0m`)
      return `Shutdown request sent to ${teammate} (req: ${state.requestId})`
    },

    // Lead 要求队友交计划：只是条普通消息，协议由队友的 submit_plan 发起
    request_plan: (input) => {
      const teammate = input.teammate as string
      const task = input.task as string
      bus.send('lead', teammate, `Please submit a plan for: ${task}`)
      return `Asked ${teammate} to submit a plan`
    },

    // Lead 审批计划：校验状态 → 更新状态 → 回 plan_approval_response
    review_plan: (input) => {
      const requestId = input.request_id as string
      const approve = input.approve as boolean
      const feedback = (input.feedback as string) || ''

      const state = protocolManager.get(requestId)
      if (!state) return `Request ${requestId} not found`
      if (state.status !== 'pending') return `Request ${requestId} already ${state.status}`

      state.status = approve ? 'approved' : 'rejected'
      bus.send(
        'lead',
        state.sender,
        feedback || (approve ? 'Approved' : 'Rejected'),
        'plan_approval_response',
        { request_id: requestId, approve },
      )
      const icon = approve ? '✓' : '✗'
      console.log(`  \x1b[32m[protocol] plan ${icon} (${requestId})\x1b[0m`)
      return `Plan ${approve ? 'approved' : 'rejected'} (${requestId})`
    },
  }
}
