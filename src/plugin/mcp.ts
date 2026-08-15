/**
 * s19 MCP Plugin - 模型上下文协议客户端（真实实现）
 * 通过 stdio + JSON-RPC 2.0 连接外部 MCP server，发现工具并合并进 Agent 的工具池
 *
 * 对标原项目 s19_mcp_plugin/code.py 的 MCPClient + normalize_mcp_name +
 * connect_mcp + assemble_tool_pool
 * 差异：原项目用 mock server 模拟 MCP；我们用真实的 MCP 协议实现——
 *       stdio transport（LSP 风格 Content-Length framing）+ JSON-RPC 2.0 +
 *       initialize 握手 + tools/list 发现 + tools/call 调用
 *       server 配置从 .mcp.json 读取（和真实 Claude Code 的配置文件一致）
 *
 * ASCII 流程：
 *   connect_mcp("docs") → spawn docs-server 子进程
 *   → initialize 握手 → tools/list 发现工具 →
 *   assembleToolPool → [builtin... , mcp__docs__search, mcp__docs__get_version]
 *   agent_loop uses assembled pool
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WORKDIR } from '../core/agent-loop'
import type { ToolDefinition, ToolHandler, ToolInputSchema } from '../core/types'

// ============================================================================
// 名称归一化
// ============================================================================

/**
 * 把 server/tool 名归一化为工具名安全字符
 * 非 [a-zA-Z0-9_-] 一律替换成下划线
 *
 * 为什么需要？MCP server 名可能含空格、点号等字符，拼进工具名后
 * 会给 LLM 解析带来歧义（mcp__my server__do thing 会断词）。
 * 归一化保证工具名永远是一个干净的标识符。
 */
export function normalizeMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// ============================================================================
// 常量
// ============================================================================

/** JSON-RPC 请求超时（毫秒）：server 无响应时拒绝 pending 请求 */
const REQUEST_TIMEOUT = 30_000

/** MCP 协议版本（2024-11-05 是当前主流版本） */
const PROTOCOL_VERSION = '2024-11-05'

/** .mcp.json 配置文件路径（和真实 Claude Code 一致） */
const MCP_CONFIG_PATH = path.join(WORKDIR, '.mcp.json')

// ============================================================================
// 数据结构
// ============================================================================

/** .mcp.json 里单个 server 的配置 */
export interface MCPServerConfig {
  command: string // 启动命令，如 "npx"
  args?: string[] // 命令参数，如 ["tsx", "src/plugin/mcp-servers/docs-server.ts"]
}

/** MCP 协议的工具定义（协议用 inputSchema 驼峰，我们的 ToolDefinition 用 input_schema） */
export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** JSON-RPC 2.0 响应（id 为 null 表示通知） */
interface JSONRPCResponse {
  id: number | null
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * 把 MCP 的 inputSchema（通用 JSON Schema）适配成我们的 ToolInputSchema
 *
 * MCP 协议允许任意 JSON Schema（缺 type、缺 properties 都合法），
 * 而 ToolInputSchema 要求 type 和 properties 必填。缺省时补默认值，
 * 保证组装后的工具定义能直接进 Anthropic API。
 */
function adaptMcpSchema(schema: Record<string, unknown> | undefined): ToolInputSchema {
  const type = typeof schema?.type === 'string' ? schema.type : 'object'
  const properties =
    schema?.properties && typeof schema.properties === 'object'
      ? (schema.properties as ToolInputSchema['properties'])
      : {}
  const result: ToolInputSchema = { type: type as ToolInputSchema['type'], properties }
  if (Array.isArray(schema?.required)) {
    result.required = schema.required as string[]
  }
  return result
}

// ============================================================================
// MCPClient：单个 MCP server 的客户端（stdio transport + JSON-RPC 2.0）
// ============================================================================

/**
 * 单个 MCP server 的客户端
 *
 * 真实 MCP client 的生命周期：
 *   1. connect():  spawn server 子进程（stdio transport）
 *   2. initialize 握手：客户端发 initialize，server 回协议版本和能力
 *   3. notifications/initialized 通知：告诉 server 可以开始正常操作
 *   4. tools/list：发现工具定义
 *   5. callTool(): 发 tools/call 请求，解析 content 数组里的 text
 *   6. disconnect(): kill 子进程
 *
 * stdio transport 的消息分帧（和 LSP 一样）：
 *   Content-Length: {字节数}\r\n
 *   \r\n
 *   {JSON-RPC 消息体}
 */
export class MCPClient {
  tools: MCPToolDefinition[] = []

  private child: ChildProcess | null = null
  private nextId = 0
  private pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> =
    new Map()
  private buffer = Buffer.alloc(0)

  constructor(
    readonly name: string,
    private config: MCPServerConfig,
  ) {}

