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
if (!['before', 'after'].includes(phase)) throw new Error('before 또는 after를 지정하세요.')
const digest = (text) => createHash('sha256').update(text).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const baseline = '11a5079d62a9493e55548fe5b1ccbe0ffa3eb94c'
const startHead = 'eaa7eeda712c76e59c19ed771cbba077b72ada1e'
if (phase === 'before' && git('rev-parse', 'HEAD').trim() !== startHead) {
  throw new Error('변경 전 캡처는 승인된 시작 HEAD에서만 다시 만들 수 있습니다.')
}
await mkdir(output, { recursive: true })

if (phase === 'before') {
  const commits = git('log', '--reverse', '--format=%H%x09%s', `${baseline}..HEAD`).trim().split('\n').map((line) => {
    const [hash, subject] = line.split('\t')
    const changes = git('diff-tree', '--no-commit-id', '--name-status', '-r', hash).trim().split('\n')
      .filter(Boolean).map((entry) => {
        const [status, ...file] = entry.split('\t')
        return { status, file: file.join('\t') }
      })
    return { hash, subject, changes }
  })
  await writeFile(path.join(output, 'commit-file-inventory.json'), `${JSON.stringify({ baseline, startHead, commits }, null, 2)}\n`)
  const sourceFiles = [
    'src/utils/aiContextInstructions.mjs', 'src/utils/aiApprovalInstructions.mjs',
    'src/utils/aiConversationLaunch.mjs', 'mcp/server.mjs', 'server/index.mjs',
    'server/lib/groupDocumentInstructions.mjs', 'server/lib/groupProjects.mjs',
    'server/lib/doorayResponses.mjs', 'server/lib/workspacePool.mjs',
  ]
  const sources = Object.fromEntries(sourceFiles.map((file) => [file, git('show', `${baseline}:${file}`)]))
  await writeFile(path.join(output, 'baseline-guide-sources.json'), `${JSON.stringify({ baseline, sources }, null, 2)}\n`)
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'mcp/server.mjs')],
  env: { ...process.env, MNP_MCP_USAGE_DISABLED: '1' },
  stderr: 'pipe',
})
const client = new Client({ name: 'guidance-rollback-capture', version: '1.0.0' })
try {
  await client.connect(transport)
  const tools = [...(await client.listTools()).tools].sort((a, b) => a.name.localeCompare(b.name))
  const snapshots = (await buildAiInstructionSnapshots()).map(({ name, text, router }) => ({
    name, text, router: router ?? null, length: text.length, sha256: digest(text),
  }))
  const capture = {
    head: git('rev-parse', 'HEAD').trim(),
    serverInstructions: { text: MNP_MCP_SERVER_INSTRUCTIONS, length: MNP_MCP_SERVER_INSTRUCTIONS.length, sha256: digest(MNP_MCP_SERVER_INSTRUCTIONS) },
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    snapshots,
  }
  await writeFile(path.join(output, `${phase}-surface-and-prompts.json`), `${JSON.stringify(capture, null, 2)}\n`)
  process.stdout.write(`${phase}: ${tools.length} tools, ${snapshots.length} prompts, schema SHA-256 ${digest(JSON.stringify(tools.map(({ name, inputSchema }) => ({ name, inputSchema }))))}\n`)
} finally {
  await client.close()
}
