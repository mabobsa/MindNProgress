import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MNP_MCP_SERVER_INSTRUCTIONS } from '../src/utils/aiContextInstructions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/mcp-tool-input-schema.json'), 'utf8'))
const budget = JSON.parse(await readFile(path.join(root, 'tests/fixtures/ai-instruction-budget.json'), 'utf8'))
const baseline = JSON.parse(await readFile(path.join(root, 'docs/ai-guidance-rollback-2026-10-01/baseline-guide-sources.json'), 'utf8')).sources['mcp/server.mjs']
const baselineDescriptions = new Map([...baseline.matchAll(/^\s*registerTool\(server, '([^']+)', ('(?:\\.|[^'])*'|`[^`]*`), /gm)]
  .map((match) => [match[1], match[2]]))
const safetyTools = new Set(['mindnprogress_restore_history', 'mindnprogress_update_document_info', 'mindnprogress_recover_ai_delegation'])
function countSchemaDescriptions(value) {
  if (!value || typeof value !== 'object') return 0
  return (typeof value.description === 'string' ? 1 : 0)
    + Object.values(value).reduce((sum, child) => sum + countSchemaDescriptions(child), 0)
}

test('최신 59개 이름·input schema와 복구한 도구 설명 전문을 검증한다', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'mcp/server.mjs')],
    env: { ...process.env, MNP_MCP_USAGE_DISABLED: '1' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'rollback-surface-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const registeredInstructions = client.getInstructions()
    const tools = [...(await client.listTools()).tools].sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), fixture)
    assert.equal(tools.length, 59)
    assert.equal(createHash('sha256').update(JSON.stringify(tools.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest('hex'), '5beb90c211a2bdcf2966215ec45788750e8bd8ff5101cc20d13670f2ad38313e')
    assert.equal(tools.reduce((sum, tool) => sum + countSchemaDescriptions(tool.inputSchema), 0), 143)
    assert.equal(baselineDescriptions.size, 56)
    for (const tool of tools) {
      if (safetyTools.has(tool.name) || tool.name === 'mindnprogress_search_content' || tool.name === 'mindnprogress_patch_card_text') continue
      const original = baselineDescriptions.get(tool.name)
      if (!original) continue // 배열로 등록되는 복구 도구는 아래 의미 검사에서 검증한다.
      assert.equal(tool.description, original.slice(1, -1), `${tool.name}의 기준선 상세 설명이 달라졌습니다.`)
    }

    const descriptions = new Map(tools.map(({ name, description }) => [name, description]))
    assert.match(descriptions.get('mindnprogress_restore_history'), /복원 직전.*백업.*전체.*교체.*변경.*새.*이력.*get_document.*list_history/s)
    assert.match(descriptions.get('mindnprogress_update_document_info'), /최신 baseVersion.*force=true.*사용자가 명시적으로 승인.*get_document/s)
    assert.match(descriptions.get('mindnprogress_recover_ai_delegation'), /복구.*mindnprogress_list_ai_delegations.*상태.*확인/s)
    assert.match(descriptions.get('mindnprogress_search_content'), /ranked.*catalog.*page.hasMore.*coverage/s)
    assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /read_me_first.*get_context.*guide.*nextStep/s)
    assert.equal(MNP_MCP_SERVER_INSTRUCTIONS.length, budget.sourceConstantChars)
    assert.equal(createHash('sha256').update(MNP_MCP_SERVER_INSTRUCTIONS).digest('hex'), budget.sourceConstantSha256)
    assert.ok(registeredInstructions.startsWith(MNP_MCP_SERVER_INSTRUCTIONS))
    assert.match(registeredInstructions, /Dooray 승인 새 대화.*get_dooray_response_approval.*승인 범위/s)
    assert.ok(registeredInstructions.length > MNP_MCP_SERVER_INSTRUCTIONS.length)
    assert.equal(registeredInstructions.length, budget.serverInstructionsChars)
    assert.equal(createHash('sha256').update(registeredInstructions).digest('hex'), budget.serverInstructionsSha256)
    assert.equal(tools.reduce((sum, tool) => sum + tool.description.length, 0), budget.toolDescriptionChars)
    assert.equal(tools.reduce((sum, tool) => sum + tool.name.length, 0), budget.toolNameChars)
    assert.equal(tools.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema).length, 0), budget.inputSchemaJsonChars)
    assert.equal(budget.hostMetadata.measured, false)
    assert.equal(budget.rawRegisteredSurfaceChars, registeredInstructions.length + budget.toolNameChars + budget.toolDescriptionChars + budget.inputSchemaJsonChars)
  } finally {
    await client.close()
  }
})
