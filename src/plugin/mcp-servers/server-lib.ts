/**
 * MCP server 骨架（仅供 mcp-servers/*.ts 使用）
 * 最小 stdio server：读 stdin 的 JSON-RPC 2.0 消息（Content-Length framing），
 * 分派到工具 handler，把结果写回 stdout
 *
 * 为什么 client 和 server 都手写？MCP 协议的 stdio transport 就三层：
 *   framing（Content-Length 头）→ JSON-RPC 2.0（id/method/params）→ 方法分派
 * 手写加起来不到 100 行，完整展示协议本质，不引入 @modelcontextprotocol/sdk。
 */

interface ServerToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface StdioServerOptions {
  name: string // server 名（initialize 握手的 serverInfo）
  version: string
  tools: ServerToolDef[]
  handlers: Record<string, (args: Record<string, unknown>) => string>
}

/**
 * 启动一个最小 MCP stdio server
 * 处理 initialize / notifications/initialized / tools/list / tools/call 四种消息
 */
export function createStdioServer(options: StdioServerOptions): void {
  let buffer = Buffer.alloc(0)

  /** 写响应：JSON 序列化 + Content-Length framing */
  function send(msg: object): void {
    const body = JSON.stringify(msg)
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`)
  }

  /** 处理一条完整 JSON-RPC 消息 */
  function handleMessage(body: string): void {
    let msg: { jsonrpc?: string; id?: number; method?: string; params?: unknown }
    try {
      msg = JSON.parse(body)
    } catch {
      return // 损坏消息：丢弃
    }

    switch (msg.method) {
      case 'initialize': {
        // 握手：回协议版本和能力声明
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: options.name, version: options.version },
          },
        })
        return
      }

      case 'notifications/initialized':
        // 初始化完成通知：无需响应
        return

      case 'tools/list': {
        // 工具发现：返回工具定义（MCP 用 inputSchema 驼峰）
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: options.tools } })
        return
      }

      case 'tools/call': {
        const { name, arguments: args } = (msg.params ?? {}) as {
          name?: string
          arguments?: Record<string, unknown>
        }
        const handler = options.handlers[name ?? '']
        if (!handler) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            },
          })
          return
        }

        try {
          const text = handler(args ?? {})
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text }] },
          })
        } catch (e) {
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
              isError: true,
            },
          })
        }
        return
      }

      default:
        // 未知方法：JSON-RPC 标准的 method not found 错误
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        })
    }
  }

  process.stdin.on('data', (chunk: Buffer) => {
    // 和 client 端同理：Content-Length 是字节数，必须在 Buffer 上按字节切分，
    // 否则含中文的消息体会被字符串 slice 切错、JSON.parse 失败
    buffer = Buffer.concat([buffer, chunk])

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break

      const header = buffer.subarray(0, headerEnd).toString('utf-8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4)
        continue
      }

      const bodyLength = parseInt(match[1], 10)
      if (buffer.length < headerEnd + 4 + bodyLength) break

      const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + bodyLength).toString('utf-8')
      buffer = buffer.subarray(headerEnd + 4 + bodyLength)
      handleMessage(body)
    }
  })

  process.stdin.on('end', () => {
    // 客户端断开（stdin 关闭）：优雅退出
    process.exit(0)
  })
}
