import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { buildDoorayApprovalRequest, doorayProposalRevision } from '../server/lib/doorayResponseDecision.mjs'

async function fixture(t, { partial = false, invalid = '' } = {}) {
  let workspace, revision, originalRequest
  const attributionToken = 'a'.repeat(43)
  const api = await storageApi(t, { documents: 3, readyTimeoutMs: 60000, seed: async ({ data, ids }) => {
    workspace = path.dirname(data)
    const job = { id: 'dooray-launch-fixture', userId: 'user-editor', status: 'approved', attempt: 1,
      createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z',
      source: { fingerprint: 'fixture-only', subject: '격리 승인 연결', item: { key: 'fixture', postId: 'fixture', url: 'https://example.invalid/fixture' } },
      settings: { machineId: 'isolated-storage', agentId: 'fixture-agent', modelId: 'fixture-model' },
      route: { mapId: ids[0], cardId: 'card-1', documentTitle: '격리 문서', cardTitle: '격리 카드' },
      proposal: '합성 자료의 연결만 검증한다.', decision: { kind: 'approval', reason: '격리 검증', questions: [],
        approval: { title: '연결 확인', scope: ['모의 연결'], exclusions: ['운영 변경'] } } }
    revision = doorayProposalRevision(job)
    job.approval = { revision, approvedAt: job.createdAt, approvedBy: { id: 'user-editor', name: '김용민' }, proposal: job.proposal, ...job.decision.approval }
    originalRequest = buildDoorayApprovalRequest(job) + `\n- attributionToken: ${attributionToken}\n`
    if (partial) {
      job.status = 'completed'; job.completionStatus = 'approved'; job.completedAt = '2026-10-28T00:00:03Z'
      const mapPath = path.join(data, `${ids[0]}.json`), map = JSON.parse(await fs.readFile(mapPath, 'utf8'))
      const card = map.nodes.find(x => x.id === 'card-1')
      const link = { conversationId: 'approved-launch', homeMachineId: 'isolated-storage', workspace,
        startedBy: { id: 'user-editor', label: '김용민' }, startedAt: '2026-10-28T00:00:01.000Z', linkedAt: '2026-10-28T00:00:02.000Z' }
      card.data.aiConversationId = link.conversationId; card.data.aiConversations = [link]
      await fs.writeFile(mapPath, JSON.stringify(map))
      await fs.writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify([{ ...link, mapId: ids[0], cardId: 'card-1', startedBy: 'user-editor' }]))
      await fs.writeFile(path.join(data, '_ai-attributions.json'), JSON.stringify([{ tokenHash: createHash('sha256').update(attributionToken).digest('hex'),
        authorName: '검증 AI', agentId: 'fixture-agent', modelId: 'fixture-model', mapId: ids[0], cardId: 'card-1', homeMachineId: 'isolated-storage',
        startedBy: 'user-editor', conversationId: 'approved-launch', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
        selection: { workspace } }]))
      if (invalid === 'proposal') job.proposal += ' 바뀐 제안'
      if (invalid === 'approval') job.completionStatus = 'proposal'
      if (invalid === 'author') job.approval.approvedBy.id = 'user-second'
      if (invalid === 'request') originalRequest = '근거 없는 대화 ID'
    }
    await fs.mkdir(path.join(data, '_dooray-responses'))
    await fs.writeFile(path.join(data, '_dooray-responses/user-editor.json'), JSON.stringify({ jobs: [job] }))
  }, mockAion: async url => {
    if (url.includes('/messages?')) return { items: [{ id: 'original-request', conversation_id: 'approved-launch', position: 'right', type: 'text', content: originalRequest }], has_more_before: false }
    if (url === '/api/agents/management') return [{ id: 'fixture-agent', name: '검증 AI', installed: true, enabled: true,
      available_models: { available_models: [{ value: 'fixture-model', name: '검증 모델' }] } }]
    if (url.startsWith('/api/conversations/')) return { id: url.split('/').at(-1), name: '모의 생성 대화', created_at: Date.parse('2026-10-28T00:00:01Z'),
      extra: { agent_id: 'fixture-agent', current_model_id: 'fixture-model', workspace } }
    return []
  } })
  if (partial) return { ...api, repair: '/api/integrations/dooray/response-approvals/dooray-launch-fixture/repair-link',
    repairInput: { mapId: api.ids[0], cardId: 'card-1', conversationId: 'approved-launch', proposalRevision: revision },
    approval: `/api/integrations/dooray/response-approvals/dooray-launch-fixture?revision=${revision}&execution=1&conversationId=approved-launch`,
    confirmation: `/api/integrations/dooray/response-approvals/dooray-launch-fixture/confirmation?revision=${revision}` }
  const launch = await api.call('/api/integrations/aionui/attributions', 'POST', { purpose: 'dooray-response', mapId: api.ids[0], cardId: 'card-1',
    agentId: 'fixture-agent', modelId: 'fixture-model', doorayApproval: { responseId: 'dooray-launch-fixture', proposalRevision: revision },
    workspace, workspaceConfirmed: true })
  assert.equal(launch.status, 201, JSON.stringify(launch.body))
  const callback = new URL(launch.body.completionUrl).pathname
  const approval = `/api/integrations/dooray/response-approvals/dooray-launch-fixture?revision=${revision}&execution=1&conversationId=approved-launch`
  return { ...api, callback, approval, statusUrl: launch.body.statusUrl }
}

