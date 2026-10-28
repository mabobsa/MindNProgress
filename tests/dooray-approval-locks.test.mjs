import assert from 'node:assert/strict'
import test from 'node:test'
import { createStorageResources } from '../server/lib/storageResources.mjs'
import { createDoorayResponseService } from '../server/lib/doorayResponses.mjs'
import { doorayProposalRevision } from '../server/lib/doorayResponseDecision.mjs'

test('사용자 갱신이 기다리는 동안 callback의 중첩 승인 저장은 같은 잠금을 재사용한다', { timeout: 8000 }, async () => {
  const resources = createStorageResources(), key = 'state:_dooray-responses/user-editor.json'
  const job = { id: 'approved', userId: 'user-editor', status: 'approved', createdAt: '2026-10-28T00:00:00Z',
    settings: { machineId: 'fixture', agentId: 'fixture', modelId: 'fixture' },
    source: { fingerprint: 'fixture', subject: '격리 승인', item: { url: 'https://example.invalid' } },
    proposal: '기존 연결 확인', decision: { kind: 'approval', reason: '검증', questions: [],
      approval: { title: '격리', scope: ['연결 확인'], exclusions: ['외부 업무 실행'] } } }
  const revision = doorayProposalRevision(job)
  job.approval = { revision, approvedAt: job.createdAt, approvedBy: { id: job.userId, name: '검증 편집자' }, proposal: job.proposal, ...job.decision.approval }
  let state = { jobs: [job] }, entered
  const queued = new Promise(resolve => { entered = resolve })
  const service = createDoorayResponseService({ directory: '/fixture', user: async id => ({ id, name: '검증 편집자' }),
    read: async () => structuredClone(state), write: async (_file, value) => { state = structuredClone(value) },
    withRead: (_file, action) => resources.withResources([{ key, mode: 'read' }], action),
    withMutation: (_file, action) => { entered(); return resources.withResources([key], action) } })
  const connection = { conversationId: 'original-conversation', linkedAt: '2026-10-28T00:00:01Z' }
  let waiting
  await resources.withResources([key], async () => {
    waiting = resources.detached(() => service.approve(job.userId, job.id, revision))
    await queued
    assert.equal(resources.pending().find(x => x.key === key).pending, 1)
    await service.linkApprovalConversation(job.userId, job.id, revision, connection)
    assert.deepEqual(state.jobs[0].approval.conversation, connection)
  })
  await waiting
  assert.deepEqual(state.jobs[0].approval.conversation, connection)
  assert.deepEqual(resources.pending(), [])

  state.jobs[0].status = 'completed'; state.jobs[0].completionStatus = 'approved'; state.jobs[0].completedAt = '2026-10-28T00:00:02Z'
  const completed = structuredClone(state)
  await service.linkApprovalConversation(job.userId, job.id, revision, connection)
  assert.deepEqual(state, completed, '목록 완료 후 같은 대화의 재확인은 상태·승인을 변경하지 않는다')
  await assert.rejects(service.linkApprovalConversation(job.userId, job.id, revision, { ...connection, conversationId: 'another' }), { status: 409 })
})