  /**
   * 启动 server 并完成握手 + 工具发现
   * 任何一步失败都清理子进程并抛错
   */
  async connect(): Promise<void> {
    // 1. spawn server（shell: true 保证 Windows 下 npx 等 .cmd 可解析）
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: WORKDIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })

    // 2. 监听 stdout 分帧
    this.child.stdout!.on('data', (chunk: Buffer) => this.handleData(chunk))
    this.child.stderr!.on('data', () => {
      // stderr 忽略（真实 CC 会记录日志，教学版静默）
    })
    // server 意外退出：拒绝所有 pending 请求
    this.child.on('exit', () => {
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP server '${this.name}' exited unexpectedly`))
      }
      this.pending.clear()
    })

    // 3. initialize 握手
    const initResult = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'build-claude-code', version: '0.0.1' },
    })) as { protocolVersion?: string }
    if (initResult?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`protocol version mismatch: got ${initResult?.protocolVersion ?? 'none'}`)
    }

    // 4. 通知 server 初始化完成
    this.notify('notifications/initialized', {})

    // 5. tools/list 发现工具
    const listResult = (await this.request('tools/list', {})) as { tools?: MCPToolDefinition[] }
    this.tools = listResult?.tools ?? []
  }

  /**
   * 调用工具：发 tools/call 请求，解析 content 数组里的文本
   * server 返回的 isError=true 时抛错（保持工具错误可见）
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request('tools/call', {
      name: toolName,
      arguments: args,
    })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }

    const content = result?.content ?? []
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    if (result?.isError) {
      throw new Error(text || `MCP error from '${toolName}'`)
    }
    return text || JSON.stringify(result)
  }

  /** 断开连接：kill 子进程，拒绝所有 pending 请求 */
  disconnect(): void {
    this.child?.kill()
    this.child = null
    for (const [, { reject }] of this.pending) {
      reject(new Error(`MCP server '${this.name}' disconnected`))
    }
    this.pending.clear()
  }

  // --------------------------------------------------------------------------
  // JSON-RPC 2.0 传输层
  // --------------------------------------------------------------------------

  /**
   * 发请求并等待响应（按 id 匹配 pending promise）
   * 超时后从 pending 表移除并拒绝
   */
  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })

      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`MCP request '${method}' timed out after ${REQUEST_TIMEOUT / 1000}s`))
        }
      }, REQUEST_TIMEOUT)
    })
  }

  /** 发通知（无 id，不等响应） */
  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /** 序列化 + Content-Length framing 写入 stdin */
  private send(msg: object): void {
    const body = JSON.stringify(msg)
    this.child?.stdin?.write(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`)
  }

  /**
   * 解析 stdout 流里的分帧消息
   *
   * 为什么必须用 Buffer 按字节切分？
   * Content-Length 是**字节数**，而 JS 字符串按 UTF-16 字符计。
   * 响应含中文时（1 汉字 = 3 字节 = 1 字符），用字符串 slice 按字节长度
   * 切会切多——帧错乱、JSON.parse 失败、消息静默丢弃。
   * 所以整个分帧都在 Buffer 上做，只在 JSON.parse 前 toString。
   */
  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break // 头还没收全

      const header = this.buffer.subarray(0, headerEnd).toString('utf-8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // 非法帧：丢弃头部，继续等
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }

      const bodyLength = parseInt(match[1], 10)
      if (this.buffer.length < headerEnd + 4 + bodyLength) break // body 还没收全

      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + bodyLength).toString('utf-8')
      this.buffer = this.buffer.subarray(headerEnd + 4 + bodyLength)
      this.handleMessage(body)
    }
  }

  /** 处理一条完整 JSON-RPC 消息（教学版只处理响应，server→client 请求忽略） */
  private handleMessage(body: string): void {
    let msg: JSONRPCResponse
    try {
      msg = JSON.parse(body) as JSONRPCResponse
    } catch {
      return // 损坏消息：丢弃
    }

    if (msg.id === null || msg.id === undefined) return // 通知：忽略

    const pending = this.pending.get(msg.id)
    if (!pending) return // 无人等待的响应（已超时清理）

    this.pending.delete(msg.id)
    if (msg.error) {
      pending.reject(new Error(msg.error.message))
    } else {
      pending.resolve(msg.result)
    }
  }
}

// ============================================================================
// MCPManager：多 server 连接管理 + 工具池组装
// ============================================================================

/**
 * MCP 连接管理器
 *
 * 对标原项目的 mcp_clients 字典 + connect_mcp + assemble_tool_pool。
 * 配置从 .mcp.json 读取（和真实 Claude Code 一致）：
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "docs": {
 *       "command": "npx",
 *       "args": ["tsx", "src/plugin/mcp-servers/docs-server.ts"]
 *     }
 *   }
 * }
 * ```
 */
