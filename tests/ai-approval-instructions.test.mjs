import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AI_EXECUTION_APPROVAL_INSTRUCTION,
  GROUP_APPROVAL_INSTRUCTION,
  GROUP_COORDINATOR_APPROVAL_BOOTSTRAP_INSTRUCTION,
  GROUP_COORDINATOR_INSTRUCTION,
  AI_DELEGATION_FOLLOWUP_INSTRUCTION,
  GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION,
  buildGroupCoordinatorRequest,
  buildGroupDocumentRequest,
  buildGroupDocumentProposalRequest,
} from '../src/utils/aiApprovalInstructions.mjs'
import { AI_EDITOR_REQUEST_MAX_LENGTH, buildAiConversationPrompt, normalizeAiEditorRequest, DEFAULT_AI_EDITOR_REQUEST } from '../src/utils/aiConversationLaunch.mjs'

test('총괄 시작은 전체 방향과 문서별 실행을 각각 사용자에게 승인받는다', () => {
  const request = buildGroupCoordinatorRequest({ groupId: 'group-test' })
  assert.match(request, /groupId="group-test"/)
  assert.match(request, /역할: group coordinator/)
  assert.doesNotMatch(request, /이 문서는 그룹 전체의 기획과 개발을 총괄합니다/)
  assert.ok(request.includes(GROUP_COORDINATOR_APPROVAL_BOOTSTRAP_INSTRUCTION))
  assert.ok(!request.includes(AI_EXECUTION_APPROVAL_INSTRUCTION))
  assert.ok(!request.includes(GROUP_APPROVAL_INSTRUCTION))

  const prompt = buildAiConversationPrompt({ purpose: 'group-coordination', mapId: 'map', cardId: 'root', editorId: 'editor', attributionToken: 'token', request })
  assert.equal(prompt.split(AI_EXECUTION_APPROVAL_INSTRUCTION).length - 1, 0)
  assert.equal(prompt.split(GROUP_APPROVAL_INSTRUCTION).length - 1, 0)
  assert.match(prompt, /workflow: `group-coordination`/)
  assert.match(prompt, /writePolicy: `approval-required`/)
  assert.match(prompt, /mindnprogress_get_group_context의 현재 역할 guide/)
})

test('문서 지시 제안 버튼은 식별자와 제안 범위를 전달하지만 실행을 승인하지 않는다', () => {
  const instruction = buildGroupDocumentProposalRequest({ mapId: 'map-lobby', cardId: 'root-lobby', title: '획득·로비' })
  const request = buildGroupCoordinatorRequest({ groupId: 'group-test', instruction })
  assert.match(request, /targetMapId: map-lobby, targetCardId: root-lobby/)
  assert.match(request, /workflow: proposal-only/)
  assert.match(request, /writePolicy: forbidden/)
  assert.match(request, /지시·AI 위임을 실행하지 마세요/)
  assert.ok(request.includes(GROUP_COORDINATOR_APPROVAL_BOOTSTRAP_INSTRUCTION))
  assert.ok(!request.includes(GROUP_APPROVAL_INSTRUCTION))
})

test('총괄 역할 지침은 승인 정책 전문을 복제하지 않는다', () => {
  assert.ok(!GROUP_COORDINATOR_INSTRUCTION.includes(AI_EXECUTION_APPROVAL_INSTRUCTION))
  assert.ok(!GROUP_COORDINATOR_INSTRUCTION.includes(GROUP_APPROVAL_INSTRUCTION))
})

test('문서 담당은 그룹 승인 전문 없이 맡긴 범위를 수행하고 최신 원본 검토를 유지한다', () => {
  const request = buildGroupDocumentRequest({ groupId: 'group-test', groupName: '매니저' })
  assert.match(request, /역할: document coordinator/)
  assert.match(request, /guide\.documentCoordinator의 역할 원문/)
  assert.doesNotMatch(request, /이 작업은 그룹 문서 최상위 카드의 분석·조정 업무입니다/)
  assert.ok(!request.includes(AI_EXECUTION_APPROVAL_INSTRUCTION))
  assert.ok(!request.includes(GROUP_APPROVAL_INSTRUCTION))
})

