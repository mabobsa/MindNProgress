import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  AI_EXECUTION_APPROVAL_INSTRUCTION,
  GROUP_APPROVAL_INSTRUCTION,
  GROUP_COORDINATOR_INSTRUCTION,
  DOCUMENT_COORDINATOR_INSTRUCTION,
  AI_DELEGATION_FOLLOWUP_INSTRUCTION,
  buildGroupCoordinatorRequest,
  buildGroupDocumentRequest,
  buildGroupDocumentProposalRequest,
} from '../src/utils/aiApprovalInstructions.mjs'
import { AI_EDITOR_REQUEST_MAX_LENGTH, buildAiConversationPrompt, normalizeAiEditorRequest, DEFAULT_AI_EDITOR_REQUEST } from '../src/utils/aiConversationLaunch.mjs'

test('총괄 시작은 전체 방향과 문서별 실행을 각각 사용자에게 승인받는다', () => {
  const request = buildGroupCoordinatorRequest({ groupId: 'group-test' })
  assert.match(request, /groupId="group-test"/)
  assert.ok(request.includes(GROUP_COORDINATOR_INSTRUCTION))
  assert.ok(request.includes(GROUP_APPROVAL_INSTRUCTION))
  assert.match(request, /1\. 전체 방향 제안/)
  assert.match(request, /2\. 문서별 실행 계획 제안/)
  assert.match(request, /전체 방향 승인은 문서별 실행의 일괄 승인이 아닙니다/)
  assert.match(request, /일부 문서만 승인되면 나머지는 대기/)
  assert.match(request, /원본 요구사항 전수 등록.*주 소유권 확정.*구현을 위임하지/)
})

test('위임 제안 버튼은 식별자와 제안 범위를 전달하지만 실행을 승인하지 않는다', () => {
  const instruction = buildGroupDocumentProposalRequest({ mapId: 'map-lobby', cardId: 'root-lobby', title: '획득·로비' })
  const request = buildGroupCoordinatorRequest({ groupId: 'group-test', instruction })
  assert.match(request, /targetMapId: map-lobby, targetCardId: root-lobby/)
  assert.match(request, /문서별 사용자 승인 전에는 루트 수정이나 AI 위임을 하지 마세요/)
  assert.match(request, /이 버튼 요청은 실행 승인이 아니라 제안 요청입니다/)
  assert.ok(request.includes(GROUP_APPROVAL_INSTRUCTION))
})

test('문서 담당은 총괄의 지시가 아닌 실제 사용자 승인과 하위 위임 허용 범위를 확인한다', () => {
  const request = buildGroupDocumentRequest({ groupId: 'group-test', groupName: '매니저' })
  assert.ok(request.includes(DOCUMENT_COORDINATOR_INSTRUCTION))
  assert.ok(request.includes(AI_EXECUTION_APPROVAL_INSTRUCTION))
  assert.match(request, /전체 방향 승인과 이 문서의 실행 계획 승인 근거가 모두 확인/)
  assert.match(request, /총괄 AI의 요청만으로 사용자 승인을 대신하지 마세요/)
  assert.match(request, /분석·제안만 허용된 경우 읽기 전용/)
  assert.match(request, /사용자가 하위 구현 위임까지 승인한 경우에만/)
  assert.match(request, /수정안을 총괄에 반환하여 사용자 재승인/)
})

test('승인 대기는 대화로만 보고하며 확정 기록이나 완료 상태를 만들지 않는다', () => {
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /댓글·공유 지식·대기 항목 변경도 별도 승인 없이는 하지/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /확인하지 못한 승인 발언·식별자를 만들어내지/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /사용자의 무응답은 사용자 승인이 아닙니다/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /승인 대기는 정상적인 종료 지점/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /승인 대기를 이유로 업무를 done\/100%로 바꾸지/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /계획 안의 세부 구현·검증은 매번 재승인받지 않아도/)
})

test('결과 회수는 승인된 남은 작업만 이어가고 제안 완료를 실행 승인으로 해석하지 않는다', () => {
  assert.match(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /자동 재개는 다음 작업의 사용자 승인이 아닙니다/)
  assert.match(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /이미 사용자에게 승인된 범위.*게이트가 충족된 경우에만/)
  assert.match(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /completed여도 개발 완료나 후속 실행 승인으로 해석하지/)
  assert.match(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /수정안을 스스로 승인하지 말고 사용자에게 전달/)
})

test('최대 길이의 그룹·문서 식별자에서도 승인 규칙과 마지막 검수 지침이 잘리지 않는다', () => {
  const requests = [
    buildGroupCoordinatorRequest({ groupId: 'group-' + 'g'.repeat(100) }),
    buildGroupCoordinatorRequest({ groupId: 'group-' + 'g'.repeat(100), instruction: buildGroupDocumentProposalRequest({ mapId: 'm'.repeat(120), cardId: 'c'.repeat(120), title: '문'.repeat(80) }) }),
    buildGroupDocumentRequest({ groupId: 'group-' + 'g'.repeat(100), groupName: '그'.repeat(80) }),
  ]
  for (const request of requests) {
    assert.ok(request.length <= AI_EDITOR_REQUEST_MAX_LENGTH)
    assert.equal(normalizeAiEditorRequest(request), request)
    const prompt = buildAiConversationPrompt({ mapId: 'map-test', cardId: 'root-test', editorId: 'editor-test', attributionToken: 'fixture-token', request })
    assert.ok(prompt.includes(AI_EXECUTION_APPROVAL_INSTRUCTION))
    assert.ok(prompt.endsWith(request))
  }
  assert.match(DEFAULT_AI_EDITOR_REQUEST, /자동 적용된 이 문구 자체는 변경 승인이 아닙니다/)
  assert.match(DEFAULT_AI_EDITOR_REQUEST, /실제 사용자가 승인한 정비 범위에서만/)
})

test('서버·MCP 전문의 무조건 실행 문구가 재개 경로에 남지 않는다', async () => {
  for (const file of ['../server/index.mjs', '../mcp/server.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8')
    assert.ok(source.includes('AI_EXECUTION_APPROVAL_INSTRUCTION'))
    assert.ok(source.includes('AI_DELEGATION_FOLLOWUP_INSTRUCTION'))
    assert.doesNotMatch(source, /일반적인 다음 작업 제안에 그치지 말고/)
    assert.doesNotMatch(source, /다음 작업을 위임하기로 판단했다면/)
    assert.doesNotMatch(source, /일반적인 다음 작업 제안 문구를 보내지 마세요/)
    assert.doesNotMatch(source, /하위 AI가 제안에 그치지 않고 실제로 수행할/)
  }
})
