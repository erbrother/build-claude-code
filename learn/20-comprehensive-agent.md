# 20 - Comprehensive Agent

## 学习目标

- 理解综合 Agent 的本质：不是新机制，而是把前 19 章的机制归位到同一个循环
- 理解循环不变、harness 变完整的核心洞察
- 理解每个机制挂在循环的哪个位置（输入前 / LLM 前 / 工具执行前中后 / 停止后）
- 理解权限 + hooks 如何作为 PreToolUse 的拦截层
- 理解两层计划（todo 内存 + task 文件）各司其职
- 理解两种 delegation（一次性 subagent + 持久 teammate）
- 理解压缩管线和错误恢复如何在 LLM 前和 LLM 调用处接合
- 理解动态工具池（builtin + MCP）每轮组装

## 核心概念

### 问题背景

前 19 章每章只加一个机制——适合学习，但真实 Agent 不会只带一个机制运行：

```text
s01-s19 每章：一个循环 + 一个机制
s20：一个循环 + 19 个机制同时生效
```

难点不是把功能堆起来，而是**看清楚它们都挂在循环的哪个位置**。S20 是终点章：把所有组件归位。

### 解决方案

> **"机制很多，循环一个"** — 工具、权限、记忆、任务、团队、插件都挂在同一个 while True 上。

核心循环从头到尾没变：

```typescript
while (true) {
  const response = await client.messages.create({ model, system, messages, tools })
  messages.push({ role: 'assistant', content: response.content })
  if (!hasToolUseBlocks(response.content)) return // 模型决定停止
  const results = await executeTools(response.content)
  messages.push({ role: 'user', content: results }) // 循环继续
}
```

变化的是**循环周围的 harness 完整了**。

### 组件在循环中的位置

| 位置         | 组件                            | 作用                                     |
| ------------ | ------------------------------- | ---------------------------------------- |
| 用户输入前后 | `UserPromptSubmit` hooks        | 记录、注入、审计用户输入                 |
| LLM 前       | cron queue                      | 定时触发的 prompt 注入 `messages`        |
| LLM 前       | background notifications        | 后台完成以 `<task_notification>` 注入    |
| LLM 前       | compaction pipeline             | 微压缩 + 超限完整压缩                    |
| LLM 前       | memory / skills / MCP 状态      | 组装 system prompt                       |
| LLM 调用     | error recovery                  | 连接错误退避、prompt too long 反应式压缩 |
| 工具执行前   | `PreToolUse` hooks + permission | 拦截危险命令、写越界                     |
| 工具分发     | `assemble_tool_pool`            | builtin + MCP 动态合并                   |
| 工具执行时   | background dispatch             | 慢操作后台线程 + 占位结果                |
| 工具执行后   | `PostToolUse` hooks             | 大输出告警、日志                         |
| 停止时       | `Stop` hooks                    | 统计、清理、审计                         |

### 权限和 hooks：拦截层

权限不写死在工具执行行里，而是挂在 `PreToolUse` 事件上：

```typescript
// PreToolUse hooks（shell 命令，可阻止）
const hookResult = hookManager.runHooks('PreToolUse', { tool_name, tool_input })
if (hookResult.blocked) {
  push(denied)
  continue
}

// permission 决策（allow / deny / ask）
const decision = permissionManager.check(tool_name, tool_input)
if (decision.behavior === 'deny') {
  push(denied)
  continue
}
if (decision.behavior === 'ask') {
  /* 询问用户 */
}
```

这样 permission、log、审计都可以挂在同一个 hook 点上，扩展不侵入循环。

### 两层计划

- `todo_write`：当前会话内的轻量计划，内存态，帮助单个 Agent 不漂移
- task graph：跨会话、可依赖、可认领的任务文件（`.tasks/task_*.json`），支撑团队协作

前者是"我这个 session 要做哪几步"，后者是"团队哪些任务谁来做、依赖谁"。

### 两种 delegation

- `task`（subagent）：一次性子代理，独立 `messages[]`，中间过程丢弃，只返回最终摘要——解决**上下文隔离**
- `spawn_teammate`：持久队友，通过 MessageBus 收发消息，idle 轮询任务板自动认领——解决**长期并行协作**

### 压缩管线和错误恢复的接合点

压缩在 **LLM 前**：

```typescript
ctx.history = microCompact(ctx.history)          // 微压缩：旧 tool_result 占位
if (estimateContextSize(ctx.history) > 50_000) {
  ctx.history = await compactHistory(...)         // 完整压缩：摘要
}
```

错误恢复在 **LLM 调用处**：

