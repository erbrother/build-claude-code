# 16 - Team Protocols

## 学习目标

- 理解协议要解决的核心问题：s15 的消息是"喊话"，发出去就完了，无法确认对方收没收到、同不同意
- 理解请求-响应握手的核心机制：`request_id` 关联请求和响应
- 理解 `ProtocolState` 状态机 — pending → approved/rejected 的流转
- 理解 `matchResponse` 的三层校验 — 已注册 / 类型匹配 / 幂等防重
- 理解 `consumeLeadInbox` 统一消费 — 两个收信入口都必须做协议路由
- 理解队友 idle 模式 — 干完活不退出，轮询收件箱等指令直到 shutdown_request
- 理解协议消息的分发 — 控制信号就地处理，普通消息才注入上下文
- 实现 3 个新 Lead 工具：request_shutdown / request_plan / review_plan
- 实现 1 个新队友工具：submit_plan

## 核心概念

### 问题背景

s15 的队友能并行干活了，但 Lead 对队友的控制很粗糙：

```text
场景 1：队友干完了，Lead 想让它退出
  s15：没办法。队友 10 轮后自己退——可能太早（活没干完）或太晚（空跑烧 token）

场景 2：队友要做一个危险操作，Lead 想先审批方案
  s15：没办法。队友拿到任务就直接干了，Lead 只能事后看结果

场景 3：Lead 发了指令，队友到底收到没有？
  s15：不知道。消息进邮箱就完了，没有回执
```

根本问题：**s15 的消息是"喊话"，不是"握手"。** 发信方无法把响应和请求关联起来——队友回了句"好的"，是对哪条指令说的？

### 解决方案

> **"每个请求带 request_id，响应必须带同一个 id，用状态机追踪流转。"**

两个协议，覆盖团队管理的两个核心场景：

| 协议            | 方向            | 场景                  |
| --------------- | --------------- | --------------------- |
| `shutdown`      | Lead → teammate | 优雅关闭队友          |
| `plan_approval` | teammate → Lead | 队友交计划，Lead 审批 |

完整流程（以 shutdown 为例）：

```text
Lead                          teammate
  │  1. createRequest('shutdown')      │
  │     pending[req_123] = pending     │
  │  2. send("shutdown_request",       │
  │         {request_id: req_123}) ───→│
  │                              3. dispatch 拦截
  │                              4. send("shutdown_response",
  │                                     {request_id: req_123, approve: true})
  │  ←─────────────────────────────────│
  │  5. consumeLeadInbox               │
  │     → matchResponse(req_123)       │
  │     → pending[req_123] = approved  │
```

### ProtocolState：在途请求注册表

邮箱消息是"过路"的——读完就删。但协议请求要活到响应回来为止，所以需要注册表：

```typescript
interface ProtocolState {
  requestId: string // 关联请求和响应的唯一标识
  type: 'shutdown' | 'plan_approval'
  sender: string // 发起方
  target: string // 接收方
  status: 'pending' | 'approved' | 'rejected'
  payload: string // 计划文本 或 关闭原因
  createdAt: number
}
```

**两个方向的请求进同一个注册表**：Lead 发的 shutdown、队友发的 plan_approval，都是"等响应"的在途请求。

### matchResponse：响应匹配的三层校验

收到响应时，不是简单改状态——要先校验：

| 顺序 | 校验                 | 防什么                                         |
| ---- | -------------------- | ---------------------------------------------- |
| 1    | request_id 已注册    | 孤儿响应（上一轮会话残留、伪造）               |
| 2    | 响应类型匹配请求类型 | shutdown 的响应不能去关掉 plan_approval 的请求 |
| 3    | 状态还是 pending     | 重复响应（邮箱重投、队友重发）——幂等           |

**顺序不能乱**：先确认"有这个请求"，再确认"是这个类型的响应"，最后确认"还没处理过"。

### consumeLeadInbox：两个入口，一条路

Lead 有两个收信入口：

1. `check_inbox` 工具——模型主动调用
2. `runAgentTurn`——queue processor 唤醒后被动注入

如果只有一个入口做协议路由，另一个入口读信时会把 `shutdown_response` 当普通文本吞掉——request 永远停在 pending，状态机和模型看到的世界不一致。

所以两个入口都必须走 `consumeLeadInbox`：**读信 + 把 `*_response` 消息路由进 matchResponse**。

### 队友 idle 模式：从"短命工人"到"待命同事"

s15 的队友是短命工人：最多 10 轮，干完就走。s16 的队友是待命同事：

```text
rounds 模式 (s15)：spawn → 干活（≤10轮）→ 汇报 → 退出
idle 模式 (s16)：  spawn → 干活 → 待命 ←──┐
                        ↑        │ 收到新消息
                        └────────┘
                             │ 收到 shutdown_request
                             ↓
                          汇报 → 退出
```

idle 等待的实现：模型 `stop_reason != 'tool_use'`（决定停下）后不退出，每 1s 轮询自己的收件箱：

- 有普通消息 → 注入 `<inbox>` → 回到 LLM turn 继续干活
- 有 shutdown_request → 回 shutdown_response → 退出
- 有 plan_approval_response → 注入 `[Plan approved]` / `[Plan rejected]` → 继续

