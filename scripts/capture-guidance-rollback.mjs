import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MNP_MCP_SERVER_INSTRUCTIONS } from '../src/utils/aiContextInstructions.mjs'
import { buildAiInstructionSnapshots } from '../tests/helpers/aiInstructionSnapshots.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'docs/ai-guidance-rollback-2026-10-01')
const phase = process.argv[2]
if (phase !== 'after') throw new Error('기존 before 원본은 보존합니다. 과거 실측 재현은 capture-guidance-evidence.mjs를 사용하고 현재 캡처에는 after를 지정하세요.')
const digest = (text) => createHash('sha256').update(text).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
await mkdir(output, { recursive: true })

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'mcp/server.mjs')],
  env: { ...process.env, MNP_MCP_USAGE_DISABLED: '1' },
  stderr: 'pipe',
})
const client = new Client({ name: 'guidance-rollback-capture', version: '1.0.0' })
try {
  await client.connect(transport)
  const registeredInstructions = client.getInstructions()
  if (typeof registeredInstructions !== 'string') throw new Error('initialize 응답의 instructions가 없습니다.')
  const tools = [...(await client.listTools()).tools].sort((a, b) => a.name.localeCompare(b.name))
  const snapshots = (await buildAiInstructionSnapshots()).map(({ name, text, router }) => ({
    name, text, router: router ?? null, length: text.length, sha256: digest(text),
  }))
  const capture = {
    head: git('rev-parse', 'HEAD').trim(),
    capturedAt: new Date().toISOString(),
    workingTreeDiffSha256: digest(git('diff', 'HEAD', '--', 'mcp', 'server', 'src', 'scripts', 'tests')),
    sourceConstant: { text: MNP_MCP_SERVER_INSTRUCTIONS, length: MNP_MCP_SERVER_INSTRUCTIONS.length, sha256: digest(MNP_MCP_SERVER_INSTRUCTIONS) },
    serverInstructions: { origin: 'SDK Client.getInstructions(): initialize 응답', text: registeredInstructions, length: registeredInstructions.length, sha256: digest(registeredInstructions) },
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    snapshots,
  }
  await writeFile(path.join(output, `${phase}-surface-and-prompts.json`), `${JSON.stringify(capture, null, 2)}\n`)
  process.stdout.write(`${phase}: ${tools.length} tools, ${snapshots.length} prompts, schema SHA-256 ${digest(JSON.stringify(tools.map(({ name, inputSchema }) => ({ name, inputSchema }))))}\n`)
} finally {
  await client.close()
}
