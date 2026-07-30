# 15 - Agent Teams

## 学习目标

- 理解多代理要解决的核心问题：单 Agent 串行干活，大任务无法并行、无法分工
- 理解 `MessageBus` — 文件邮箱消息总线，send / readInbox / peek 三个操作各司其职
- 理解"读即删"的消费式收信 — 消息是事件不是状态，处理过就不该再处理
- 理解 `TeammateManager` — 派生/管理后台队友，队友生命周期完整闭环
- 理解队友的简化 agent loop — 干净上下文 + 工具子集 + 每轮收信 + 10 轮上限
- 理解三源 Queue Processor — background + cron + lead 收件箱共用一个定时器
- 理解 `peek` vs `readInbox` 的分离 — 唤醒条件非破坏性，真正的读取统一做
- 实现 3 个新工具：spawn_teammate / send_message / check_inbox
- 理解 Node.js 单线程 vs Python 多线程的队友实现差异

## 核心概念

### 问题背景

到 s14，Agent 已经具备：循环、工具、规划、子代理、压缩、权限、Hook、记忆、提示词、错误恢复、任务系统、后台执行、定时调度。

但还有一个能力缺失：**所有工作都是 Lead 一个人串行干的。**

```text
用户："前端后端两个模块一起开发"

真实 Claude Code（有 agent teams）：
  Lead 派生前端队友 + 后端队友 → 两个队友并行干活
  → 各自通过邮箱汇报 → Lead 汇总结果

我们的项目（s14，没有 teams）：
  Lead 先写前端 → 再写后端 → 串行，慢
  而且写后端时，前端的长上下文还在历史里 → 上下文膨胀
```

s04 的 subagent 能拆任务，但它是**同步**的——Lead 等子代理跑完才能继续。teammate 是**异步**的——派出去就不管，结果通过邮箱回来。

### subagent vs teammate

| 维度 | subagent (s04)      | teammate (s15)        |
| ---- | ------------------- | --------------------- |
| 执行 | 同步，Lead 阻塞等待 | 异步，Lead 继续干别的 |
| 通信 | 返回值一次性返回    | 邮箱持续双向通信      |
| 指令 | 只有初始 prompt     | 干活途中可追加指令    |
| 适用 | 一次性子任务        | 长期并行协作          |

### 解决方案

> **"Lead 派生队友并行干活，用文件邮箱做异步通信。"**

```text
        ┌────────────────────── Lead ──────────────────────┐
        │  REPL → agent turn → spawn_teammate / send_message │
        │     ↑                                              │
        │     │ queue processor (500ms 轮询)                 │
        │     │ 三源: background + cron + bus.peek('lead')   │
        └─────│──────────────────────────────────────────────┘
              │ readInbox('lead')
   ┌──────────┴───────────┐
   │  .mailboxes/          │
   │   lead.jsonl          │ ← 队友们发 result / message 到这里
   │   alice.jsonl         │ ← Lead 发指令到这里
   │   bob.jsonl           │
   └──────────┬───────────┘
              │ 每个队友每轮开头 readInbox(自己)
   ┌──────────┴───────────┐
   │ Teammate (async 函数) │
   │  inbox → LLM → bash/read/write/send_message → loop (≤10轮)
   │  结束后: 提取总结 → send(lead, type="result") → 注销
   └───────────────────────┘
```

### MessageBus：文件邮箱

每个 Agent 一个 `.mailboxes/{name}.jsonl` 文件，一行一条 JSON 消息：

```typescript
send(from, to, content, type) // 追加一行（发信）
readInbox(agent) // 读全部 + 删文件（收信，消费式）
peek(agent) // 只看有没有（非破坏性）
```

**为什么 read 是破坏性的？** 消息是"事件"不是"状态"——读完就删，同一条消息不会被注入上下文两次。删除即确认消费。

**为什么需要 peek？** queue processor 每 500ms 轮询一次决定要不要唤醒一个 agent turn。如果轮询时用 `readInbox`，消息会在错误的时机被吞掉；`peek` 只看文件大小不动内容，真正的读取由 `runAgentTurn` 统一做。

**并发安全**：教学版用 `appendFileSync` 追加单行（近似原子）不加锁；真实 Claude Code 用 proper-lockfile 做文件锁。

### 队友的简化 agent loop

队友就是一个跑在后台的迷你 Agent：

1. **干净上下文**：从 spawn 的 prompt 开始，不继承 Lead 的历史（和 s04 subagent 同理）
2. **工具子集**：bash / read_file / write_file / send_message——能干活、能汇报，但不能再生队友（防止无限裂变）
3. **每轮收信**：每轮开头 `readInbox(自己)`，Lead 中途追加的指令以 `<inbox>` 消息注入
4. **10 轮上限**：教学版防烧 token；真实 CC 用 idle loop 直到收到 shutdown_request
5. **结果汇报**：结束后提取最后一个文本块作为总结，`send(lead, type="result")`

### Node.js 单线程的队友实现

Python 版队友跑在 `threading.Thread` 里，队友的同步 `subprocess.run` 只阻塞那个线程。Node.js 单线程不能这么玩：

