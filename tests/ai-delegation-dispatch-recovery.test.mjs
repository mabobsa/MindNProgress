import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { verifyAiDelegationOriginalMessage } from '../server/lib/aiDelegationDispatchRecovery.mjs'
import { originalDelegationMessage } from './helpers/aiDelegationOriginalMessage.mjs'

function fixture() {
  const delegation = { mapId: 'map-a', targetCardId: 'card-a', startedBy: 'user-a', strategy: 'new',
    pendingInstruction: '기존 분석 결과를 검증하고 보고하세요.\n구현은 승인하지 않았습니다.',
    workspaceLease: { workspaceId: 'worker-a', jobId: 'job-a', leaseId: 'lease-a', projectRoot: 'C:\\test\\worker',
      branch: 'mnp/job-a', baseCommit: 'commit-a', startedAt: '2026-09-11T12:00:00.000Z' } }
  delegation.instructionHash = createHash('sha256').update(delegation.pendingInstruction).digest('hex')
  const origin = { conversationId: 'conversation-a', mapId: delegation.mapId, cardId: delegation.targetCardId,
    startedBy: delegation.startedBy, linkedAt: '2026-09-11T12:00:02.000Z' }
  const message = originalDelegationMessage(delegation)
  const conversation = { id: origin.conversationId, created_at: message.created_at - 1, extra: { workspace: delegation.workspaceLease.projectRoot } }
  return { delegation, origin, conversation, message }
}

test('만료된 operation은 최초 사용자 전문·해시·불변 시작 카드·작업공간의 일치만 복구 근거로 반환한다', () => {
  const { delegation, origin, conversation, message } = fixture()
  const proof = verifyAiDelegationOriginalMessage(delegation, origin, conversation, message)
  assert.equal(proof.conversationId, conversation.id)
  assert.equal(proof.recoveryProof.kind, 'original-message-after-operation-expiry')
  assert.equal(proof.recoveryProof.messageId, message.id)
  assert.equal(proof.recoveryProof.instructionHash, delegation.instructionHash)
  assert.equal(proof.state, undefined, '과거 실행의 완료 상태를 추측하지 않는다.')
  assert.equal(proof.instruction, undefined, '인증 정보가 포함될 수 있는 전문을 반환하지 않는다.')
})

test('Windows 경로 표기와 메시지 줄바꿈 차이는 같은 원본으로 확인한다', () => {
  const { delegation, origin, conversation, message } = fixture()
  conversation.extra.workspace = 'c:/test/worker/'
  message.content.content = message.content.content.replaceAll('\n', '\r\n')
  assert.ok(verifyAiDelegationOriginalMessage(delegation, origin, conversation, message))
})

for (const [label, mutate] of [
  ['다른 시작 카드', (f) => { f.origin.cardId = 'other-card' }],
  ['다른 문서', (f) => { f.origin.mapId = 'other-map' }],
  ['다른 시작 편집자', (f) => { f.origin.startedBy = 'other-user' }],
  ['다른 대화', (f) => { f.origin.conversationId = 'other-conversation' }],
  ['원래부터 재개 방식인 실행', (f) => { f.delegation.strategy = 'resume' }],
  ['만료 뒤 수정된 지시 해시', (f) => { f.delegation.instructionHash = 'changed' }],
  ['저장 지시 변조', (f) => { f.delegation.pendingInstruction += '\n추가 구현' }],
  ['메시지 지시 변조', (f) => { f.message.content.content += '\n추가 구현' }],
  ['다른 배정 ID', (f) => { f.delegation.workspaceLease.leaseId = 'other-lease' }],
  ['다른 배정 브랜치', (f) => { f.delegation.workspaceLease.branch = 'other-branch' }],
  ['다른 기준 커밋', (f) => { f.delegation.workspaceLease.baseCommit = 'other-commit' }],
  ['다른 실제 작업공간', (f) => { f.conversation.extra.workspace = 'C:\\other' }],
  ['AI 답변에 인용된 전문', (f) => { f.message.position = 'left' }],
  ['중복 위임 헤더', (f) => { f.message.content.content = f.message.content.content.replace('- cardId: `card-a`', '- cardId: `card-a`\n- cardId: `card-a`') }],
  ['복수 지시 영역', (f) => { f.message.content.content += '\n# 상위 AI 지시\n\n추가' }],
  ['메시지 ID 누락', (f) => { delete f.message.id }],
  ['메시지 시각 누락', (f) => { delete f.message.created_at }],
  ['메시지 시각 오류', (f) => { f.message.created_at = 'unknown' }],
  ['대화 생성 전 메시지', (f) => { f.message.created_at = f.conversation.created_at - 1 }],
  ['나중에 추가된 메시지', (f) => { f.message.created_at += 300_000 }],
  ['실행보다 오래된 대화', (f) => { f.conversation.created_at -= 10_000 }],
  ['늦게 생성된 다른 대화', (f) => { f.conversation.created_at += 300_000 }],
]) test(`만료 복구 거부: ${label}`, () => {
  const f = fixture()
  mutate(f)
  assert.throws(() => verifyAiDelegationOriginalMessage(f.delegation, f.origin, f.conversation, f.message), { code: 'AI_DELEGATION_ORIGINAL_MESSAGE_UNCONFIRMED' })
})