### 协议消息分发：控制信号 ≠ 对话内容

协议消息（`shutdown_request` 等）不是给模型看的文本，而是要改变队友**自身运行状态**的控制信号。所以收件箱消息要分流：

```typescript
for (const msg of inbox) {
  if (isProtocolType(msg.type)) {
    handleProtocolMessage(msg) // 就地处理：回响应、改状态、决定退不退出
  } else {
    nonProtocol.push(msg) // 普通消息：注入 <inbox> 上下文给模型看
  }
}
```

如果直接把 `shutdown_request` 当文本注入上下文，就得靠模型"自觉"退出——模型可能选择无视。分发在代码层处理，退出行为是确定的。

### submit_plan 是协议级请求，不是代码级闸门

注意原项目的明确注释：队友 `submit_plan` 后**还能继续调工具**——是否等审批靠模型自觉。真正的代码级闸门需要阻塞队友的工具分发直到审批到达，教学版不做。这是"协议引导行为"和"代码强制行为"的区别。

## 实现

### src/team/message-bus.ts（增量）

```typescript
interface BusMessage {
  // ... s15 字段
  metadata?: Record<string, unknown>  // s16: { request_id, approve }
}

send(from, to, content, type = 'message', metadata?)  // 加 metadata 参数
```

### src/team/protocols.ts（新增）

```typescript
class ProtocolManager {
  createRequest(type, sender, target, payload): ProtocolState  // 注册 pending 请求
  matchResponse(responseType, requestId, approve)              // 三层校验 + 状态流转
  get(requestId) / listAll()
}

consumeLeadInbox(bus, protocolManager): BusMessage[] {
  // readInbox('lead') + 把 *_response 消息路由进 matchResponse
  // check_inbox 和 runAgentTurn 都用它
}

PROTOCOL_TOOLS = [request_shutdown, request_plan, review_plan]
createProtocolHandlers(bus, protocolManager)
```

### src/team/teammate.ts（增量）

构造函数增加选项，默认行为不变（s15 兼容）：

```typescript
new TeammateManager(bus) // rounds 模式（s15）
new TeammateManager(bus, { idle: true, protocolManager }) // idle 模式（s16）
```

idle 模式新增：

- `runIdle()` — idle 主循环（待命直到 shutdown）
- `dispatchInbox()` — 收件箱分流：协议消息就地处理，普通消息返回待注入
- `handleProtocolMessage()` — shutdown_request → 回响应 + 退出；plan_approval_response → 注入上下文
- `submit_plan` 工具 — 注册 plan_approval 请求 + 发 plan_approval_request 给 Lead

### src/sessions/s16-team-protocols.ts（新增）

在 s15 基础上的增量：

1. `allTools` 加 `PROTOCOL_TOOLS`，`handlers` 加 `createProtocolHandlers(...)`
2. **覆盖 `check_inbox`**——协议感知版本（走 `consumeLeadInbox`），显示 `[type req:xxx]` 标签
3. `runAgentTurn` 的收件箱消费改走 `consumeLeadInbox`
4. 队友用 idle 模式创建
5. `/status` 增加协议请求列表（requestId / type / 方向 / 状态）

## 运行测试

```bash
pnpm s16
```

**测试 1：shutdown 协议**

```text
s16 >> 派个队友 alice 写一个 hello.txt，干完让她待命
  [teammate] alice spawned as file writer
  [bus] alice → lead: (result) 已创建 hello.txt

s16 >> alice 干完了，让她关闭
  > request_shutdown
  [protocol] shutdown_request → alice (req_000001)
  [bus] alice → lead: (shutdown_response) Shutting down gracefully.
  [protocol] shutdown ✓ (req_000001: approved)
  [teammate] alice finished
```

**测试 2：plan 审批协议**

```text
s16 >> 派个队友 bob，让他先交重构方案再动手
  [teammate] bob spawned as refactor engineer

s16 >> （bob 交计划）
  [bus] bob → lead: (plan_approval_request) 我计划分三步重构...
  [inject inbox] 1 message(s)

s16 >> （Lead 审批）
  > review_plan (request_id=req_000002, approve=true)
  [protocol] plan ✓ (req_000002)
  [bus] lead → bob: (plan_approval_response) Approved
  （bob 收到 [Plan approved]，继续干活）
```

`/status` 可以随时查看在途协议请求的状态。

## 关键收获

1. **协议 = 消息 + request_id + 状态机**：喊话变握手，响应能关联回请求
2. **matchResponse 三层校验**：已注册、类型匹配、幂等——顺序不能乱
3. **统一消费入口**：所有收信路径都做协议路由，否则状态机和模型看到的世界不一致
4. **idle 模式**：队友的"完成"从轮数驱动变成协议驱动，Lead 决定队友何时退出
5. **控制信号就地分发**：协议消息改变运行状态，不进上下文；退出行为代码层确定，不靠模型自觉
6. **协议引导 ≠ 代码强制**：submit_plan 后队友仍能跑，教学版靠模型自觉等审批