| 操作        | Python 线程版      | Node.js 版                     |
| ----------- | ------------------ | ------------------------------ |
| 队友主体    | `threading.Thread` | `async` 函数 fire-and-forget   |
| 队友的 bash | 同步 `subprocess`  | **必须异步** `execAsync`       |
| API 调用    | 同步 SDK           | `await client.messages.create` |
| 锁          | `threading.Lock`   | 不需要（单线程无竞争）         |

如果队友用 `execSync`，队友跑 `npm install` 时整个进程（包括 Lead 的 REPL）都会卡死——这就是 teammate.ts 里单独实现 `runBash` 异步版而不复用 core/tools.ts 的原因。

### 三源 Queue Processor

s14 的 queue processor 有两个唤醒源（background 完成、cron 触发），s15 加第三个：lead 收件箱有信。

```typescript
if (!bgManager.hasCompleted() && !cronManager.hasQueue() && !bus.peek('lead')) return
```

**关键设计**：唤醒条件只看 `bus.peek`，不看 `teammateManager.hasActive`。因为队友是**先发 result 再注销**的——队友注销后，它的 result 消息还躺在邮箱里。如果 gate 在"还有活跃队友"上，最后一个 result 就永远没人拾取了。

同理，`checkQueueStop` 在有活跃队友时不能停——队友随时可能来信，停了就没有轮询者了。

## 实现

### src/team/message-bus.ts

`MessageBus` 类，三个方法各司其职：

```typescript
send(from, to, content, type = 'message') {
  // 组装 BusMessage → appendFileSync 一行 JSON
  // type 区分: "message"(普通通信) / "result"(结果汇报)
}

readInbox(agent): BusMessage[] {
  // 文件不存在 → []
  // 逐行 JSON.parse（跳过损坏行）→ unlink 文件（消费）
}

peek(agent): boolean {
  // 文件存在且 size > 0（不读内容）
}
```

### src/team/teammate.ts

`TeammateManager` 类 + Lead 的三个团队工具：

```typescript
class TeammateManager {
  spawn(name, role, prompt): string {
    // 重名检查 → 注册 → void this.run(...) fire-and-forget
    // run 里 catch 兜底：崩溃也发 result 给 lead 并注销
  }

  private async run(name, role, prompt) {
    // for (turn < 10):
    //   readInbox(name) → 有信就注入 <inbox>
    //   await API（slice(-20) 限制上下文）
    //   stop_reason !== 'tool_use' → break
    //   执行工具 → 结果入历史
    // 提取总结 → bus.send(name, 'lead', summary, 'result') → 注销
  }
}

TEAM_TOOLS = [spawn_teammate, send_message, check_inbox]

createTeamHandlers(bus, teammateManager, { onSpawn }) {
  // spawn_teammate → teammateManager.spawn() + onSpawn()
  //   onSpawn 是 session 传的 ensureQueue——队友开跑后
  //   必须有轮询者盯着 lead 收件箱，否则 result 没人拾取
  // send_message → bus.send('lead', to, content)
  // check_inbox → bus.readInbox('lead') 格式化输出
}
```

### src/sessions/s15-agent-teams.ts

在 s14 基础上的增量：

1. `allTools` 加 `TEAM_TOOLS`，`handlers` 加 `createTeamHandlers(bus, teammateManager, { onSpawn: ensureQueue })`
2. `processQueue` 加第三个唤醒源 `bus.peek('lead')`
3. `runAgentTurn` 开头注入 lead 收件箱消息（`[Inbox]\nFrom X: ...`）
4. `checkQueueStop` 加两个不停条件：`teammateManager.hasActive()`、`bus.peek('lead')`
5. `/status` 显示活跃队友列表；所有队友完成且输出已交付时提示 `[all teammates done]`

## 运行测试

```bash
pnpm s15
```

```text
s15 >> 派两个队友并行干活：alice 负责写一个 hello.txt，
       bob 负责统计当前目录有多少个 .ts 文件

  [teammate] alice spawned as file writer
  [teammate] bob spawned as code analyst
  [queue processor] started

s15 >>  （Lead 继续干别的，队友在后台跑）

  [bus] alice → lead: 已创建 hello.txt
  [bus] bob → lead: 共 23 个 .ts 文件
  [queue processor] delivering work
  [inject inbox] 2 message(s)

Lead 汇总两个队友的结果...

  [all teammates done]
```

同时可以验证混合场景：队友跑着的时候 cron 触发、后台任务完成，三个源都会被同一个 queue processor 拾取。

## 关键收获

1. **异步协作 = 邮箱 + 轮询**：队友 fire-and-forget，结果靠 `peek` 唤醒、靠 `readInbox` 消费
2. **消息是事件不是状态**：读即删，天然防重复消费
3. **唤醒条件和消费动作分离**：`peek` 非破坏性判断，读取只在 agent turn 开头统一做
4. **单线程并发靠 async 不靠线程**：Node.js 队友必须是全异步链路（API、bash），任何同步阻塞都会冻结整个进程
5. **队友工具要做减法**：能干活能汇报但不能生队友，权限最小化
6. **注册表和消息的生命周期不同**：队友先 send 再注销，result 消息比注册表条目活得久
