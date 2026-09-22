import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MNP_MCP_SERVER_INSTRUCTIONS } from '../src/utils/aiContextInstructions.mjs'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const surfaceFixture = JSON.parse(await readFile(path.join(projectDirectory, 'tests/fixtures/mcp-tool-input-schema.json'), 'utf8'))
const budgetFixture = JSON.parse(await readFile(path.join(projectDirectory, 'tests/fixtures/ai-instruction-budget.json'), 'utf8'))

function countSchemaDescriptions(value) {
  if (!value || typeof value !== 'object') return 0
  return (typeof value.description === 'string' ? 1 : 0)
    + Object.values(value).reduce((sum, child) => sum + countSchemaDescriptions(child), 0)
}

test('58개 MCP 도구의 이름·설명·input schema는 구현 직전 기준선과 같다', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDirectory, 'mcp/server.mjs')],
    env: { ...process.env, MNP_MCP_USAGE_DISABLED: '1' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'mcp-instruction-surface-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const tools = [...listed.tools].sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), surfaceFixture)
    assert.equal(tools.length, 58)
    assert.equal(tools.reduce((sum, tool) => sum + countSchemaDescriptions(tool.inputSchema), 0), budgetFixture.schemaDescriptionCount)

    const descriptions = tools.map((tool) => tool.description)
    assert.equal(new Set(descriptions).size, 58)
    assert.ok(descriptions.every((description) => description.length >= 15 && description.length <= 1_100))
    assert.equal(descriptions.filter((description) => description.includes('첫 조회는 진입 상태에 따라 하나만 선택하세요.')).length, 0)
    assert.equal(descriptions.filter((description) => description.includes('# 사용자 승인과 실행 범위')).length, 0)
    assert.equal(descriptions.filter((description) => description.includes('# 그룹의 두 단계 사용자 승인')).length, 0)

    for (const name of budgetFixture.verificationDescriptions) {
      const description = tools.find((tool) => tool.name === name)?.description ?? ''
      assert.match(description, /확인|검증|조회|응답|결과/, `${name} 설명에 저장 후 확인 방법이 없습니다.`)
    }

    const toolDescriptionChars = descriptions.reduce((sum, description) => sum + description.length, 0)
    const fixedSurfaceChars = budgetFixture.execDeclarationChars + toolDescriptionChars
      + budgetFixture.perToolWrapperChars * tools.length + MNP_MCP_SERVER_INSTRUCTIONS.length
    assert.equal(MNP_MCP_SERVER_INSTRUCTIONS.length, budgetFixture.serverInstructionsChars)
    assert.equal(toolDescriptionChars, budgetFixture.toolDescriptionChars)
    assert.equal(fixedSurfaceChars, budgetFixture.fixedSurfaceChars)
  } finally {
    await client.close()
  }
})
