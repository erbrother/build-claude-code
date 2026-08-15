# 19 - MCP Plugin

## 学习目标

- 理解 MCP（Model Context Protocol）要解决的核心问题：每接一个外部系统都要写适配代码
- 理解 MCP 的三种能力：Tools（工具）/ Resources（资源）/ Prompts（提示词），本 session 聚焦 Tools
- 理解 stdio transport — LSP 风格 Content-Length 分帧 + JSON-RPC 2.0
- 理解 initialize 握手 → notifications/initialized → tools/list → tools/call 的完整调用链
- 理解 `normalizeMcpName` — 工具名归一化，防断词和注入
- 理解 `assembleToolPool` — builtin + MCP 工具动态合并成一个池
- 理解 `mcp__{server}__{tool}` 命名 — 防冲突 + 标识外部性
- 理解动态工具池 — connect 后重装池，系统提示词同步刷新
- 理解 **Content-Length 是字节数，分帧必须在 Buffer 上做** — 中文响应的经典坑
- 理解 .mcp.json 配置 — 和真实 Claude Code 一致的 server 声明方式
- 实现 1 个新工具：connect_mcp

## 核心概念

### 问题背景

到 s18，Agent 已经能力齐全，但所有工具都是**手写的**：

```text
用户："帮我查一下这个 API 的文档"

我们的 Agent（s18，没有 MCP）：
  想查文档？得先手写一个 doc_search 工具 → 改代码 → 重启
  想查部署状态？得再写 deploy_status 工具 → 改代码 → 重启
  → 每接一个外部系统，都要改 Agent 代码

真实 Claude Code（有 MCP）：
  用户在配置文件里声明一个 MCP server
  → Agent 启动时自动连接、自动发现工具
  → 不改任何 Agent 代码，新工具直接可用
```

根本问题：**工具的"发现"和"实现"是绑死在一起的。** MCP 把它们解耦——工具定义由 server 提供，Agent 只做通用客户端。

### MCP 协议基础

MCP 是 Anthropic 2024 年提出的开放协议，把 LLM 应用和外部系统之间的集成标准化：

| 能力      | 做什么             | 本 session |
| --------- | ------------------ | ---------- |
| Tools     | 让模型调用外部工具 | ✅ 聚焦    |
| Resources | 让模型读取外部数据 | 未涉及     |
| Prompts   | 复用提示词模板     | 未涉及     |

真实 MCP client 的完整调用链（本 session 完整实现）：

```text
connect_mcp("docs")
  → spawn docs-server 子进程（stdio transport，配置来自 .mcp.json）
  → initialize 握手：客户端声明协议版本 → server 回 capabilities
  → notifications/initialized：通知 server 可以开始正常操作
  → tools/list：发现工具定义（name / description / inputSchema）
  → 组装工具池：mcp__docs__search / mcp__docs__get_version

模型调 mcp__docs__search
  → 组装池的闭包 → client.callTool('search', { query })
  → tools/call JSON-RPC 请求 → server 执行 handler
  → 响应 { content: [{ type: 'text', text: '...' }] } → 解析 text 回给模型
```

### stdio transport：Content-Length 分帧

MCP 的 stdio transport 用 LSP 风格的消息分帧，每条消息一个头：

```text
Content-Length: 123\r\n
\r\n
{"jsonrpc":"2.0","id":1,"result":{...}}
```

**Content-Length 是字节数（UTF-8），不是字符数。** 这是本 session 踩过的最大的坑：

```text
响应含中文时：1 个汉字 = 3 字节 = 1 个字符
字符串 slice 按字符切，按字节长度切 → 切多了 → 帧错乱
→ JSON.parse 失败 → 消息被静默丢弃 → 客户端等到超时
```

症状非常隐蔽：纯 ASCII 响应（initialize / tools/list / 错误信息）全正常，只有含中文的响应（docs search 返回学习笔记的中文行）消失。**分帧必须全程在 Buffer 上做**，只在 JSON.parse 前 toString：

```typescript
private handleData(chunk: Buffer): void {
  this.buffer = Buffer.concat([this.buffer, chunk])
  const headerEnd = this.buffer.indexOf('\r\n\r\n')           // Buffer.indexOf
  const body = this.buffer
    .subarray(headerEnd + 4, headerEnd + 4 + bodyLength)      // 按字节 subarray
    .toString('utf-8')
  ...
}
```

### 手写 vs 官方 SDK

