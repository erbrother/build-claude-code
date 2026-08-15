/**
 * MCP server "docs"：文档查询服务
 * search 工具真实搜索 learn/*.md 学习笔记，返回匹配的标题和行号
 *
 * 由 .mcp.json 配置启动：npx tsx src/plugin/mcp-servers/docs-server.ts
 */

import { createStdioServer } from './server-lib'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 搜索目录：本项目的学习笔记 */
const DOCS_DIR = join(process.cwd(), 'learn')

/** 在 learn/*.md 里搜索关键词，返回前 10 条匹配 */
function searchDocs(query: string): string {
  const files = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
  const results: string[] = []

  for (const file of files) {
    try {
      const lines = readFileSync(join(DOCS_DIR, file), 'utf-8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
          results.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 120)}`)
          if (results.length >= 10) break
        }
      }
    } catch {
      // 跳过读不了的文件
    }
    if (results.length >= 10) break
  }

  if (results.length === 0) {
    return `[docs] No results for '${query}' in ${files.length} documents`
  }
  return `[docs] Found ${results.length} result(s) for '${query}':\n` + results.join('\n')
}

createStdioServer({
  name: 'docs',
  version: '1.0.0',
  tools: [
    {
      name: 'search',
      description: 'Search the learning notes (learn/*.md) for a keyword. (readOnly)',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keyword to search' } },
        required: ['query'],
      },
    },
    {
      name: 'get_version',
      description: 'Get the docs server version. (readOnly)',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  handlers: {
    search: (args) => searchDocs(args.query as string),
    get_version: () => '[docs] server v1.0.0 (protocol 2024-11-05)',
  },
})
