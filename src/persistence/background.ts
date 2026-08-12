/**
 * s13 Background Tasks
 * 后台任务：慢操作丢到子进程执行，Agent 继续处理其他事情
 *
 * 对标原项目 s13_background_tasks/code.py
 * 差异：原项目用 Python threading.Thread，我们用 child_process.spawn（进程级隔离）
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { WORKDIR } from '../core/agent-loop'

// ============================================================================
// 数据结构
// ============================================================================

/** 后台任务状态 */
export interface BackgroundTask {
  id: string // "bg_0001"
  toolName: string // "bash"
  command: string // "npm install"
  status: 'running' | 'completed'
  startedAt: number // 启动时间戳
  process: ChildProcess | null // 子进程引用（可 kill）
}

// ============================================================================
// 常量
// ============================================================================

/**
 * 慢操作关键词（启发式兜底用）
 * 注意：不要用裸 "test"——PowerShell 的 Test-Path / -Test 会误判成后台任务，
 * 导致普通命令被异步执行、结果走通知通道。用更精确的命令级匹配。
 */
const SLOW_KEYWORDS = [
  'install',
  'build',
  'deploy',
  'compile',
  'docker',
  'pip',
  'npm',
  'pnpm',
  'yarn',
  'cargo',
  'pytest',
  'npm test',
  'pnpm test',
  'yarn test',
  'make',
]

/** bash 命令超时（毫秒） */
const BASH_TIMEOUT = 120_000

/** 输出截断上限（字符数） */
const OUTPUT_LIMIT = 50_000

/** 通知摘要截断长度 */
const SUMMARY_LIMIT = 200

// ============================================================================
// BackgroundManager
// ============================================================================

export class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map()
  private results: Map<string, string> = new Map()
  private counter = 0

  /**
   * 判断是否应该后台执行
   * 策略：显式请求优先（run_in_background=true），启发式关键词兜底
   */
  shouldRunBackground(toolName: string, toolInput: Record<string, unknown>): boolean {
    // 第一层：模型显式请求
    if (toolInput.run_in_background === true) {
      return true
    }

    // 第二层：启发式兜底（只判断 bash 工具）
    if (toolName !== 'bash') {
      return false
    }
    const cmd = (toolInput.command as string).toLowerCase()
    return this.isSlowCommand(cmd)
  }

  /**
   * 命令是否以慢操作关键词开头（启发式兜底）
   *
   * 为什么不能子串匹配？命令里可能夹着路径/文件名：
   *   "cd /d D:\\myCode\\build-claude-code && git log --oneline -20 2>nul"
   *   → includes("build") 误命中路径 build-claude-code → git log 被当成后台任务
   *
   * 正确做法：先按命令分隔符（&& || ; | 换行 (）拆成子命令片段，
   * 关键词必须出现在片段开头（前面只能是空白）——"以 build 开头的命令"才算慢操作，
   * "路径里含 build"不算。片段开头也保证了 cd xxx && npm install 这类复合命令
   * 第二段仍能正确命中。
   */
  private isSlowCommand(cmd: string): boolean {
    const segments = cmd.split(/&&|\|\||;|\||\n|\(/)
    for (const segment of segments) {
      const trimmed = segment.trimStart()
      for (const kw of SLOW_KEYWORDS) {
        if (!trimmed.startsWith(kw)) continue
        // 关键词后必须是空白/斜杠/行尾，防止 "build-claude-code" 误配 "build"
        const rest = trimmed.slice(kw.length)
        if (rest === '' || /^[\s/\\]/.test(rest)) {
          return true
        }
      }
    }
    return false
  }

  /**
   * 启动后台任务
   * spawn 子进程执行 bash 命令，主循环不阻塞
   * 返回 bg_id 用于追踪
   */
  startTask(toolName: string, toolInput: Record<string, unknown>): string {
    const bgId = `bg_${String(++this.counter).padStart(4, '0')}` // 0001
    const command = (toolInput.command as string) || toolName

    // 记录任务
    this.tasks.set(bgId, {
      id: bgId,
      toolName,
      command,
      status: 'running',
      startedAt: Date.now(),
      process: null,
    })

    // spawn 子进程
    // Windows 用 cmd.exe，其他平台用 sh
    const shellCommand = process.platform === 'win32' ? 'cmd' : 'sh'
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command]

    const child = spawn(shellCommand, shellArgs, {
      cwd: WORKDIR,
      timeout: BASH_TIMEOUT,
    })

    // 保存进程引用
    this.tasks.get(bgId)!.process = child

    // 收集输出
    let output = ''
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString()
    })

    // 完成时标记状态
    child.on('close', () => {
      const task = this.tasks.get(bgId)
      if (task) {
        task.status = 'completed'
        task.process = null
        this.results.set(bgId, output.slice(0, OUTPUT_LIMIT) || '(no output)')
        console.log(
          `\x1b[32m[background done] ${bgId}: ${command.slice(0, 40)} (${output.length} chars)\x1b[0m`,
        )
      }
    })

    // 错误处理
    child.on('error', (err: Error) => {
      const task = this.tasks.get(bgId)
      if (task) {
        task.status = 'completed'
        task.process = null
        this.results.set(bgId, `Error: ${err.message}`)
      }
    })

    console.log(`\x1b[33m[background] dispatched ${bgId}: ${command.slice(0, 40)}\x1b[0m`)
    return bgId
  }

  /**
   * 收集已完成的后台任务通知
   * 格式化为 <task_notification>，清理已完成的任务
   */
  collectResults(): string[] {
    const notifications: string[] = []

    for (const [bgId, task] of this.tasks) {
      if (task.status !== 'completed') continue

      const output = this.results.get(bgId) || ''
      const summary = output.length > SUMMARY_LIMIT ? output.slice(0, SUMMARY_LIMIT) : output

      notifications.push(`
        <task_notification>
          <task_id>${bgId}</task_id>
          <status>completed</status>
          <command>${task.command}</command>
          <summary>${summary}</summary>
        </task_notification>
      `)

      // 清理已完成的任务和结果
      this.tasks.delete(bgId)
      this.results.delete(bgId)
    }

    return notifications
  }

  /**
   * 是否有已完成的后台任务（queue processor 用）
   */
  hasCompleted(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'completed') return true
    }
    return false
  }

  /**
   * 列出所有运行中的后台任务
   */
  listRunning(): BackgroundTask[] {
    return [...this.tasks.values()].filter((t) => t.status === 'running')
  }
}