本 session 客户端和 server 都手写（不引入 @modelcontextprotocol/sdk）：

| 层        | 手写内容                               | 官方 SDK 对应             |
| --------- | -------------------------------------- | ------------------------- |
| 传输      | Content-Length 分帧 + stdin/stdout     | StdioClientTransport      |
| 协议      | JSON-RPC 2.0（id 匹配 pending）        | 封装在 Client 内部        |
| 握手      | initialize + notifications/initialized | Client.connect()          |
| 发现/调用 | tools/list + tools/call                | client.listTools/callTool |

三层加起来不到 200 行，完整展示协议本质。生产项目应该用官方 SDK（处理更多边界：进度通知、资源订阅、认证），但理解手写版本后看 SDK 源码毫无障碍。

### 工具名归一化

MCP server 名和工具名可能含空格、点号等任意字符，直接拼进工具名会出问题：

```text
"my server" + "do thing" → "mcp__my server__do thing"
                                ↑ 空格断词，LLM 解析歧义
```

```typescript
normalizeMcpName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')  // 非安全字符 → 下划线
}
```

归一化保证工具名永远是干净标识符，也顺带防住"工具名注入"（server 名里藏提示词攻击）。

### assembleToolPool：动态合并工具池

```typescript
assembleToolPool(baseTools, baseHandlers) {
  const tools = [...baseTools]          // 内置工具原样保留
  const handlers = { ...baseHandlers }
  for (const [serverName, client] of clients) {
    for (const toolDef of client.tools) {
      const prefixed = `mcp__${serverName}__${toolName}`
      tools.push({ name: prefixed, ... })
      handlers[prefixed] = (input) => client.callTool(originalName, input)
    }
  }
  return { tools, handlers }
}
```

**为什么加 `mcp__{server}__` 前缀？**

1. **防冲突**：内置的 `bash` 和某个 MCP server 的 `bash` 不会互相覆盖
2. **标识外部性**：模型看到 `mcp__deploy__trigger` 就知道这是外部工具，行为不可控程度和内置工具不同

**为什么池是快照？** 组装的池在 connect 的那一刻冻结。新连接 server 后必须重新组装——所以 session 里 connect 成功后调 `refreshPool()`。

### 动态工具池的三个同步点

connect_mcp 后，有三个地方必须同步更新，漏一个就会不一致：

```typescript
const refreshPool = () => {
  // 1. 工具池本身：下一次 API 调用的 tools 参数
  pool = mcpManager.assembleToolPool(baseTools, baseHandlers)
  // 2. 系统提示词的工具清单：模型"知道"自己有哪些工具
  promptBuilder.updateTools(pool.tools)
  // 3. handler 表：工具执行时能找到对应实现
  //    （handlers 在 pool 里一起更新）
}
```

Python 版在 agent_loop 里检测到 connect_mcp 调用后重新组装——我们放在 handler 的 onConnect 回调里，职责更清晰。

### readOnly / destructive 注解

MCP 工具的描述里带注解：

```text
search: "Search documentation. (readOnly)"
trigger: "Trigger a deployment. (destructive — requires approval in real CC)"
```

这是**协议级引导，不是代码级闸门**——和 s16 的 submit_plan 同理。真实 CC 对 destructive 工具会走权限系统（s07）要求人工审批；教学版只在描述里标注，让模型自觉谨慎。

## 实现

### src/plugin/mcp.ts（新增）

```typescript
normalizeMcpName(name) // 非 [a-zA-Z0-9_-] → _

class MCPClient {
  // 真实 stdio transport + JSON-RPC 2.0
  connect() // spawn 子进程 → initialize 握手 → notifications/initialized → tools/list
  callTool(toolName, args) // tools/call 请求 → 解析 content 里的 text；isError 抛错
  disconnect() // kill 子进程 + 拒绝所有 pending 请求
  // 内部：request（id → pending Map 匹配）/ notify（无 id）
  //       send（Content-Length framing 写 stdin）
  //       handleData（Buffer 按字节分帧——中文安全的坑）
}

class MCPManager {
  connect(name) // 查 .mcp.json 配置 → spawn + 握手 + 发现；失败返回错误信息
  assembleToolPool(baseTools, baseHandlers) // builtin + MCP 合并
  listConnected() / disconnectAll() // 退出时 kill 所有 server 子进程
}

MCP_TOOLS = [connect_mcp]
createMcpHandlers(mcpManager, { onConnect }) // 连接成功后回调刷新池
```

