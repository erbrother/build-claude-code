/**
 * MCP server "deploy"：部署操作服务
 * trigger 是破坏性工具（描述里标注 destructive），status 只读
 *
 * 由 .mcp.json 配置启动：npx tsx src/plugin/mcp-servers/deploy-server.ts
 */

import { createStdioServer } from './server-lib'

/** 模拟的部署状态表（server 进程内存态） */
const deployments: Record<string, string> = {}

createStdioServer({
  name: 'deploy',
  version: '1.0.0',
  tools: [
    {
      name: 'trigger',
      description: 'Trigger a deployment. (destructive — requires approval in real CC)',
      inputSchema: {
        type: 'object',
        properties: { service: { type: 'string', description: 'Service name to deploy' } },
        required: ['service'],
      },
    },
    {
      name: 'status',
      description: 'Check deployment status. (readOnly)',
      inputSchema: {
        type: 'object',
        properties: { service: { type: 'string', description: 'Service name to check' } },
        required: ['service'],
      },
    },
  ],
  handlers: {
    trigger: (args) => {
      const service = args.service as string
      deployments[service] = 'deploying'
      return `[deploy] Triggered deployment for: ${service}`
    },
    status: (args) => {
      const service = args.service as string
      return `[deploy] ${service}: ${deployments[service] ?? 'not deployed'}`
    },
  },
})
