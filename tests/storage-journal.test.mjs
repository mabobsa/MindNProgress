import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs/promises'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

async function recoverCopy(source, concurrency, now) {
  const root = await mkdtemp(path.join(tmpdir(), `mnp-journal-copy-${concurrency}-`))
  await cp(source, root, { recursive: true })
  const resources = createStorageResources()
  const journal = createStorageJournal({ root, resources, keyForFile: (file) => `doc:${path.basename(file, '.json')}`, now: () => now,
    recoverConcurrency: concurrency })
  const records = await journal.recover()
  return {
    root,
    records: records.map((record) => ({ id: record.transactionId, terminalAt: record.terminalAt ?? null, rejected: Boolean(record.rejected),
      recoveryRequired: Boolean(record.recoveryRequired), effectsDone: record.effectsDone ?? null })),
    directories: (await readdir(path.join(root, '_storage-transactions'))).sort(),
    files: Object.fromEntries(await Promise.all(['a', 'b', 'c'].map(async (name) => [name, await readFile(path.join(root, `${name}.json`), 'utf8')]))),
  }
}

test('동시 읽기 복구는 순차 복구와 같은 순서로 등록·redo·삭제·효과 상태를 만든다', async (t) => {
  const now = 1_800_000_000_000
  const source = await mkdtemp(path.join(tmpdir(), 'mnp-journal-parallel-'))
  const copies = []
  t.after(async () => { await removeFixture(source); for (const copy of copies) await removeFixture(copy) })
  const keyForFile = (file) => `doc:${path.basename(file, '.json')}`
  const journal = createStorageJournal({ root: source, resources: createStorageResources(), keyForFile, now: () => now })
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(source, `${name}.json`), `{"name":"${name}","version":1}`)
  const commitFile = async (name, version, { request = null, effects = [] } = {}) => {
    const file = path.join(source, `${name}.json`)
    const before = await readFile(file)
    const record = await journal.commit({ transactionId: journal.transactionId(request?.requestId), request, keys: [`doc:${name}`],
      files: new Map([[file, { before, after: Buffer.from(`{"name":"${name}","version":${version}}`) }]]),
      directories: new Set(), durableEffects: effects, responseData: { status: 200, body: { name, version } } })
    return { record, before }
  }
  const commits = []
  for (let version = 2; version <= 13; version++) {
    const name = ['a', 'b', 'c'][version % 3]
    const request = version % 2 ? { requestId: newStorageRequestId(now), scope: { editor: name }, digest: `digest-${version}` } : null
    commits.push(await commitFile(name, version, { request, effects: version % 4 ? [] : [{ id: `effect-${version}`, kind: 'notification', payload: {} }] }))
  }
  const withEffect = commits.find(({ record }) => record.effects.length).record
  await journal.effectDone(withEffect, withEffect.effects[0].id)
  const rejectedRequest = { requestId: newStorageRequestId(now), scope: { editor: 'z' }, digest: 'rejected' }
  await journal.reject({ transactionId: journal.transactionId(rejectedRequest.requestId), request: rejectedRequest, keys: [],
    responseData: { status: 409, body: { code: 'FIELD_CONFLICT' } } })
  // 마지막 c 변경(version 11)은 반영 전 상태로 되돌려 복구 시 redo되게 한다.
  const redo = commits.findLast(({ record }) => record.files[0].path === 'c.json')
  await rm(path.join(source, '_storage-transactions', redo.record.transactionId, 'applied.json'))
  await writeFile(path.join(source, 'c.json'), redo.before)
  // 커밋 표시가 없는 기록은 복구 시 삭제된다.
  const orphan = path.join(source, '_storage-transactions', `transaction-${'0'.repeat(32)}`)
  await mkdir(orphan, { recursive: true })
  await writeFile(path.join(orphan, 'intent.json'), '{}')

  const sequential = await recoverCopy(source, 1, now)
  copies.push(sequential.root)
  const parallel = await recoverCopy(source, 16, now)
  copies.push(parallel.root)
  assert.equal(sequential.records.length, 13)
  assert.deepEqual(parallel.records, sequential.records)
  assert.deepEqual(parallel.directories, sequential.directories)
  assert.deepEqual(parallel.files, sequential.files)
  assert.equal(sequential.directories.includes(path.basename(orphan)), false)
  assert.equal(sequential.records.filter((record) => record.rejected).length, 1)
  assert.equal(sequential.records.some((record) => record.effectsDone?.length === 1), true)
  assert.equal(sequential.files.c, '{"name":"c","version":11}')
  assert.equal(parallel.records.find((record) => record.id === redo.record.transactionId).terminalAt, now)
})

test('동시 읽기 복구도 앞선 기록의 오류를 먼저 던지고 그 전까지만 정리하며 읽기 동시성 상한을 지킨다', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-journal-order-'))
  const copies = []
  t.after(async () => { await removeFixture(root); for (const copy of copies) await removeFixture(copy) })
  const journalDirectory = path.join(root, '_storage-transactions')
  const id = (suffix) => `transaction-${suffix.padStart(32, '0')}`
  const write = async (name, files) => {
    await mkdir(path.join(journalDirectory, name), { recursive: true })
    for (const [file, content] of Object.entries(files)) await writeFile(path.join(journalDirectory, name, file), content)
  }
  await write(id('1'), { 'intent.json': '{}' })
  const corrupt = { schemaVersion: 1, transactionId: id('2'), files: [], keys: [], effects: [] }
  await write(id('2'), { 'intent.json': JSON.stringify(corrupt), 'commit.json': JSON.stringify({ schemaVersion: 1, intentSha256: 'wrong' }) })
  await write(id('3'), { 'commit.json': '{broken' })
  for (let index = 4; index < 40; index++) await write(id(String(index)), { 'intent.json': '{}' })

  for (const concurrency of [1, 16]) {
    const copy = await mkdtemp(path.join(tmpdir(), `mnp-journal-order-${concurrency}-`))
    copies.push(copy)
    await cp(root, copy, { recursive: true })
    let active = 0
    let peak = 0
    const io = { ...fs, readFile: async (...args) => {
      active++; peak = Math.max(peak, active)
      try { await new Promise((resolve) => setTimeout(resolve, 2)); return await fs.readFile(...args) } finally { active-- }
    } }
    const journal = createStorageJournal({ root: copy, resources: createStorageResources(), keyForFile: () => 'doc:a', io, recoverConcurrency: concurrency })
    await assert.rejects(journal.recover(), { message: 'JOURNAL_CORRUPT' })
    const remaining = await readdir(path.join(copy, '_storage-transactions'))
    assert.equal(remaining.includes(id('1')), false, '오류 전 기록의 정리는 기존처럼 수행한다.')
    assert.equal(remaining.includes(id('4')), true, '오류 뒤 기록은 기존처럼 정리하지 않는다.')
    assert.ok(peak <= concurrency, `동시 읽기 ${peak}건이 상한 ${concurrency}건을 넘었다.`)
    if (concurrency > 1) assert.ok(peak > 1, '읽기가 실제로 동시에 수행되어야 한다.')
  }

  const parseFirst = await mkdtemp(path.join(tmpdir(), 'mnp-journal-order-parse-'))
  copies.push(parseFirst)
  await cp(root, parseFirst, { recursive: true })
  await rm(path.join(parseFirst, '_storage-transactions', id('2')), { recursive: true })
  const journal = createStorageJournal({ root: parseFirst, resources: createStorageResources(), keyForFile: () => 'doc:a', recoverConcurrency: 16 })
  await assert.rejects(journal.recover(), SyntaxError)
})