test('승인 대기는 대화로만 보고하며 확정 기록이나 완료 상태를 만들지 않는다', () => {
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /댓글·공유 지식·대기 항목 변경도 별도 승인 없이는 하지/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /확인하지 못한 승인 발언·식별자를 만들어내지/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /사용자의 무응답은 사용자 승인이 아닙니다/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /승인 대기는 정상적인 종료 지점/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /승인 대기를 이유로 업무를 done\/100%로 바꾸지/)
  assert.match(AI_EXECUTION_APPROVAL_INSTRUCTION, /계획 안의 세부 구현·검증은 매번 재승인받지 않아도/)
})

test('그룹 총괄 결과 회수는 승인된 남은 작업만 이어가고 제안 완료를 실행 승인으로 해석하지 않는다', () => {
  assert.match(GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION, /자동 재개는 다음 작업의 사용자 승인이 아닙니다/)
  assert.match(GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION, /이미 사용자에게 승인된 범위.*게이트가 충족된 경우에만/)
  assert.match(GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION, /completed여도 개발 완료나 후속 실행 승인으로 해석하지/)
  assert.match(GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION, /수정안을 스스로 승인하지 말고 사용자에게 전달/)
})

test('일반 결과 회수는 실제 산출물 검증 뒤 맡긴 범위의 후속 작업을 수행한다', () => {
  assert.match(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /실제 카드와 산출물을 기준으로 검증/)
  assert.match(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /다음 작업을 위임하기로 판단했다면.*실제로 호출하고 성공 결과/)
  assert.match(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /분석·제안만 요청받았다면 구현으로 확대하지/)
  assert.doesNotMatch(AI_DELEGATION_FOLLOWUP_INSTRUCTION, /사용자 승인|승인 대기|두 단계 승인/)
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
    const groupCoordinator = request.includes('역할: group coordinator')
    const prompt = buildAiConversationPrompt({ purpose: groupCoordinator ? 'group-coordination' : 'card', mapId: 'map-test', cardId: 'root-test', editorId: 'editor-test', attributionToken: 'fixture-token', request })
    assert.equal(prompt.includes('writePolicy: `approval-required`'), groupCoordinator)
    assert.ok(prompt.endsWith(request))
  }
  assert.match(DEFAULT_AI_EDITOR_REQUEST, /필요한 필드만 먼저 수정하고 저장 결과를 확인/)
  assert.match(DEFAULT_AI_EDITOR_REQUEST, /결과 중심 체크리스트를 생성하거나 갱신/)
  assert.doesNotMatch(DEFAULT_AI_EDITOR_REQUEST, /승인|읽기 전용/)
})

test('그룹 시작 용도는 요청을 직접 바꿔도 승인을 유지하고 일반 용도에는 주입하지 않는다', () => {
  for (const purpose of ['card', 'shared-knowledge-review', 'document-reconstruction', 'card-layout', 'group-coordination']) {
    const prompt = buildAiConversationPrompt({ purpose, mapId: 'map', cardId: 'root', editorId: 'editor', attributionToken: 'token', request: '현재 상태를 분석해 주세요.' })
    assert.equal(prompt.includes('writePolicy: `approval-required`'), purpose === 'group-coordination')
    assert.equal(prompt.includes(AI_EXECUTION_APPROVAL_INSTRUCTION), false)
    assert.equal(prompt.includes(GROUP_APPROVAL_INSTRUCTION), false)
    assert.ok(prompt.endsWith('현재 상태를 분석해 주세요.'))
  }
})

test('Dooray 승인 대화는 일반 승인 대기를 넣지 않고 전용 서버 승인 검증을 유지한다', () => {
  const input = { purpose: 'dooray-response', editorId: 'editor', attributionToken: 'token', request: '승인한 제안을 진행하세요.' }
  assert.throws(() => buildAiConversationPrompt(input), /승인 근거가 없습니다/)
  const prompt = buildAiConversationPrompt({ ...input, doorayApproval: { responseId: 'response', proposalRevision: 'revision' } })
  assert.match(prompt, /mindnprogress_get_dooray_response_approval/)
  assert.match(prompt, /서버 승인과 허용·제외 범위/)
  assert.ok(!prompt.includes(AI_EXECUTION_APPROVAL_INSTRUCTION))
  assert.ok(!prompt.includes(GROUP_APPROVAL_INSTRUCTION))
})
