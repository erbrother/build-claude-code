/**
 * s18 Worktree Isolation - git worktree 隔离
 * 每个任务一个独立的 git worktree + 专属分支，互不干扰
 *
 * 对标原项目 s18_worktree_isolation/code.py 的 validate_worktree_name +
 * create_worktree + bind_task_to_worktree + remove_worktree + keep_worktree
 * 差异：Node.js 用异步 exec 跑 git，类封装与 WorktreeEntry 事件日志对齐 types.ts
 *
 * ASCII 拓扑：
 *   Main repo (/)
 *     ├── .worktrees/auth/  (branch: wt/auth)  ← Task #1
 *     ├── .worktrees/ui/    (branch: wt/ui)     ← Task #2
 *     ├── .tasks/task_xxx.json (worktree: "auth")
 *     └── .worktrees/events.jsonl
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { WORKDIR } from '../core/agent-loop'
import type { TaskManager } from '../persistence/task-manager'
import type { LifecycleEvent, ToolDefinition, ToolHandler } from '../core/types'

const execAsync = promisify(exec)

// ============================================================================
// 常量
// ============================================================================

const WORKTREES_DIR = path.join(WORKDIR, '.worktrees')

export { WORKTREES_DIR }

/** git 命令超时（毫秒） */
const GIT_TIMEOUT = 30_000

/** git 输出截断（字符数） */
const GIT_OUTPUT_LIMIT = 5_000

/** worktree 名称校验：字母/数字/点/下划线/短横线，1-64 字符 */
const VALID_NAME = /^[A-Za-z0-9._-]{1,64}$/

/** 事件日志文件 */
const EVENTS_FILE = path.join(WORKTREES_DIR, 'events.jsonl')

// ============================================================================
// 校验与工具函数
// ============================================================================

/**
 * 校验 worktree 名称，返回错误信息或 null（合法）
 *
 * 为什么必须校验？worktree 名称会拼进文件系统路径和分支名：
 *   - 路径穿越：name="../../etc" 会把文件建到仓库外
 *   - 分支名注入：name="foo; rm -rf" 会拼进 git 命令
 * 白名单字符 + 长度限制同时防住这两种攻击
 */
export function validateWorktreeName(name: string): string | null {
  if (!name) return 'Worktree name cannot be empty'
  if (name === '.' || name === '..') return `'${name}' is not a valid worktree name`
  if (!VALID_NAME.test(name)) {
    return `Invalid worktree name '${name}': only letters, digits, dots, underscores, dashes (1-64 chars)`
  }
  return null
}

/** 在指定 base 下安全解析相对路径（worktree 内文件操作的路径校验） */
export function worktreeSafePath(base: string, relativePath: string): string {
  const resolved = path.resolve(base, relativePath)
  if (!resolved.startsWith(base)) {
    throw new Error(`Path escapes workspace: ${relativePath}`)
  }
  return resolved
}

// ============================================================================
// WorktreeManager
// ============================================================================

/**
 * worktree 管理器
 *
 * 生命周期事件全部记录到 .worktrees/events.jsonl（LifecycleEvent）：
 *   create → worktree 诞生
 *   remove → worktree 删除（分支也删）
 *   keep   → 保留供人工审查（分支保留）
 */
export class WorktreeManager {
  private dir: string

  constructor(worktreesDir: string = WORKTREES_DIR) {
    this.dir = worktreesDir
    fs.mkdirSync(this.dir, { recursive: true })
  }

  /** worktree 的目录路径 */
  private worktreePath(name: string): string {
    return path.join(this.dir, name)
  }

