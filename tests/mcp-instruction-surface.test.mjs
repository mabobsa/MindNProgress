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
const criticalToolDescriptions = {
  mindnprogress_restore_history: '선택한 변경 이력으로 문서 전체를 복원합니다. 복원 직전 get_document로 현재 문서를 백업하세요. 복원은 현재 문서 전체를 교체해 현재 변경을 잃을 수 있고, 복원 자체가 새 변경 이력을 만듭니다. 먼저 list_history에서 revisionId를 확인하고 복원 후 get_document와 list_history로 결과를 재조회해 검증하세요.',
  mindnprogress_recover_ai_delegation: '원래 맡긴 범위에서 현재 상태와 미완료 부분을 확인하세요. 그룹 총괄 AI가 범위를 변경하려면 사용자 승인을 먼저 확인합니다. AionCore 재시작, 연결 끊김 또는 필수 체크포인트·통합 실패로 recovery-required 또는 integration-recovery-required가 된 AI 위임을 기존 대화와 기존 작업공간에서 명시적으로 재개합니다. parent-wake-failed는 list_ai_delegations가 recoveryAvailable=true를 반환하고 사용자가 사용량·요청 한도 또는 모델 용량 부족 해소를 확인한 경우에만 같은 방식으로 재개할 수 있습니다. waiting-usage-limit, waiting-rate-limit, waiting-model-capacity도 같은 조건으로 재개하며 worker가 없는 문서 조정 위임도 지원합니다. waiting-child-resume은 사용자가 중지 후 재개를 요청한 경우에만 처리합니다. 접수 여부가 불명확하면 새 실행을 만들지 말고 mindnprogress_refresh_ai_delegation으로 확인하세요. 원래 지시를 자동 재생하지 않으며, 현재 카드·Git·작업공간 상태를 확인한 뒤 미완료 부분만 수행하도록 새 복구 지시를 전달합니다. 복구 호출 후 mindnprogress_list_ai_delegations로 실제 상태를 확인하세요.',
  mindnprogress_update_document_info: '문서 이름이나 아이콘 색상을 변경합니다. get_document에서 확인한 최신 baseVersion을 사용하세요. force=true는 동시 변경 덮어쓰기를 사용자가 명시적으로 승인한 경우에만 사용할 수 있습니다. 저장 후 get_document로 버전과 값을 재조회해 확인하세요.',
}

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
    for (const [name, expected] of Object.entries(criticalToolDescriptions)) {
      assert.equal(tools.find((tool) => tool.name === name)?.description, expected, `${name}의 안전 계약 전문이 변경됐습니다.`)
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
