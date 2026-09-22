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
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /진입 상태는 `selected`/)
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /성공 뒤에는.*반복하지/s)
  assert.match(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, /guide\.contextLifecycle/)

  assert.equal(MNP_CONTEXT_LIFECYCLE.binding.state, 'bound')
  assert.match(MNP_CONTEXT_LIFECYCLE.binding.snapshot, /호출 시점의 스냅샷/)
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.repeatGetContext, false)
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.card, 'mindnprogress_get_card')
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.document, 'mindnprogress_get_document')
  assert.equal(MNP_CONTEXT_LIFECYCLE.refresh.group, 'mindnprogress_get_group_context')
  assert.match(MNP_CONTEXT_LIFECYCLE.writeSafety.stale, /불일치하면 저장하지 않고/)
  assert.match(MNP_CONTEXT_LIFECYCLE.writeSafety.verify, /실제 저장 결과/)
})

test('MCP 연결 지침은 초기 라우팅만 제공하고 상세 정책은 문맥 응답에 맡긴다', () => {
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /mindnprogress_read_me_first/)
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /mindnprogress_get_context/)
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /reasonCode.*message/s)
  assert.equal(MNP_MCP_SERVER_INSTRUCTIONS.split('mindnprogress_get_context').length - 1, 1)
  assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /approval-first.*selected.*unselected/s)
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
  assert.match(prompt, /실행 상태: `new`/)
  assert.match(prompt, /전용 workflow의 쓰기 정책이 일반 기록 지시보다 우선/)
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
    strategy: 'new',
  })
  assert.match(instruction, /아직 바인딩되지 않았다면.*get_context.*한 번 성공/s)
  assert.match(instruction, /역할 원문은 get_group_context의 guide\.documentCoordinator 한 곳/)
  assert.doesNotMatch(instruction, /이 작업은 그룹 문서 최상위 카드의 분석·조정 업무입니다/)
})