  /**
   * 跑 git 命令，返回 (ok, output)
   * 只记录成功事件——失败时调用方直接返回错误，不污染事件日志
   */
  private async runGit(args: string | string[], cwd?: string): Promise<[boolean, string]> {
    const argStr = Array.isArray(args) ? args.join(' ') : args
    try {
      const { stdout, stderr } = await execAsync(`git ${argStr}`, {
        cwd: cwd ?? WORKDIR,
        timeout: GIT_TIMEOUT,
        maxBuffer: 10 * 1024 * 1024,
      })
      const out = (stdout + stderr).trim() || '(no output)'
      return [true, out.slice(0, GIT_OUTPUT_LIMIT)]
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string; code?: number }
      const out = ((err.stdout || '') + (err.stderr || '')).trim()
      return [false, (out || `Error: ${err.message}`).slice(0, GIT_OUTPUT_LIMIT)]
    }
  }

  /** 追加一条生命周期事件 */
  private logEvent(type: string, worktreeName: string, taskId: string = ''): void {
    const event: LifecycleEvent = {
      event: type,
      ts: Date.now(),
      task: taskId ? { id: taskId } : undefined,
      worktree: { name: worktreeName },
    }
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf-8')
  }

  /**
   * 创建 worktree：校验名称 → git worktree add → 可选绑定任务 → 记事件
   * 分支名固定为 wt/{name}，指向当前 HEAD
   */
  async create(name: string, taskId: string = '', taskManager?: TaskManager): Promise<string> {
    const err = validateWorktreeName(name)
    if (err) return `Error: ${err}`

    const wtPath = this.worktreePath(name)
    if (fs.existsSync(wtPath)) {
      return `Worktree '${name}' already exists at ${wtPath}`
    }

    const [ok, result] = await this.runGit(
      `worktree add ${JSON.stringify(wtPath)} -b wt/${name} HEAD`,
    )
    if (!ok) return `Git error: ${result}`

    // 可选绑定：给任务写 worktree 字段（保持 pending，等队友自动认领）
    if (taskId && taskManager) {
      await taskManager.bindWorktree(taskId, name)
    }

    this.logEvent('create', name, taskId)
    console.log(`  \x1b[33m[worktree] created: ${name} at ${wtPath}\x1b[0m`)
    return `Worktree '${name}' created at ${wtPath}`
  }

  /**
   * 删除 worktree
   * 安全检查：未提交的改动/未推送的提交存在时拒绝删除，除非 discard_changes=true
   *
   * 两道防线：
   *   1. countChanges 主动检查未提交文件 + 未推送提交（可给出具体数量）
   *   2. discardChanges=false 时 git worktree remove 不加 --force——
   *      即使上面统计有遗漏，git 原生也会拦截 modified/untracked 文件
   * 而 discardChanges=true 时先打印将被丢弃内容的警告，再强制删除
   */
  async remove(name: string, discardChanges: boolean = false): Promise<string> {
    const err = validateWorktreeName(name)
    if (err) return `Error: ${err}`

    const wtPath = this.worktreePath(name)
    if (!fs.existsSync(wtPath)) {
      // 目录不存在：可能是残留元数据（worktree 目录被手动删过）。
      // 先 git worktree prune 清理注册表；清理后仍不存在才是真 not found
      await this.runGit('worktree prune')
      if (!fs.existsSync(wtPath)) {
        return `Worktree '${name}' not found`
      }
    }

    if (!discardChanges) {
      const [files, commits] = await this.countChanges(wtPath)
      if (files < 0) {
        return (
          `Cannot verify worktree '${name}' status. ` + 'Use discard_changes=true to force removal.'
        )
      }
      if (files > 0 || commits > 0) {
        return (
          `Worktree '${name}' has ${files} uncommitted file(s) and ${commits} unpushed commit(s). ` +
          'Use discard_changes=true to force removal, or keep_worktree to preserve for review.'
        )
      }
    } else {
      // 显式丢弃：先列出将被丢弃的内容，提醒用户这是不可逆操作
      const [files, commits] = await this.countChanges(wtPath)
      if (files > 0 || commits > 0) {
        console.log(
          `  \x1b[31m[worktree] WARNING: '${name}' has ${files} uncommitted file(s) and ` +
            `${commits} unpushed commit(s). Removing will DISCARD them.\x1b[0m`,
        )
      }
    }

    // discardChanges=false 不加 --force：git 原生拦截未提交改动，兜底防误删
    const force = discardChanges ? '--force' : ''
    const [ok1, out1] = await this.runGit(
      `worktree remove ${JSON.stringify(wtPath)} ${force}`.trim(),
    )
    if (!ok1) return `Refusing to remove: ${out1}`

    // 删除专属分支（-D 强制：分支已被 worktree 清空引用）
    await this.runGit(`branch -D wt/${name}`)
    this.logEvent('remove', name)
    console.log(`  \x1b[33m[worktree] removed: ${name}\x1b[0m`)
    return `Worktree '${name}' removed`
  }

  /**
   * 保留 worktree 供人工审查：只记事件，分支保留
   */
  async keep(name: string): Promise<string> {
    const err = validateWorktreeName(name)
    if (err) return `Error: ${err}`

    this.logEvent('keep', name)
    console.log(`  \x1b[36m[worktree] kept: ${name}\x1b[0m`)
    return `Worktree '${name}' kept for review (branch: wt/${name})`
  }

  /**
   * 统计 worktree 的未提交文件数 + 未推送提交数
   * git 命令失败返回 (-1, -1)——"无法验证"，安全起见拒绝删除
   *
   * 为什么不用 `git log @{push}..HEAD`？
   * 新 worktree 的分支 wt/{name} 从未 push，没有 upstream，`@{push}` 解析会
   * fatal 报错，countChanges 永远返回 (-1,-1)，导致任何删除都被拒，调用方
   * 只能被迫 discard_changes=true，未提交改动被静默丢弃。
   * 修复：有 upstream 用 @{u}..HEAD；没有则回退 origin/main..HEAD（worktree 创建基准）。
   */
  private async countChanges(wtPath: string): Promise<[number, number]> {
    try {
      const [ok1, out1] = await this.runGit('status --porcelain', wtPath)
      if (!ok1) return [-1, -1]
      const files = this.countLines(out1)

      // 未推送提交：优先相对 upstream；新分支无 upstream 时回退 origin/main
      const [hasUpstream] = await this.runGit(
        'rev-parse --abbrev-ref --symbolic-full-name @{u}',
        wtPath,
      )
      const base = hasUpstream ? '@{u}' : 'origin/main'
      const [ok2, out2] = await this.runGit(`log --oneline ${base}..HEAD`, wtPath)
      if (!ok2) return [-1, -1]
      const commits = this.countLines(out2)
      return [files, commits]
    } catch {
      return [-1, -1]
    }
  }

  /**
   * 统计 git 输出行数
   * runGit 会把空输出替换成 '(no output)' 字符串，直接 split 会把干净的
   * worktree 误报成 1 个未提交文件，这里需要还原成 0
   */
  private countLines(out: string): number {
    if (!out || out === '(no output)') return 0
    return out.split('\n').filter((l) => l.trim()).length
  }

  /** 列出所有 worktree（目录名 + 路径 + 分支） */
  async list(): Promise<{ name: string; path: string; branch: string }[]> {
    const entries = fs.readdirSync(this.dir, { withFileTypes: true })
    const result = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue // 跳过 events.jsonl 等文件
      result.push({
        name: entry.name,
        path: path.join(this.dir, entry.name),
        branch: `wt/${entry.name}`,
      })
    }
    return result
  }
}

