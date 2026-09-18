import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
const restoredToolContracts = {
  mindnprogress_add_card: /waitingItems.*둘 이상.*checklist.*하위 업무와 중복하지/s,
  mindnprogress_apply_shared_knowledge_review: /cleaned와 replacement.*replacement 없이 accepted-long/s,
  mindnprogress_create_mindmap: /둘 이상.*checklist.*하위 업무와 중복하지/s,
  mindnprogress_finalize_ai_coordination: /한도에 막힌.*완료된 후속 위임.*superseded.*list_ai_delegations/s,
  mindnprogress_retry_ai_delegation_report: /해시·실행 턴 무결성.*원문 미포함 메타데이터/s,
  mindnprogress_rollback_reconstruction: /사용자가 승인한 전환.*get_reconstructions/s,
  mindnprogress_send_group_document_instruction: /worker를 배정하는 하위 업무 위임은 아닙니다.*대기열.*queued·delivered·replied/s,
  mindnprogress_set_document_archive: /사용자가 보관·복원 범위를 승인.*version·lifecycleVersion.*list_archived_documents/s,
  mindnprogress_submit_reconstruction_proposal: /mode·baseline·newSource·mapIds.*get_reconstruction_context.*전수 대응표/s,
  mindnprogress_supersede_ai_delegation: /failed-clean 또는 cancelled.*보존할 변경이 없는 경우.*list_ai_delegations/s,
  mindnprogress_update_group_project: /sources는 전체 목록 교체.*기존 항목과 ID.*생략하면 유지, 빈 배열은 전체 제거.*get_group_context/s,
}
// ac3390d의 raw listTools 설명. 구현 전 고유 문구 유실·모호 판정의 비교 기준이다.
const beforeToolProse = {
  mindnprogress_add_card: '카드 또는 하위 카드를 추가합니다. checklist가 있으면 완료 비율로 progress와 status를 계산하고 별도 하위 업무는 중복하지 않습니다. affected 응답의 created card를 확인하고 필요하면 get_card로 저장 결과를 검증하세요.',
  mindnprogress_apply_shared_knowledge_review: '검토 결과를 문서에 원자 저장합니다. 모든 SHA-256과 문서 버전이 맞아야 하며 하나라도 다르면 전부 저장하지 않습니다. Ref 카드는 제외합니다. 저장 후 get_card/get_document로 replacement와 검토 상태를 확인하세요.',
  mindnprogress_create_mindmap: '새 문서와 계층을 원자 생성하고 자동 배치합니다. 루트는 정확히 한 건이며 checklist가 있으면 진행률을 자동 계산합니다. 반환된 문서 ID를 get_document로 확인하세요.',
  mindnprogress_finalize_ai_coordination: '사용자가 명시한 경우에만 결과가 보존된 coordination-only 위임을 종료해 상위 AI에 전달합니다. 카드·대기·실제 하위 상태는 바꾸지 않고 하위 AI도 재실행하지 않습니다. 일반 구현·결과 없는 실행에는 사용할 수 없으며 list_ai_delegations로 종료 결과를 확인하세요.',
  mindnprogress_retry_ai_delegation_report: '사용자 요청과 기존 승인 범위 안에서 완료됐지만 상위 보고만 실패한 위임 결과를 다시 전달합니다. 하위 작업은 재실행하지 않으며 캡처 원문 무결성이 맞지 않으면 다른 응답으로 대체하지 않습니다. 실행 후 list_ai_delegations에서 보고 상태와 resultHash를 확인하세요.',
  mindnprogress_rollback_reconstruction: '승인된 전환만 되돌립니다. 후속 문서나 댓글이 바뀌면 거부하며 원본을 복원하고 후속 문서는 보관합니다. get_reconstructions와 list_archived_documents로 확인하세요.',
  mindnprogress_send_group_document_instruction: '그룹 총괄 루트 AI가 같은 그룹의 문서 루트 AI에 사용자 승인 범위의 지시를 전달합니다. 먼저 get_group_context에서 그룹·대상 버전과 두 단계 승인 범위를 확인하세요. resume은 최신 contextHealth.assessmentId가 필요하며 서버가 전달 직전에 재평가합니다. 응답의 reasonCode와 message를 함께 처리하고, queued·delivered·replied를 완료로 해석하지 마세요. 저장 후 list_group_document_instructions로 상태와 결과를 확인하세요.',
  mindnprogress_set_document_archive: '승인된 문서만 최신 version·lifecycleVersion으로 보관하거나 복원합니다. AI 작업 미종료·상태 불명·그룹 총괄은 보관하지 않습니다. list_archived_documents와 get_group_context로 결과를 확인하세요.',
  mindnprogress_submit_reconstruction_proposal: '요청 범위와 전수 대응표를 정리 제안함에만 저장하며 원본은 바꾸지 않습니다. approval 입력은 금지됩니다. get_reconstruction_request로 revision과 저장안을 확인하세요.',
  mindnprogress_supersede_ai_delegation: '사용자가 명시적으로 요청한 경우에만 한도·용량 부족으로 끝난 과거 위임을 같은 카드의 성공한 후속 위임으로 대체 종료합니다. 과거 작업공간에 보존할 변경이 없어야 하며 카드 수정이나 AI 재실행 없이 감사 이력만 기록합니다. 실행 후 list_ai_delegations로 두 위임 상태를 확인하세요.',
  mindnprogress_update_group_project: '승인된 범위에서 최신 project.version으로 그룹 기준을 수정합니다. sources는 전체 교체이며 구버전 source 필드와 함께 보내지 않습니다. createCoordinator는 문서를 만들지만 AI를 실행하지 않습니다. get_group_context를 재조회해 장문과 버전을 비교하세요.',
}

function countSchemaDescriptions(value) {
  if (!value || typeof value !== 'object') return 0
  return (typeof value.description === 'string' ? 1 : 0)
    + Object.values(value).reduce((sum, child) => sum + countSchemaDescriptions(child), 0)
}

test('59개 MCP 도구의 고유 설명은 보완 기준과 같고 이름·input schema는 이전 기준선과 같다', async () => {
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
    assert.equal(tools.length, 59)
    assert.equal(createHash('sha256').update(JSON.stringify(tools.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest('hex'), '5beb90c211a2bdcf2966215ec45788750e8bd8ff5101cc20d13670f2ad38313e')
    assert.equal(tools.reduce((sum, tool) => sum + countSchemaDescriptions(tool.inputSchema), 0), budgetFixture.schemaDescriptionCount)

    const descriptions = tools.map((tool) => tool.description)
    assert.equal(new Set(descriptions).size, 59)
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
    for (const [name, expected] of Object.entries(restoredToolContracts)) {
      const after = tools.find((tool) => tool.name === name)?.description ?? ''
      assert.notEqual(after, beforeToolProse[name], `${name}의 구현 전 설명이 유지됐습니다.`)
      assert.match(after, expected, `${name}의 고유 계약이 누락됐습니다.`)
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