```typescript
try {
  response = await client.messages.create(...)
} catch (e) {
  if (classifyError(e) === 'prompt_too_long' && !hasAttempted) {
    ctx.history = await compactHistory(...)       // 反应式压缩
    continue
  }
  if (classifyError(e) === 'connection_error') {
    await sleep(backoffDelay(0))                  // 退避
  }
  ...
}
```

两者都指向同一个 `compactHistory`，但触发时机不同：一个是主动维护（上下文卫生），一个是被动补救（从 API 失败中恢复）。

### max_tokens 升级

`max_tokens` 是特殊的 `stop_reason`——模型输出被截断但 API 调用成功了。处理方式：先提高 max_tokens 重试一次，给模型更大的输出空间：

```typescript
if (response.stop_reason === 'max_tokens' && !hasEscalated) {
  ctx.maxTokens = ESCALATED_MAX_TOKENS // 8000 → 16000
  hasEscalated = true
  continue
}
```

## 实现

### src/sessions/s-full-agent.ts（新增）

整合所有模块到一个 `SessionContext` + 完整 agent loop：

```typescript
interface SessionContext {
  history
  handlers
  allTools
  promptBuilder
  compactState
  taskManager
  bgManager
  cronManager
  bus
  teammateManager
  protocolManager
  worktreeManager
  mcpManager
  hookManager
  permissionManager
  todoManager
  memoryManager
  pool
  refreshPool // 动态工具池（MCP）
  maxTokens
  hasEscalated
  hasAttemptedReactiveCompact // 恢复状态
  rl // REPL（权限 ask 交互）
}
```

工具池（27 个内置工具 + MCP 动态）：

```text
bash, read_file, write_file, edit_file, glob, save_memory
todo_write, task, load_skill, compact
create_task, list_tasks, get_task, claim_task, complete_task
schedule_cron, list_crons, cancel_cron
spawn_teammate, send_message, check_inbox
request_shutdown, request_plan, review_plan
create_worktree, remove_worktree, keep_worktree
connect_mcp
+ mcp__{server}__{tool}（连接后动态出现）
```

### 增量改动

| 文件                      | 改动                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `src/core/tools.ts`       | 新增 `runGlob`（手写递归 glob，跳过 node_modules 等）+ glob 工具定义 |
| `src/core/types.ts`       | `HookEvent` 扩展 `UserPromptSubmit` / `Stop`                         |
| `src/persistence/hook.ts` | HookManager 初始化 + 配置加载覆盖全部 5 个事件                       |

## 运行测试

```bash
pnpm full
```

```text
full >> Create a todo list for inspecting this repo, then list all .ts files
  （todo_write → 建立计划 → glob **/*.ts → 返回 45 个文件）

full >> Connect to the docs MCP server and search for agent loop
  > connect_mcp (name="docs") → mcp__docs__search (query="agent loop")
  （动态工具池生效，下一轮出现 mcp__ 工具）

full >> Create two tasks with worktrees, spawn alice and bob, ask them to
       submit plans before claiming
  （task graph + worktree 绑定 + 队友提交 plan 审批 → 认领 → 切目录）

full >> remind me of the meeting in 3 minutes
  （schedule_cron → 3 分钟后 [Scheduled] 注入）

full >> Run npm install in the background and continue reading README.md
  （后台线程跑 install，主循环继续读文件）
```

观察重点：工具是否经过 hooks/permission、connect_mcp 后工具池是否刷新、慢操作是否返回占位结果、队友是否在 plan 批准前暂停。

## 关键收获

1. **循环不变，harness 变完整**：模型负责判断和行动选择；harness 负责组织环境、工具、权限、记忆、团队和外部能力
2. **每个机制有固定挂载点**：输入前后、LLM 前后、工具执行前后——不是乱堆，而是各归其位
3. **权限/hook 是拦截层**：挂在 PreToolUse，扩展不侵入循环
4. **两层计划 + 两种 delegation**：按"会话内 vs 跨会话"、"一次性 vs 持久"两个维度各取所需
5. **压缩和恢复都指向 compactHistory**：主动维护 vs 被动补救，触发时机不同、动作相同
6. **动态工具池每轮组装**：connect_mcp 后重装，工具清单同步刷新到 system prompt

---

从 s01 到 s20，代码表面越来越复杂，但核心始终没变：

```typescript
while (true) {
  const response = await LLM(messages, tools)
  if (!hasToolUse(response.content)) return
  const results = executeTools(response.content)
  messages.push({ role: 'user', content: results })
}
```

Claude Code 的复杂性不是"另一个 agent 大脑"，而是一个成熟 harness 的复杂性。这就是全书的终点：**机制很多，循环一个。**
