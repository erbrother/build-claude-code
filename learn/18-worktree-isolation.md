# 18 - Worktree Isolation

## 学习目标

- 理解工作树隔离要解决的核心问题：多个队友同时改同一个仓库会互相踩踏
- 理解 git worktree — 同一仓库多个工作目录，各占一个分支，互不干扰
- 理解 `validateWorktreeName` — 白名单字符校验，同时防路径穿越和命令注入
- 理解 `WorktreeManager` — create / remove / keep 三个操作 + 事件日志
- 理解任务-工作树绑定 — 只写 worktree 字段保持 pending，等队友自动认领
- 理解队友的 cwd 切换 — 认领带 worktree 的任务后，bash/read/write 自动切目录
- 理解 `remove_worktree` 的安全检查 — 有未提交改动时拒绝删除
- 理解 `countChanges` 的 (-1,-1) 语义 — 无法验证时按"最安全"处理
- 实现 3 个新工具：create_worktree / remove_worktree / keep_worktree

## 核心概念

### 问题背景

s17 的队友能自主抢活了，但所有队友都在**同一个工作目录**里干活：

```text
用户："三个队友分别改三个模块"

真实 Claude Code（有 worktree isolation）：
  Lead 为每个任务建独立 worktree → 队友各改各的目录
  → 互不可见、互不干扰，分支隔离，合并时逐个 review

我们的项目（s17，没有隔离）：
  队友 A 和队友 B 同时写 src/a.ts → 互相覆盖
  → A 的改动被 B 的 write_file 悄悄冲掉 → 数据丢失
```

更隐蔽的问题：**上下文污染**——队友 A 的 `list_tasks`、`read_file` 会把整个仓库的状态混在一起，一个队友的错误提交会污染所有人的视野。

### git worktree：一个仓库，多个工作目录

```bash
git worktree add .worktrees/auth -b wt/auth HEAD
# 在 .worktrees/auth/ 里，checkout 的是分支 wt/auth（从当前 HEAD 分出）
```

```text
Main repo (/)            ── 分支 main
  ├── src/a.ts
  ├── .worktrees/auth/   ── 分支 wt/auth   ← Task #1 在这里改
  │     └── src/a.ts     （独立的文件副本，改这里不影响主仓库的 src/a.ts）
  ├── .worktrees/ui/     ── 分支 wt/ui     ← Task #2 在这里改
  ├── .tasks/task_1.json    (worktree: "auth")
  └── .worktrees/events.jsonl
```

要点：worktree **不是拷贝**——它共享同一个 `.git` 对象库，只是 checkout 到不同分支、占用不同目录。提交、分支操作都在各自的分支上进行，互不可见。

### 为什么绑定后任务要保持 pending？

`bind_task_to_worktree` 只写任务的 `worktree` 字段，**不改变状态**：

```typescript
task.worktree = worktreeName // 只加这个
// status 还是 pending，owner 还是 null
```

因为绑定发生在认领之前：worktree 先建好，任务留在板上等队友自动认领（s17）。队友认领时读任务的 worktree 字段，才知道该切到哪个目录。如果绑定就把任务设成 in_progress，autonomous 的扫描逻辑就永远看不到它了。

### 队友的 cwd 切换：认领即切目录

队友维护一个 `wtCwd` 状态（初始 null = 主仓库）：

| 时机                                   | 动作                           |
| -------------------------------------- | ------------------------------ |
| `claim_task` 成功且任务绑定了 worktree | `wtCwd = .worktrees/{name}`    |
| `claim_task` 成功但没绑定              | `wtCwd = null`                 |
| `complete_task`                        | `wtCwd = null`（干完回主仓库） |
| IDLE 自动认领带 worktree 的任务        | 同 claim_task，通过返回值设置  |

```typescript
// bash 在 worktree 目录里执行
bash: async (input) => this.runBashIn(input, wtCwd ?? undefined)

// read/write 的相对路径映射到 worktree 目录（并做路径越界校验）
read_file: runRead({ ...input, path: this.wtPath(input.path, wtCwd) })
```

**为什么 IDLE 自动认领要走返回值传递？** idlePoll 内部没有 wtCwd 的引用（它在 runAutonomous 的外层作用域），所以 idlePoll 返回 `{ result, claimedTaskId }`，由外层根据认领的任务重新查 worktree 字段并设置。Python 原版也是这个模式（`idle_poll` 返回 `(result, claimed_task_id)`）。

### remove_worktree 的安全检查

删除 worktree 会**永久丢失**未提交的改动，所以默认拒绝：

```typescript
if (!discard_changes) {
  const [files, commits] = await countChanges(wtPath)
  if (files > 0 || commits > 0) {
    return `Worktree '${name}' has ${files} uncommitted file(s)... 拒绝删除`
  }
}
```

