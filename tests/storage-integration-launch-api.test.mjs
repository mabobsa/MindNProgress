import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { doorayProposalRevision } from '../server/lib/doorayResponseDecision.mjs'

// 상위의 격리 진단 fixture를 재사용한다. 외부 Dooray와 실제 대화를 호출하지 않는다.
test('승인 대화 callback은 카드·승인 기록을 함께 연결하고 결과 조회가 완료로 수렴한다', { timeout: 60000 }, async t => {
  let workspace, revision
  const api = await storageApi(t, { documents: 3, readyTimeoutMs: 60000,
    seed: async ({ data, ids }) => {
      workspace = path.dirname(data)
      const job = { id: 'dooray-launch-fixture', userId: 'user-editor', status: 'approved', attempt: 1,
        createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z',
        source: { fingerprint: 'fixture-only', subject: '격리 연결 검증', item: { key: 'fixture', postId: 'fixture', url: 'https://example.invalid/fixture' } },
        settings: { machineId: 'isolated-storage', agentId: 'fixture-agent', modelId: 'fixture-model' },
        route: { mapId: ids[0], cardId: 'card-1', documentTitle: '격리 문서', cardTitle: '격리 카드' },
        proposal: '합성 자료의 연결 확인만 수행한다.',
        decision: { kind: 'approval', reason: '격리 재현용 승인', questions: [], approval: { title: '격리 확인', scope: ['모의 연결'], exclusions: ['운영 변경'] } } }
      revision = doorayProposalRevision(job)
      job.approval = { revision, approvedAt: '2026-10-28T00:00:00Z', approvedBy: { id: 'user-editor', name: '격리 편집자' }, proposal: job.proposal, ...job.decision.approval }
      await mkdir(path.join(data, '_dooray-responses'))
      await writeFile(path.join(data, '_dooray-responses/user-editor.json'), JSON.stringify({ jobs: [job] }))
    }, mockAion: async url => {
      if (url === '/api/agents/management') return [{ id: 'fixture-agent', name: '검증 AI', installed: true, enabled: true,
        available_models: { available_models: [{ value: 'fixture-model', name: '검증 모델' }] } }]
      if (url === '/api/conversations/approved-launch') return { id: 'approved-launch', name: '모의 생성 대화', created_at: '2026-10-28T00:00:00Z',
        extra: { agent_id: 'fixture-agent', current_model_id: 'fixture-model', workspace } }
      return []
    } })
  const launched = await api.call('/api/integrations/aionui/attributions', 'POST', { purpose: 'dooray-response', mapId: api.ids[0], cardId: 'card-1',
    agentId: 'fixture-agent', modelId: 'fixture-model', doorayApproval: { responseId: 'dooray-launch-fixture', proposalRevision: revision }, workspace, workspaceConfirmed: true })
  assert.equal(launched.status, 201)
  const callback = await fetch(launched.body.completionUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: 'approved-launch' }) })
  const callbackBody = await callback.json(), confirmations = []
  for (let i = 0; i < 3; i++) { const result = await api.call(launched.body.statusUrl); confirmations.push({ httpStatus: result.status, status: result.body.status, error: result.body.error, conversationId: result.body.conversationId }) }
  const map = await api.read(`${api.ids[0]}.json`), approvals = await api.read('_dooray-responses/user-editor.json')
  const evidence = { callback: { status: callback.status, body: callbackBody }, confirmations,
    cardConversationId: map.nodes.find(n => n.id === 'card-1').data.aiConversationId ?? null,
    approvalConversationId: approvals.jobs[0].approval.conversation?.conversationId ?? null,
    mapVersion: map.version, mapSha256: createHash('sha256').update(JSON.stringify(map)).digest('hex'),
    approvalsSha256: createHash('sha256').update(JSON.stringify(approvals)).digest('hex') }
  t.diagnostic(JSON.stringify(evidence))
  if (process.env.MNP_LAUNCH_EVIDENCE_DIR) {
    await mkdir(process.env.MNP_LAUNCH_EVIDENCE_DIR, { recursive: false })
    for (const [file, value] of Object.entries({ 'result.json': evidence, 'map.json': map, 'approval.json': approvals }))
      await writeFile(path.join(process.env.MNP_LAUNCH_EVIDENCE_DIR, file), JSON.stringify(value, null, 2))
    await writeFile(path.join(process.env.MNP_LAUNCH_EVIDENCE_DIR, 'server.log'), api.output())
  }
  assert.equal(callback.status, 200, JSON.stringify(evidence))
  assert.equal(evidence.cardConversationId, 'approved-launch')
  assert.equal(evidence.approvalConversationId, 'approved-launch')
  assert.ok(confirmations.every(c => c.status === 'completed' && c.conversationId === 'approved-launch'))
})
