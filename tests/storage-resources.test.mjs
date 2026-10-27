import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createStorageResources, normalizeResourceKey } from '../server/lib/storageResources.mjs'
import { createStorageChanges } from '../server/lib/storageChanges.mjs'
import * as fs from 'node:fs/promises'

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
test('공통 잠금은 역방향 요청을 같은 순서로 획득하고 중첩 재사용·실패 해제를 보장한다', async () => {
  const locks = createStorageResources()
  let count = 0
  await Promise.all(Array.from({ length: 20 }, (_, i) => locks.withResources(i % 2 ? ['doc:b', 'doc:a'] : ['doc:a', 'doc:b'], async () => {
    const before = count
    await Promise.resolve()
    await locks.withResources(['doc:a'], async () => { count = before + 1 })
  })))
  assert.equal(count, 20)
  await assert.rejects(locks.withResources(['doc:b'], () => locks.withResources(['doc:a'], () => {})), { code: 'RESOURCE_ORDER_VIOLATION' })
  await assert.rejects(locks.withResources([{ key: 'doc:a', mode: 'read' }], () => locks.withResources(['doc:a'], () => {})), { code: 'RESOURCE_UPGRADE_FORBIDDEN' })
  await assert.rejects(locks.withResources(['doc:a'], () => { throw new Error('예상 실패') }), /예상 실패/)
  assert.deepEqual(locks.pending(), [])
  assert.equal(normalizeResourceKey('state:_groups\\a.json'), 'state:_groups/a.json')
  for (const key of ['state:../escape', 'state:C:/escape', 'state:/escape']) assert.throws(() => normalizeResourceKey(key))
})

test('catalog 독점은 공유 요청을 기다리지만 무관한 doc와 읽기는 계속한다', async () => {
  const locks = createStorageResources(), entered = deferred(), finish = deferred()
  const first = locks.withResources([{ key: 'catalog', mode: 'read' }], async () => { entered.resolve(); await finish.promise })
  await entered.promise
  let transitioned = false
  const transition = locks.withResources(['catalog'], async () => { transitioned = true })
  await locks.withResources(['doc:other'], () => assert.equal(transitioned, false))
  finish.resolve(); await Promise.all([first, transition])
  assert.equal(transitioned, true); assert.deepEqual(locks.pending(), [])
})

test('공동 변경은 확정 전 후보만 읽고 중간 실패에서 파일·메모리·효과를 복구한다', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-change-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const locks = createStorageResources()
  const first = path.join(root, 'a.json'), second = path.join(root, 'b.json')
  await writeFile(first, '이전 A'); await writeFile(second, '이전 B')
  let memory = '이전', effects = 0, fail = true
  const changes = createStorageChanges({ root, resources: locks, keyForFile: (file) => `doc:${path.basename(file, '.json')}`,
    beforeApply: async ({ index }) => { if (fail && index === 1) throw new Error('두 번째 교체 실패') } })
  const mutate = () => locks.withResources(['doc:a', 'doc:b'], () => changes.run(async () => {
    changes.onRollback(() => { memory = '이전' }); memory = '후보'
    await changes.stage(first, '새 A'); await changes.stage(second, null)
    assert.equal(await readFile(first, 'utf8'), '이전 A')
    assert.equal(await changes.readFile(first, 'utf8'), '새 A')
    await assert.rejects(changes.readFile(second), { code: 'ENOENT' })
    changes.afterCommit(() => { effects++ })
  }))
  await assert.rejects(mutate(), /두 번째 교체 실패/)
  assert.equal(await readFile(first, 'utf8'), '이전 A'); assert.equal(await readFile(second, 'utf8'), '이전 B')
  assert.equal(memory, '이전'); assert.equal(effects, 0)
  fail = false; await mutate()
  assert.equal(await readFile(first, 'utf8'), '새 A'); await assert.rejects(readFile(second), { code: 'ENOENT' })
  assert.equal(memory, '후보'); assert.equal(effects, 1)
  assert.deepEqual(locks.pending(), [])
})

test('복구 파일 쓰기도 실패한 자원은 새 읽기·쓰기를 거부하고 무관한 자원을 허용한다', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-quarantine-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const locks = createStorageResources(), file = path.join(root, 'a.json'), second = path.join(root, 'b.json')
  await writeFile(file, '복구할 이전 본문')
  const changes = createStorageChanges({ root, resources: locks, keyForFile: (file) => `doc:${path.basename(file, '.json')}`,
    io: { ...fs, writeFile: async (file, body, options) => {
      if (String(body) === '복구할 이전 본문') throw new Error('복구 저장 실패')
      return writeFile(file, body, options)
    } }, beforeApply: ({ index }) => { if (index === 1) throw new Error('확정 저장 실패') } })
  await assert.rejects(locks.withResources(['doc:a', 'doc:b'], () => changes.run(async () => {
    await changes.stage(file, '후보'); await changes.stage(second, '다음 후보')
  })), { code: 'RECOVERY_REQUIRED', status: 503 })
  for (const mode of ['read', 'write']) await assert.rejects(locks.withResources([{ key: 'doc:a', mode }], () => {}), { code: 'RECOVERY_REQUIRED' })
  await locks.withResources(['doc:other'], () => {})
  assert.deepEqual(locks.pending(), [])
})
