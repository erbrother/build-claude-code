# 17 - Autonomous Agents

## 学习目标

- 理解自主代理要解决的核心问题：队友只能等 Lead 派活，Lead 忙不过来
- 理解 WORK → IDLE → SHUTDOWN 生命周期 — 队友自己发现工作，自己安排节奏
- 理解 `scanUnclaimedTasks` — 自主性的核心：认领"pending + 无 owner + 依赖已完成"的任务
- 理解 `idlePoll` 双源轮询 — 收件箱（Lead 指令优先）+ 任务板（自主认领）
- 理解 IDLE 超时自动退出 — 60s 无事件不占资源
- 理解 `claim_task` 的 owner 检查 — 防止两个队友抢同一个任务
- 理解身份再注入 — 上下文被压缩后重新提醒队友"你是谁"
- 理解队友工具从 5 个扩到 8 个 — + list_tasks / claim_task / complete_task
- 理解三种运行模式的演进：rounds（s15）→ idle（s16）→ autonomous（s17）

## 核心概念

### 问题背景

s16 的队友是待命同事：干完活进入 idle，但 idle 里**只等 Lead 指令**。

```text
用户："Lead，给我把任务板上没分配的任务都干掉"

真实 Claude Code（有 autonomous agents）：
  Lead 派生几个自主队友 → 队友干完派单后进入 IDLE
  → IDLE 阶段自己扫描任务板 → 发现待认领任务 → 认领 → 继续干
  → Lead 只需要把任务放上板，剩下的队友自己会做

我们的项目（s16，没有 autonomous）：
  Lead 必须逐条 spawn + 逐条派活 → Lead 成为瓶颈
  → 任务板上挂着一堆没人认领的任务 → 只能 Lead 亲自干
```

核心转变：**从"Lead 派活"变成"队友抢活"。** 任务板变成共享工作队列，Lead 负责放活，队友负责认领。

### 三种运行模式演进

| 模式         | session | 触发              | 退出条件                           |
| ------------ | ------- | ----------------- | ---------------------------------- |
| `rounds`     | s15     | spawn 时给 prompt | 最多 10 轮干完就退                 |
| `idle`       | s16     | spawn 时给 prompt | 只等 Lead 的 shutdown_request      |
| `autonomous` | s17     | spawn 时给 prompt | shutdown_request 或 60s 无事件超时 |

```text
rounds:      spawn → 干活（≤10轮）→ 汇报 → 退出
idle:        spawn → WORK → IDLE(等指令) ─→ shutdown → 汇报 → 退出
autonomous:  spawn → WORK → IDLE(等指令 + 抢任务) ─→ 有活/超时
                  ↑                              ↓
                  └──────────── 认领任务 ────────┘
```

### 生命周期：WORK → IDLE → SHUTDOWN

```text
WORK: inbox → LLM → tools → (tool_use? 继续)
                        ↓ 模型停下或 10 轮
IDLE: 每 5s 轮询
       ├─ 收件箱有信 → 协议就地处理 / 普通消息 → 回 WORK
       ├─ 任务板有待认领 → claim 成功 → 注入 <auto-claimed> → 回 WORK
       └─ 60s 无事件 → SHUTDOWN（自动退出，不占资源）
```

**为什么 60s 超时？** 真实 CC 的队友会一直待命直到 shutdown；教学版队友没有真实场景要守护，60s 无活自动退出是资源保护——既演示了"自主找活"，又不会无限挂后台烧资源。

### scanUnclaimedTasks：自主性的核心

```typescript
for (const task of tasks) {
  if (task.status !== 'pending' || task.owner) continue // 已认领的跳过
  if (await taskManager.canStart(task.id)) unclaimed.push(task) // 依赖已完成的才认领
}
```

三个条件缺一不可：

| 条件         | 防什么                             |
| ------------ | ---------------------------------- |
| `pending`    | in_progress 的任务有主了，不能抢   |
| `无 owner`   | 已认领的任务是别人在干，不能抢     |
| `依赖已完成` | blockedBy 没完成的任务领了也干不了 |

### idlePoll 双源轮询的顺序

```typescript
// 1. 收件箱先看——Lead 指令优先
inbox → shutdown_request? → 回响应 + 'shutdown'
     → 普通消息?          → 注入 <inbox> + 'work'
     → 只有协议消息        → 继续轮询（如 plan_approval_response 已就地处理）
// 2. 任务板后看——自主认领
unclaimed → claim 成功 → 注入 <auto-claimed> + 'work'
          → claim 失败 → 继续轮询（可能有竞态）
```