// ============================================================================
// Lead 的 worktree 工具定义
// ============================================================================

export const WORKTREE_TOOLS: ToolDefinition[] = [
  {
    name: 'create_worktree',
    description: 'Create an isolated git worktree with its own branch. Optionally bind to a task.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Worktree name: letters, digits, dots, underscores, dashes (1-64 chars)',
        },
        task_id: { type: 'string', description: 'Optional task ID to bind this worktree to' },
      },
      required: ['name'],
    },
  },
  {
    name: 'remove_worktree',
    description: 'Remove a worktree. Refuses if uncommitted changes unless discard_changes=true.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worktree name to remove' },
        discard_changes: {
          type: 'boolean',
          description: 'True=force removal even with uncommitted changes (default false)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'keep_worktree',
    description: 'Keep a worktree for manual review (branch preserved).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Worktree name to keep' },
      },
      required: ['name'],
    },
  },
]

// ============================================================================
// Lead 的 worktree 工具 handlers
// ============================================================================

/** 工厂函数：创建 worktree 工具的 handlers，和 createTeamHandlers 模式一致 */
export function createWorktreeHandlers(
  worktreeManager: WorktreeManager,
  taskManager: TaskManager,
): Record<string, ToolHandler> {
  return {
    create_worktree: async (input) => {
      return worktreeManager.create(
        input.name as string,
        (input.task_id as string) || '',
        taskManager,
      )
    },

    remove_worktree: async (input) => {
      return worktreeManager.remove(input.name as string, input.discard_changes === true)
    },

    keep_worktree: async (input) => {
      return worktreeManager.keep(input.name as string)
    },
  }
}
