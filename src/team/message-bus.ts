/**
 * s15 Agent Teams - MessageBus
 * 文件邮箱消息总线：每个 Agent 一个 .mailboxes/{name}.jsonl 收件箱
 *
 * 对标原项目 s15_agent_teams/code.py 的 MessageBus 类
 * 教学版用简单的文件追加 + 读删；真实 Claude Code 用 proper-lockfile 做并发写安全
 */

import fs from 'node:fs'
import path from 'node:path'
import { WORKDIR } from '../core/agent-loop'

// ============================================================================
// 数据结构
// ============================================================================

/**
 * 一条总线消息
 *
 * 为什么需要 type？区分普通消息和结果汇报：
 *   message: Agent 之间的普通通信（lead 派活、teammate 提问）
 *   result:  teammate 完成后的最终总结（teammate → lead）
 */
export interface BusMessage {
  from: string // 发送方 agent 名
  to: string // 接收方 agent 名
  content: string // 消息内容
  type: string // "message" | "result"
  ts: number // 发送时间戳（秒）
}

// ============================================================================
// 常量
// ============================================================================

const MAILBOX_DIR = path.join(WORKDIR, '.mailboxes')

/** 打印时内容截断长度 */
const PRINT_LIMIT = 50

// ============================================================================
// MessageBus
// ============================================================================

/**
 * 文件邮箱消息总线
 *
 * 核心设计：用文件系统做进程内（甚至跨进程）的异步通信。
 * 每个 Agent 一个 {name}.jsonl 收件箱，一行一条消息。
 *
 * 三个操作各司其职：
 *   send:      追加一行 JSON（发信）
 *   readInbox: 读全部 + 删文件（收信，消费式）
 *   peek:      只看有没有（queue processor 的唤醒条件，非破坏性）
 *
 * 为什么 read 是破坏性的（读完就删）？
 * 消息是"事件"不是"状态"——处理过就不该再处理第二次。
 * 删除即确认消费，避免同一条消息被重复注入 Agent 上下文。
 */
export class MessageBus {
  private dir: string

  constructor(mailboxDir: string = MAILBOX_DIR) {
    this.dir = mailboxDir
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /** 收件箱文件路径 */
  private inboxPath(agent: string): string {
    return path.join(this.dir, `${agent}.jsonl`)
  }

  /**
   * 发信：追加一行 JSON 到接收方收件箱
   * append 是原子的（单行小消息），教学版不加锁
   */
  send(from: string, to: string, content: string, type: string = 'message'): void {
    const msg: BusMessage = { from, to, content, type, ts: Date.now() / 1000 }
    fs.appendFileSync(this.inboxPath(to), JSON.stringify(msg) + '\n', 'utf-8')
    console.log(`  \x1b[33m[bus] ${from} → ${to}: ${content.slice(0, PRINT_LIMIT)}\x1b[0m`)
  }

  /**
   * 收信：读全部消息然后删除文件（消费式读取）
   * 对标原项目 read_text + unlink
   */
  readInbox(agent: string): BusMessage[] {
    const inbox = this.inboxPath(agent)
    if (!fs.existsSync(inbox)) return []

    const msgs: BusMessage[] = []
    for (const line of fs.readFileSync(inbox, 'utf-8').split('\n')) {
      if (line.trim()) {
        try {
          msgs.push(JSON.parse(line) as BusMessage)
        } catch {
          // 跳过损坏的行（如并发写导致的半行）
        }
      }
    }

    fs.unlinkSync(inbox) // 消费：读 + 删
    return msgs
  }

  /**
   * 偷看：有没有未读消息（非破坏性）
   * Lead 的 queue processor 用它做唤醒条件——只看不取，
   * 真正的读取由 runAgentTurn 统一做，避免消息在轮询时被吞掉。
   */
  peek(agent: string): boolean {
    const inbox = this.inboxPath(agent)
    return fs.existsSync(inbox) && fs.statSync(inbox).size > 0
  }
}
