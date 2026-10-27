import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createStorageJournal, newStorageRequestId, storageDigest, validateStorageRequestId } from '../server/lib/storageJournal.mjs'
import { createStorageResources } from '../server/lib/storageResources.mjs'

const removeFixture = async (root) => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
  assert.ok(path.basename(root).startsWith('mnp-journal-'))
  await rm(root, { recursive: true, force: true })
}

test('요청 시각 경계, terminal 이후 24시간, 미완료 효과와 정리 후 재실행 금지', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-journal-clock-'))
  t.after(() => removeFixture(root))
  let now = 1_800_000_000_000
  const day = 86_400_000
  const journal = createStorageJournal({ root, resources: createStorageResources(), keyForFile: () => 'doc:a', now: () => now })
  for (const offset of [-day, 300_000]) assert.equal(validateStorageRequestId(newStorageRequestId(now + offset), now), now + offset)
  assert.throws(() => validateStorageRequestId(newStorageRequestId(now - day - 1), now), { code: 'REQUEST_EXPIRED' })
  assert.throws(() => validateStorageRequestId(newStorageRequestId(now + 300_001), now), { code: 'REQUEST_TIME_INVALID' })
  const request = { requestId: newStorageRequestId(now), scope: { editor: 'a' }, digest: storageDigest({ before: '원문', next: '수정' }) }
  assert.equal(journal.lookup(request), null)
  assert.equal(journal.lookup(request).body.outcome, 'processing')
  assert.throws(() => journal.lookup({ ...request, scope: { editor: 'b' } }, true), { code: 'REQUEST_NOT_FOUND' })
  assert.throws(() => journal.lookup({ ...request, digest: 'different' }), { code: 'REQUEST_ID_REUSED' })
  now += 1_000
  const rejected = await journal.reject({ transactionId: journal.transactionId(request.requestId), request, keys: [],
    responseData: { status: 409, body: { code: 'FIELD_CONFLICT' } } })
  journal.release(request)
  now += day - 1
  await journal.cleanup()
  assert.equal(journal.lookup(request).body.outcome, 'not-applied')
  now++
  await journal.cleanup()
  assert.throws(() => journal.lookup(request), { code: 'REQUEST_EXPIRED' })
  assert.equal(rejected.rejected, true)

  const id = newStorageRequestId(now)
  const scope = { transactionId: journal.transactionId(id), request: { ...request, requestId: id }, keys: ['doc:a'],
    files: new Map([[path.join(root, 'a.json'), { before: null, after: Buffer.from('{"version":2}') }]]),
    directories: new Set(), durableEffects: [{ id: 'effect', kind: 'notification', payload: {} }], responseData: { status: 200, body: {} } }
  const record = await journal.commit(scope)
  now += day * 2
  await journal.cleanup()
  assert.deepEqual(journal.lookup(scope.request).body.sideEffectsPending, ['effect'])
  await journal.effectDone(record, 'effect')
  await journal.cleanup()
  assert.throws(() => journal.lookup(scope.request), { code: 'REQUEST_EXPIRED' })
})

test('미완료 journal 보존과 redo 불일치 격리는 정본을 덮지 않는다', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-journal-redo-'))
  t.after(() => removeFixture(root))
  const file = path.join(root, 'a.json')
  await writeFile(file, '이전')
  const request = { requestId: newStorageRequestId(), scope: { editor: 'a' }, digest: 'digest' }
  const first = createStorageJournal({ root, resources: createStorageResources(), keyForFile: () => 'doc:a' })
  const record = await first.commit({ transactionId: first.transactionId(request.requestId), request, keys: ['doc:a'],
    files: new Map([[file, { before: Buffer.from('이전'), after: Buffer.from('이후') }]]), directories: new Set(), durableEffects: [] })
  await rm(path.join(root, '_storage-transactions', record.transactionId, 'applied.json'))
  await writeFile(file, '다른 작성자의 내용')
  const resources = createStorageResources()
  const recovery = createStorageJournal({ root, resources, keyForFile: () => 'doc:a', now: () => Date.now() + 10 * 86_400_000 })
  await recovery.recover(); await recovery.cleanup()
  assert.equal(recovery.lookup(request, true).body.outcome, 'processing')
  assert.equal(recovery.lookup(request, true).body.code, 'RECOVERY_REQUIRED')
  assert.equal(await readFile(file, 'utf8'), '다른 작성자의 내용')
  await assert.rejects(resources.withResources(['doc:a'], () => {}), { code: 'RECOVERY_REQUIRED' })
  await resources.withResources(['doc:b'], () => {})
})