test('승인 대화의 완료·재확인은 카드·귀속·승인을 함께 확정하고 다른 주체·대화를 거부한다', async t => {
  const api = await fixture(t)
  const first = await api.call(api.callback, 'POST', { conversationId: 'approved-launch' })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  const before = await api.read(`${api.ids[0]}.json`)
  const approval = await api.read('_dooray-responses/user-editor.json')
  assert.equal(approval.jobs[0].approval.conversation.conversationId, 'approved-launch')
  assert.equal((await api.call(api.approval)).status, 200)
  assert.equal((await api.call(api.approval, 'GET', undefined, { 'X-MNP-AI-Editor-Id': 'user-second' })).status, 404)
  assert.equal((await api.call(api.callback, 'POST', { conversationId: 'other-launch' })).status, 409)
  assert.equal((await api.call(api.callback, 'POST', { conversationId: 'approved-launch' })).status, 200)
  assert.equal((await api.read(`${api.ids[0]}.json`)).version, before.version)
  assert.deepEqual((await api.read('_dooray-responses/user-editor.json')).jobs[0].approval, approval.jobs[0].approval)
  assert.equal((await api.call(api.statusUrl)).body.status, 'completed')
  assert.equal(before.nodes.find(n => n.id === 'card-1').data.aiConversations.length, 1)
})

test('완료된 기존 승인 연결만 원문·귀속 증거와 해시 조건으로 복구하고 백업·무관한 값을 보존한다', async t => {
  const api = await fixture(t, { partial: true })
  const file = '_dooray-responses/user-editor.json', raw = await fs.readFile(path.join(api.data, file), 'utf8'), before = JSON.parse(raw)
  assert.equal((await api.call(api.approval)).status, 409)
  assert.equal((await api.call(api.confirmation)).status, 409)
  assert.equal((await api.call(api.repair, 'POST', { ...api.repairInput, dryRun: true }, { 'X-MNP-AI-Editor-Id': 'user-second' })).status, 404)
  assert.equal((await api.call(api.repair, 'POST', { ...api.repairInput, conversationId: 'other-launch', dryRun: true })).status, 403)
  const preview = await api.call(api.repair, 'POST', { ...api.repairInput, dryRun: true })
  assert.equal(preview.status, 200, JSON.stringify(preview.body))
  assert.equal(preview.body.expectedStateSha256, createHash('sha256').update(raw).digest('hex'))
  const input = { ...api.repairInput, expectedStateSha256: preview.body.expectedStateSha256, expectedMapVersion: preview.body.expectedMapVersion }
  assert.equal((await api.call(api.repair, 'POST', { ...input, expectedStateSha256: '0'.repeat(64) })).status, 409)
  const barrier = await api.barrier('_dooray-responses/user-editor.json.', 'writeFile', { prefix: true, fail: true })
  const pending = api.call(api.repair, 'POST', input)
  await barrier.reached; barrier.release()
  assert.equal((await pending).status, 503)
  assert.equal(await fs.readFile(path.join(api.data, file), 'utf8'), raw)
  const result = await api.call(api.repair, 'POST', input)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(await fs.readFile(path.join(api.data, result.body.backup), 'utf8'), raw)
  const expected = structuredClone(before)
  expected.jobs[0].approval.conversation = preview.body.connection
  assert.deepEqual(await api.read(file), expected)
  assert.equal((await api.call(api.approval)).status, 200)
  assert.equal((await api.call(api.confirmation)).body.status, 'completed')
  assert.equal((await api.call(api.repair, 'POST', input)).body.replayed, true)
  assert.deepEqual(await api.read(file), expected)
  await api.restart()
  assert.equal((await api.call(api.approval)).status, 200)
  assert.equal((await api.call(api.confirmation)).body.conversationId, 'approved-launch')
})

