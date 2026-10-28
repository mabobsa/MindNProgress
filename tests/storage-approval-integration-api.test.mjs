import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { approvalIntegrationFixture } from './helpers/approval-integration-fixture-07.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
async function launchFixture(t, options) {
  const { api, workspace, revision } = await approvalIntegrationFixture(t, options)
  const launch = await api.call('/api/integrations/aionui/attributions', 'POST', {
    purpose: 'dooray-response', mapId: api.ids[0], cardId: 'card-1', agentId: 'fixture-agent', modelId: 'fixture-model',
    doorayApproval: { responseId: 'dooray-launch-fixture', proposalRevision: revision }, workspace, workspaceConfirmed: true,
  })
  assert.equal(launch.status, 201)
  return { ...api, callback: new URL(launch.body.completionUrl).pathname,
    confirmation: `/api/integrations/dooray/response-approvals/dooray-launch-fixture/confirmation?revision=${revision}` }
}
const complete = api => api.call(api.callback, 'POST', { conversationId: 'approved-launch' })
async function records(api) {
  const root = path.join(api.data, '_storage-transactions'), result = []
  for (const name of await readdir(root)) {
    try { result.push(JSON.parse(await readFile(path.join(root, name, 'intent.json'), 'utf8'))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return result.filter(record => record.files.some(file => file.path === '_dooray-responses/user-editor.json')
    && record.files.some(file => file.path === 'map-bench-0.json'))
}
async function evidence(name, value) {
  if (!process.env.MNP_APPROVAL_API_ARTIFACTS) return
  await mkdir(process.env.MNP_APPROVAL_API_ARTIFACTS, { recursive: true })
  await writeFile(path.join(process.env.MNP_APPROVAL_API_ARTIFACTS, `${name}.json`), JSON.stringify(value, null, 2), { flag: 'wx' })
}

test('승인 callback의 모든 정본 교체 경계는 04 journal의 확정 전 보존·확정 후 공동 복구를 유지한다', { timeout: 180_000 }, async t => {
  const probe = await launchFixture(t)
  assert.equal((await complete(probe)).status, 200)
  const [record] = await records(probe)
  assert.ok(record)
  for (const file of ['map-bench-0.json', '_ai-attributions.json', '_ai-conversation-origins.json', '_ai-conversation-attributions.json', '_dooray-responses/user-editor.json']) {
    assert.ok(record.files.some(entry => entry.path === file), file)
  }
  await evidence('joint-transaction', record)
  await probe.stop()
  const boundaries = [{ phase: 'before-commit' }, ...record.files.map((file, index) => ({ phase: 'after-file', index, file: file.path })), { phase: 'after-applied' }]
  for (const boundary of boundaries) await t.test(`${boundary.phase} ${boundary.file ?? ''}`, async t => {
    const api = await launchFixture(t), beforeMap = await api.read('map-bench-0.json')
    const beforeApproval = await api.read('_dooray-responses/user-editor.json')
    await api.crash(boundary.phase, boundary.index === undefined ? {} : { index: boundary.index })
    await complete(api).catch(() => null)
    const exit = await api.restart()
    assert.ok(exit.signal || exit.code !== 0, JSON.stringify(exit))
    const map = await api.read('map-bench-0.json'), approval = await api.read('_dooray-responses/user-editor.json')
    const confirmation = await api.call(api.confirmation)
    if (boundary.phase === 'before-commit') {
      assert.deepEqual(map, beforeMap); assert.deepEqual(approval, beforeApproval)
      assert.equal(confirmation.status, 409)
    } else {
      assert.equal(confirmation.status, 200, JSON.stringify(confirmation))
      assert.equal(confirmation.body.status, 'completed')
      assert.equal(map.version, 2)
      assert.equal(map.nodes[1].data.aiConversations.length, 1)
      assert.equal(map.nodes[1].data.aiConversationId, 'approved-launch')
      assert.equal(approval.jobs[0].approval.conversation.conversationId, 'approved-launch')
      assert.ok((await api.read('_ai-attributions.json')).some(entry => entry.conversationId === 'approved-launch'))
      assert.ok((await api.read('_ai-conversation-origins.json')).some(entry => entry.conversationId === 'approved-launch'))
      const original = structuredClone(approval.jobs[0].approval); delete original.conversation
      assert.deepEqual(original, beforeApproval.jobs[0].approval)
      const history = await readdir(path.join(api.data, '_history', api.ids[0]))
      assert.equal(history.filter(file => file.endsWith('.json')).length, 1)
      const once = await api.read('map-bench-0.json')
      await api.restart()
      assert.deepEqual(await api.read('map-bench-0.json'), once, '다시 시작해도 버전·연결 중복 없음')
      assert.deepEqual(await api.read('_dooray-responses/user-editor.json'), approval)
    }
    const files = {}
    for (const entry of record.files) {
      try { const raw = await readFile(path.join(api.data, entry.path)); files[entry.path] = { bytes: raw.length, sha256: digest(raw) } }
      catch (error) { if (error.code !== 'ENOENT') throw error; files[entry.path] = null }
    }
    await evidence(`${boundary.phase}-${boundary.index ?? 'all'}`, { boundary, exit, map, approval, confirmation, files, records: await records(api), log: api.output() })
  })
})

test('승인 외부 확인 중 권한 회수는 독립 쓰기를 막지 않고 재획득 뒤 연결을 거부한다', { timeout: 40_000 }, async t => {
  let entered, release
  const reached = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  const api = await launchFixture(t, { beforeConversation: async () => { entered(); await gate } })
  const beforeMap = await api.read('map-bench-0.json'), beforeApproval = await api.read('_dooray-responses/user-editor.json')
  const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: api.env.MNP_ADMIN_EMAIL, password: api.env.MNP_ADMIN_PASSWORD }) })
  assert.equal(login.status, 200); await login.text()
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const pending = complete(api)
  await reached
  let elapsed, denied
  try {
    const start = performance.now()
    const independent = await api.call(`/api/maps/${api.ids[1]}/comments`, 'POST', { nodeId: 'card-1', summary: '[진행] 승인 외부 확인 중 독립 저장' })
    elapsed = performance.now() - start
    assert.equal(independent.status, 201); assert.ok(elapsed < 5000)
    assert.equal((await complete(api)).status, 409, '같은 예약의 병렬 완료 거부')
    const revoke = await fetch(api.base + '/api/admin/editors/user-editor', { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) })
    assert.equal(revoke.status, 200, await revoke.text())
  } finally { release(); denied = await pending }
  assert.equal(denied.status, 403, JSON.stringify(denied))
  assert.deepEqual(await api.read('map-bench-0.json'), beforeMap)
  assert.deepEqual(await api.read('_dooray-responses/user-editor.json'), beforeApproval)
  await evidence('permission-revalidation', { independentSaveMs: elapsed, budgetMs: 5000, denied, map: beforeMap, approval: beforeApproval, log: api.output() })
})
