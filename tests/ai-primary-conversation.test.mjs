import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveGroupInstructionConversation as resolve, resolvePrimaryConversationPolicy } from '../server/lib/aiPrimaryConversation.mjs'
import { createGroupDocumentInstructionSignature as signature } from '../server/lib/groupDocumentInstructions.mjs'

const data = { aiPrimaryConversationId: 'opus', aiConversationId: 'codex', aiConversations: [{ conversationId: 'opus' }, { conversationId: 'codex' }] }
test('규칙과 다른 담당은 동일 모델 중 가장 최신 대화로 바꾸고 후보가 없을 때만 생성한다', async () => {
  const card = { aiPrimaryConversationId: 'current', aiConversations: [
    { conversationId: 'recent', startedAt: '2026-11-09T00:00:00Z' },
    { conversationId: 'old', startedAt: '2026-11-08T00:00:00Z' },
    { conversationId: 'current', startedAt: '2026-11-10T00:00:00Z' },
  ] }
  const rule = { modelId: 'opus' }, read = async (link) => link.conversationId === 'current' ? 'gpt-6-astra' : 'opus'
  assert.deepEqual(await resolvePrimaryConversationPolicy(card, rule, read), {
    previousConversationId: 'current', conversationId: 'recent', currentModelId: 'gpt-6-astra', expectedModelId: 'opus', strategy: 'resume',
  })
  assert.equal((await resolvePrimaryConversationPolicy(card, rule, async () => 'gpt-6-astra')).strategy, 'new')
  assert.equal(await resolvePrimaryConversationPolicy(card, rule, async () => 'opus'), null, '이미 맞는 담당은 더 최신 일치 후보가 있어도 유지한다')
  await assert.rejects(resolvePrimaryConversationPolicy(card, rule, async () => { throw Error('연결 실패') }), /연결 실패/)
})
test('그룹 지시는 최신 보조 대화가 아닌 선택된 담당에게만 전달한다', () => {
  assert.equal(resolve(data, { strategy: 'resume' }).conversationId, 'opus')
  assert.equal(resolve(data, { strategy: 'resume', conversationId: 'opus' }).valid, true)
  assert.equal(resolve(data, { strategy: 'resume', conversationId: 'codex' }).reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_PRIMARY_CONVERSATION_MISMATCH')
  assert.equal(resolve(data, { strategy: 'new' }).valid, false)
  assert.equal(resolve({}, { strategy: 'new' }).valid, true)
  assert.equal(resolve({ ...data, aiPrimaryConversationId: null }, { strategy: 'resume' }).valid, false)
  assert.equal(resolve({ ...data, aiPrimaryConversationId: 'missing' }, { strategy: 'resume' }).valid, false)
})
test('명시적인 보조 AI 지시는 사용자 요청 근거와 연결된 대화가 필요하다', () => {
  const request = { strategy: 'resume', targetConversationRole: 'auxiliary', conversationId: 'codex' }
  assert.equal(resolve(data, request).valid, false)
  assert.equal(resolve(data, { ...request, overrideEvidence: '사용자가 이번 버그 조사를 Codex에 요청했습니다.' }).valid, true)
  assert.equal(resolve(data, { ...request, conversationId: 'missing', overrideEvidence: '사용자 요청' }).valid, false)
  assert.notEqual(signature(request), signature({ ...request, targetConversationRole: 'primary' }))
  assert.equal(signature({ strategy: 'resume' }), signature({ strategy: 'resume', targetConversationRole: 'primary' }))
})