`countChanges` 失败返回 `(-1, -1)`——**"无法验证"不是"没有改动"**，安全起见按最坏情况处理：拒绝删除，提示用 `discard_changes=true` 强制。

### 名称校验：一个正则同时防两类攻击

worktree 名称会拼进文件系统路径和 git 命令：

```typescript
const VALID_NAME = /^[A-Za-z0-9._-]{1,64}$/

// 路径穿越：worktree add .worktrees/../../etc -b ...
// 命令注入：branch -D wt/foo; rm -rf /
```

白名单正则同时防住两者：只允许字母/数字/点/下划线/短横线，且最多 64 字符。另外 `.` 和 `..` 单独拒绝（正则其实不匹配它们，显式检查更清晰）。

## 实现

### src/team/worktree.ts（新增）

```typescript
validateWorktreeName(name): string | null  // 白名单校验

class WorktreeManager {
  create(name, taskId?, taskManager?)  // 校验 → git worktree add → 可选绑定 → 记事件
  remove(name, discardChanges?)        // 安全检查 → worktree remove --force → 删分支 → 记事件
  keep(name)                           // 只记事件，分支保留
  list()                               // 目录名/路径/分支
  // 私有: runGit（返回 [ok, output]）、countChanges（返回 [-1,-1] 或 [files, commits]）、
  //       logEvent（追加 .worktrees/events.jsonl）
}

WORKTREE_TOOLS = [create_worktree, remove_worktree, keep_worktree]
createWorktreeHandlers(worktreeManager, taskManager)
```

### src/persistence/task-manager.ts（增量）

```typescript
interface Task { ...; worktree?: string }  // types.ts 加字段（可选，旧 JSON 兼容）

bindWorktree(taskId, worktreeName) {
  // 只写 worktree 字段 + updatedAt，保持 pending 等自动认领
}
// renderList 输出加 (wt:{name}) 标记
```

### src/team/teammate.ts（增量）

autonomous 模式加 `wtCwd` 状态：

```typescript
let wtCwd: string | null = null
// claim_task 成功 → 查 task.worktree → 设/清 wtCwd
// complete_task → wtCwd = null
// idlePoll 返回 claimedTaskId → 外层重新查并设置
// bash/read/write 的 handlers 都感知 wtCwd
```

### src/sessions/s18-worktree-isolation.ts（新增）

在 s17 基础上：

1. `WorktreeManager` + `WORKTREE_TOOLS` + `createWorktreeHandlers`
2. 系统提示词说明 worktree 隔离的使用方式
3. `/status` 增加 worktrees 列表

## 运行测试

```bash
pnpm s18
```

**测试 1：创建 + 绑定 + 队友自动进目录干活**

```text
s18 >> 建一个 worktree "auth"，绑定到任务"实现登录模块"
  > create_worktree (name="auth", task_id=task_xxx)
  [worktree] created: auth at ...\.worktrees\auth
  [bind] 实现登录模块 → worktree:auth

s18 >> 派个队友 alice 去认领
  （alice 进入 IDLE → 扫描到绑定 worktree 的任务 → 自动认领）
  [idle] alice auto-claimed: 实现登录模块
  （alice 的 bash/read/write 都在 .worktrees\auth 里执行）
  [bus] alice → lead: 登录模块已完成，改动在 worktree auth 分支 wt/auth
```

**测试 2：安全检查拒绝删除**

```text
s18 >> 删掉 auth worktree（alice 改过但没提交）
  > remove_worktree (name="auth")
  Worktree 'auth' has 2 uncommitted file(s) and 1 unpushed commit(s).
  Use discard_changes=true to force removal, or keep_worktree to preserve for review.
```

**测试 3：保留 + 事件日志**

```text
s18 >> 保留 auth 供审查
  > keep_worktree (name="auth")
  [worktree] kept: auth
  （.worktrees/events.jsonl 里能看到 create / remove / keep 的完整生命周期）
```

## 关键收获

1. **隔离 = 目录级 + 分支级**：worktree 共享对象库但 checkout 不同分支，互不可见互不干扰
2. **绑定是"贴标签"不是"开工"**：只写 worktree 字段保持 pending，认领时机和绑定时机解耦
3. **cwd 是队友的隐式状态**：认领即切目录、完成即回仓库，队友不需要被反复提醒
4. **安全默认拒绝**：未提交改动默认不可删；验证失败按最坏情况处理
5. **名称校验防两类攻击**：一个白名单正则同时挡住路径穿越和命令注入
6. **事件日志**：create / remove / keep 全生命周期可追溯，审查和复盘有据可依