export class MCPManager {
  private clients: Map<string, MCPClient> = new Map()
  private configs: Record<string, MCPServerConfig> = {}

  constructor(configPath: string = MCP_CONFIG_PATH) {
    this.loadConfig(configPath)
  }

  /** 从 .mcp.json 加载 server 配置（文件缺失时为空，connect 时报错提示） */
  private loadConfig(configPath: string): void {
    if (!fs.existsSync(configPath)) return
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
        mcpServers?: Record<string, MCPServerConfig>
      }
      this.configs = data.mcpServers ?? {}
    } catch {
      console.log(`  \x1b[31m[mcp] failed to parse ${configPath}\x1b[0m`)
    }
  }

  /**
   * 连接一个 MCP server：spawn + 握手 + 发现工具
   * 返回结果消息（成功/失败都返回字符串，和工具 handler 约定一致）
   */
  async connect(name: string): Promise<string> {
    if (this.clients.has(name)) {
      return `MCP server '${name}' already connected`
    }
    const config = this.configs[name]
    if (!config) {
      return `Unknown server '${name}'. Available: ${Object.keys(this.configs).join(', ') || '(none — check .mcp.json)'}`
    }

    const client = new MCPClient(name, config)
    try {
      await client.connect()
    } catch (e) {
      client.disconnect()
      return `MCP connect error: ${(e as Error).message}`
    }

    this.clients.set(name, client)
    const toolNames = client.tools.map((t) => t.name)
    console.log(`  \x1b[31m[mcp] connected: ${name} → ${toolNames.join(', ')}\x1b[0m`)
    return (
      `Connected to MCP server '${name}'. ` +
      `Discovered ${client.tools.length} tools: ${toolNames.join(', ')}`
    )
  }

  /** 是否已连接 */
  has(name: string): boolean {
    return this.clients.has(name)
  }

  /** 已连接的 server 名列表 */
  listConnected(): string[] {
    return [...this.clients.keys()]
  }

  /** 断开所有连接（session 退出时清理子进程） */
  disconnectAll(): void {
    for (const client of this.clients.values()) {
      client.disconnect()
    }
    this.clients.clear()
  }

  /**
   * 组装工具池：builtin 工具 + 所有已连接 MCP 工具
   *
   * MCP 工具命名：mcp__{server}__{tool}（都归一化）
   * 前缀的作用：避免命名冲突（builtin 的 bash 和某个 MCP 的 bash 区分开），
   * 也告诉 LLM "这是外部工具，不是内置能力"。
   *
   * 注意 handler 闭包要绑定 client 和原始工具名——组装的池是快照，
   * 每次 connect 新 server 后调用方需要重新组装。
   */
  assembleToolPool(
    baseTools: ToolDefinition[],
    baseHandlers: Record<string, ToolHandler>,
  ): { tools: ToolDefinition[]; handlers: Record<string, ToolHandler> } {
    const tools = [...baseTools]
    const handlers = { ...baseHandlers }

    for (const [serverName, client] of this.clients) {
      const safeServer = normalizeMcpName(serverName)
      for (const toolDef of client.tools) {
        const safeTool = normalizeMcpName(toolDef.name)
        const prefixed = `mcp__${safeServer}__${safeTool}`
        tools.push({
          name: prefixed,
          description: toolDef.description,
          // MCP 协议用 inputSchema（驼峰 + 通用 JSON Schema），适配成 ToolInputSchema
          input_schema: adaptMcpSchema(toolDef.inputSchema),
        })
        handlers[prefixed] = (input) => client.callTool(toolDef.name, input)
      }
    }

    return { tools, handlers }
  }
}

// ============================================================================
// Lead 的 MCP 工具定义
// ============================================================================

export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'connect_mcp',
    description:
      'Connect to an MCP server defined in .mcp.json and discover its tools. ' +
      'MCP tools appear as mcp__{server}__{tool}.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'MCP server name to connect (as defined in .mcp.json)',
        },
      },
      required: ['name'],
    },
  },
]

// ============================================================================
// Lead 的 MCP 工具 handlers
// ============================================================================

/**
 * 工厂函数：创建 MCP 工具的 handlers
 *
 * @param options.onConnect 连接成功后的回调——session 用它重新组装工具池
 *                          并刷新系统提示词的工具清单
 */
export function createMcpHandlers(
  mcpManager: MCPManager,
  options: { onConnect?: () => void } = {},
): Record<string, ToolHandler> {
  return {
    connect_mcp: async (input) => {
      const result = await mcpManager.connect(input.name as string)
      if (result.startsWith('Connected')) {
        options.onConnect?.()
      }
      return result
    },
  }
}