test('승인 연결의 확정 marker 뒤 중단은 04 복구 후 카드·귀속·승인과 확인 팝업이 같은 대화로 수렴한다', async t => {
  const api = await fixture(t)
  await api.crash('after-commit')
  await assert.rejects(api.call(api.callback, 'POST', { conversationId: 'approved-launch' }))
  await api.restart()
  const card = (await api.read(`${api.ids[0]}.json`)).nodes.find(n => n.id === 'card-1')
  assert.equal(card.data.aiConversations.length, 1)
  assert.equal(card.data.aiConversations[0].conversationId, 'approved-launch')
  assert.ok((await api.read('_ai-attributions.json')).some(x => x.conversationId === 'approved-launch'))
  assert.equal((await api.call(api.approval)).status, 200)
  assert.equal((await api.call(api.approval.replace('?revision=', '/confirmation?revision='))).body.status, 'completed')
})

test('복구는 변경된 제안·무효 승인·다른 승인자·원본 요청 누락에 승인을 부여하지 않는다', async t => {
  for (const invalid of ['proposal', 'approval', 'author', 'request']) await t.test(invalid, async t => {
    const api = await fixture(t, { partial: true, invalid })
    const before = await api.read('_dooray-responses/user-editor.json')
    assert.equal((await api.call(api.repair, 'POST', { ...api.repairInput, dryRun: true })).status, 409)
    assert.deepEqual(await api.read('_dooray-responses/user-editor.json'), before)
  })
})

test('카드·귀속·승인 후보 실패는 전체를 복구하고 기존 대화 재확인으로 수렴한다', async t => {
  const api = await fixture(t)
  const before = await Promise.all([`${api.ids[0]}.json`, '_ai-attributions.json', '_ai-conversation-origins.json', '_dooray-responses/user-editor.json'].map(x => api.read(x)))
  for (const file of ['_ai-attributions.json.', `${api.ids[0]}.json.`, '_ai-conversation-origins.json.']) {
    const barrier = await api.barrier(file, 'writeFile', { prefix: true, fail: true })
    const pending = api.call(api.callback, 'POST', { conversationId: 'approved-launch' })
    await barrier.reached; barrier.release()
    assert.equal((await pending).status, 503)
    assert.deepEqual(await Promise.all([`${api.ids[0]}.json`, '_ai-attributions.json', '_ai-conversation-origins.json', '_dooray-responses/user-editor.json'].map(x => api.read(x))), before)
  }
  const barrier = await api.barrier('_dooray-responses/user-editor.json.', 'writeFile', { prefix: true, fail: true })
  const pending = api.call(api.callback, 'POST', { conversationId: 'approved-launch' })
  await barrier.reached
  assert.notEqual((await api.call(api.statusUrl)).body.status, 'completed')
  assert.equal((await api.call(`/api/maps/${api.ids[1]}/comments`, 'POST', { nodeId: 'card-1', summary: '[진행] 독립 문서 저장' })).status, 201)
  barrier.release()
  assert.equal((await pending).status, 503)
  assert.deepEqual(await Promise.all([`${api.ids[0]}.json`, '_ai-attributions.json', '_ai-conversation-origins.json', '_dooray-responses/user-editor.json'].map(x => api.read(x))), before)
  const failed = (await api.call(api.statusUrl)).body
  assert.equal(failed.status, 'confirmation-failed')
  assert.equal(failed.createdConversationId, 'approved-launch')
  assert.equal(failed.canRetry, true)
  const retry = api.statusUrl.replace(/\/status$/, '/confirm')
  assert.equal((await api.call(retry, 'POST', {}, { 'X-MNP-AI-Editor-Id': 'user-second' })).status, 403)
  const result = await api.call(retry, 'POST', {})
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal((await api.call(api.approval)).status, 200)
  assert.equal((await api.call(api.statusUrl)).body.status, 'completed')
})
