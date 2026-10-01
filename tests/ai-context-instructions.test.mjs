import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MNP_CONTEXT_BOOTSTRAP_INSTRUCTION,
  MNP_CONTEXT_LIFECYCLE,
  MNP_MCP_SERVER_INSTRUCTIONS,
} from '../src/utils/aiContextInstructions.mjs'
import { buildAiConversationPrompt } from '../src/utils/aiConversationLaunch.mjs'
import { buildGroupDocumentInstruction } from '../server/lib/groupDocumentInstructions.mjs'

test('초기 문맥 바인딩과 이후 대상별 최신성 갱신을 구분한다', () => {
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /다른 MindNProgress 도구보다 먼저/)
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /한 번 성공적으로 호출/)
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /호출 시점의 초기 스냅샷/)
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /최신 상태 갱신만을 목적으로.*반복 호출하지/)
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /guide\.contextLifecycle/)

  assert.equal(MNP_CONTEXT_LIFECYCLE.bootstrap.tool, 'mindnprogress_get_context')
  assert.equal(MNP_CONTEXT_LIFECYCLE.bootstrap.successRequired, true)
  assert.equal(MNP_CONTEXT_LIFECYCLE.unsuccessfulAttempt.retryAllowed, true)
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.repeatGetContext, false)
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.card, 'mindnprogress_get_card')
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.document, 'mindnprogress_get_document')
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.group, 'mindnprogress_get_group_context')
  assert.match(MNP_CONTEXT_LIFECYCLE.staleWrite.action, /version 또는 SHA-256 불일치/)
  assert.match(MNP_CONTEXT_LIFECYCLE.verification.action, /실제 저장 결과/)
})

test('MCP 연결 지침은 초기 라우팅만 제공하고 상세 정책은 문맥 응답에 맡긴다', () => {
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /mindnprogress_read_me_first/)
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /mindnprogress_get_context/)
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /guide.*nextStep.*reasonCode.*message/s)
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /mindnprogress_get_group_context/)
  assert.ok(MNP_MCP_SERVER_INSTRUCTIONS.length < 1_200)
  assert.doesNotMatch(MNP_MCP_SERVER_INSTRUCTIONS, /mindnprogress_patch_card_text|mindnprogress_complete_ai_delegation|waitingItems/)
})

test('일반 AI 대화가 공통 문맥 생명주기 지침을 사용한다', () => {
  const prompt = buildAiConversationPrompt({
    mapId: 'map-test',
    cardId: 'card-test',
    editorId: 'editor-test',
    attributionToken: 'token-test',
    request: '현재 카드를 검토하세요.',
  })
  assert.ok(prompt.includes(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION))
  assert.match(prompt, /최초 `get_context` 응답과 이후 대상별 최신 조회 결과/)
})

test('그룹 문서 지시는 get_context 바인딩 뒤 그룹 문맥을 최신화한다', () => {
  const instruction = buildGroupDocumentInstruction({
    groupId: 'group-test',
    parentMapId: 'map-parent',
    targetMapId: 'map-target',
    targetCardId: 'root-target',
    targetRevision: 3,
    groupProjectVersion: 7,
    instructionId: 'instruction-test',
    instructionType: 'execution',
    approvalScope: 'card-maintenance',
    approvalEvidence: '사용자가 카드 정비 범위를 승인했습니다.',
    instruction: '승인된 카드 정비 범위만 수행하세요.',
    editorId: 'editor-test',
    attributionToken: 'token-test',
    documentCoordinatorInstruction: '문서 담당 지침',
  })
  assert.ok(instruction.includes(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION))
  assert.match(instruction, /최신성을 다시 확인할 때는 `mindnprogress_get_context`가 아니라 `mindnprogress_get_group_context`/)
})