**为什么收件箱优先？** Lead 要关人（shutdown_request）或追加指令时，不能让队友先去抢活——指令的优先级高于自主性。顺序错了，队友可能对 Lead 的关闭请求视而不见。

### claim_task 的 owner 检查

s17 新增的竞争保护：队友 A 和队友 B 同时扫描任务板，都看到同一个 pending 任务，都调 `claim_task`。第二次调用时 owner 已被第一个队友占走，必须拒绝：

```typescript
if (task.owner) return `Task ${task_id} already owned by ${task.owner}`
```

这就是为什么 idlePoll 里 claim 失败后**继续轮询**而不是直接报错——没抢到这个任务，还有下一个。

### 身份再注入

队友的 WORK 循环里，上下文可能被压缩（s06/s11 的机制），压缩后队友可能忘了自己是谁、在干嘛：

```typescript
if (messages.length <= 3) {
  messages.unshift({
    role: 'user',
    content: `<identity>You are '${name}', role: ${role}. Continue your work.</identity>`,
  })
}
```

上下文很短 = 刚起步或刚被压缩过，注入身份提醒。用 `unshift` 放在最前面，作为"原点"。

## 实现

### src/team/teammate.ts（增量）

```typescript
interface TeammateOptions {
  mode?: 'rounds' | 'idle' | 'autonomous' // 新字段，替代 idle: boolean
  protocolManager?: ProtocolManager
  taskManager?: TaskManager // s17 新增，autonomous 模式必需
}

class TeammateManager {
  private async runAutonomous(name, role, prompt) {
    // tools = 基础 5 + submit_plan + list_tasks/claim_task/complete_task = 8
    // 外层循环：WORK → IDLE
    //   WORK:   身份再注入 + 最多 10 轮（收信分发 → LLM → 工具）
    //   IDLE:   idlePoll → 'work' 继续 / 'shutdown'|'timeout' 退出
  }

  private async idlePoll(name, messages): 'work' | 'shutdown' | 'timeout' {
    // 60s / 5s = 12 轮
    // 每轮：收件箱（协议优先）→ 任务板（自动认领）
  }

  private async scanUnclaimedTasks(taskManager): Task[] {
    // pending + 无 owner + canStart
  }
}
```

### src/sessions/s17-autonomous-agents.ts（新增）

在 s16 基础上的增量：

1. `TeammateManager(bus, { mode: 'autonomous', protocolManager, taskManager })`
2. 系统提示词说明队友是自主的——把活放上任务板，队友自己会认领
3. 其余（三源 queue processor、协议工具、check_inbox 覆盖）与 s16 相同

## 运行测试

```bash
pnpm s17
```

**测试 1：自动认领**

```text
s17 >> 派个队友 alice 当测试员，让她待命
  [teammate] alice spawned as tester (autonomous)
s17 >> 创建任务"输出一首宋词，放在hello.txt中"，不要分配
  [create] 写一份测试计划
s17 >> （等 5 秒，alice 的 IDLE 轮询扫描到任务板）
  [idle] alice auto-claimed: 写一份测试计划
  （alice 进入 WORK，开始干活，完成后把结果汇报给 lead）
```

**测试 2：shutdown**

```text
s17 >> alice 干完了，让她关闭
  > request_shutdown
  [protocol] shutdown_request → alice (req_000001)
  [bus] alice → lead: (shutdown_response) Shutting down gracefully.
  [protocol] shutdown ✓ (req_000001: approved)
  [teammate] alice finished
```

**测试 3：IDLE 超时自动退出**

```text
s17 >> 派个队友 bob 干个简单任务，之后什么也别做
  （bob 干完 → IDLE → 60s 无事件）
  [idle] bob timeout (60s)
  [teammate] bob finished
```

## 关键收获

1. **自主性 = 任务板 + 扫描认领**：队友从"等派活"变成"抢活"，Lead 从瓶颈变成放活的人
2. **生命周期显式化**：WORK → IDLE → SHUTDOWN 三个状态各司其职，退出条件明确
3. **指令优先于自主性**：IDLE 轮询先收件箱后任务板，Lead 的关闭请求不能被抢活耽误
4. **竞态防护**：claim_task 的 owner 检查 + claim 失败继续轮询，多队友并行不冲突
5. **资源保护**：60s 超时自动退出——自主不等于无限占用
6. **身份是脆弱状态**：上下文压缩后队友会忘事，需要身份再注入