### src/plugin/mcp-servers/（新增，真实 MCP server）

```typescript
// server-lib.ts：createStdioServer({ name, version, tools, handlers })
//   读 stdin 分帧 → 分派 initialize / notifications/initialized /
//   tools/list / tools/call → 写 stdout。和 client 端共享同样的
//   Buffer 分帧逻辑（字节数切分）。

// docs-server.ts：真实搜索 learn/*.md 学习笔记
//   search(query) (readOnly) — 返回匹配文件:行号:内容
//   get_version() (readOnly)

// deploy-server.ts：模拟部署操作
//   trigger(service) (destructive) / status(service) (readOnly)
```

### .mcp.json（新增，和真实 Claude Code 一致的配置）

```json
{
  "mcpServers": {
    "docs": { "command": "npx", "args": ["tsx", "src/plugin/mcp-servers/docs-server.ts"] },
    "deploy": { "command": "npx", "args": ["tsx", "src/plugin/mcp-servers/deploy-server.ts"] }
  }
}
```

### src/sessions/s19-mcp-plugin.ts（新增）

在 s18 基础上：

1. `baseTools` 含 `MCP_TOOLS`（connect_mcp），`baseHandlers` 含 `createMcpHandlers`
2. `pool` 变量存当前工具池；`refreshPool()` 重装 + 更新提示词
3. 每轮 REPL 开始前 `ctx.allTools = pool.tools; ctx.handlers = pool.handlers`（动态池生效）
4. `/status` 显示已连接 MCP servers；退出时 `mcpManager.disconnectAll()` kill 所有子进程
5. 系统提示词加两条 IMPORTANT 规则：
   - **MCP 连接是内存态**：新会话必须先 connect_mcp，不能假设"已连接"
   - **直接调 MCP 工具**：禁止用 bash 写临时脚本 import MCPManager 模拟调用——
     模型看不到工具定义时容易绕道 bash，这是动态工具池最常见的错误用法

### src/persistence/prompt.ts（增量）

```typescript
updateTools(tools: ToolDefinition[]) {
  this.tools = tools
  this.invalidateCache()  // 工具清单变了，缓存失效
}
```

## 运行测试

```bash
pnpm s19
```

### 测试 1：连接 + 发现工具 + 真实搜索

```text
s19 >> 连接 docs MCP server，然后搜索 "worktree" 的文档
  > connect_mcp (name="docs")
  [mcp] connected: docs → search, get_version
  [mcp] tool pool: 20 tools (1 MCP server(s))
  > mcp__docs__search (query="worktree")
  [docs] Found 10 result(s) for 'worktree':
  18-worktree-isolation.md:6: - 理解 git worktree — 同一仓库多个工作目录...
  ...
```

### 测试 2：动态池生效

```text
s19 >> （连接前工具池没有 mcp__ 前缀工具）
  /status → MCP servers: 0 connected

s19 >> 连接 deploy
  > connect_mcp (name="deploy")
  [mcp] connected: deploy → trigger, status
  （现在模型可以调 mcp__deploy__trigger / mcp__deploy__status）
```

### 测试 3：错误处理

```text
s19 >> 连接不存在的 server
  > connect_mcp (name="foo")
  Unknown server 'foo'. Available: docs, deploy

s19 >> 重复连接
  > connect_mcp (name="docs")
  MCP server 'docs' already connected
```

## 关键收获

1. **发现和实现解耦**：工具定义由 server 提供，Agent 只做通用客户端——接新系统不改 Agent 代码
2. **归一化是安全边界**：工具名归一化同时防断词歧义和名称注入
3. **前缀命名防冲突**：`mcp__{server}__{tool}` 既是命名空间也是"外部性"标记
4. **动态池有三个同步点**：工具池、提示词清单、handler 表——漏一个就状态不一致
5. **协议引导 ≠ 代码强制**：destructive 注解靠模型自觉，真实 CC 走权限系统
6. **Content-Length 是字节数不是字符数**：分帧必须在 Buffer 上做——中文响应静默消失的坑，只有纯 ASCII 消息正常时极难排查
7. **stdio transport 就三层**：framing → JSON-RPC → 方法分派，手写 200 行后看官方 SDK 源码毫无障碍
8. **子进程生命周期要闭环**：connect 时 spawn，退出时 disconnectAll，pending 请求在进程退出时要 reject——否则调用方永远等不到响应
