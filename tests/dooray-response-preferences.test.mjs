import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDoorayResponsePreferences, doorayResponseSettingsFromResolved, validateDoorayResponseSettings } from '../server/lib/doorayResponsePreferences.mjs'
import { replaceFileWithRetry } from '../server/lib/replaceFileWithRetry.mjs'

const first = { agentId: 'codex', modelId: 'gpt-6.1-sol', thoughtLevel: 'high' }
const second = { agentId: 'other-ai', modelId: 'other-model', thoughtLevel: 'medium' }
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dooray-response-settings-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-dooray-response-settings-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  return directory
}

test('설정은 종류·모델이 있는 정상 문자열만 허용하고 내부 정책·타 계정 필드는 저장하지 않는다', () => {
  assert.deepEqual(validateDoorayResponseSettings({ ...first, thoughtLevel: ' high ', mode: null }), first)
  assert.deepEqual(doorayResponseSettingsFromResolved({ ...first, modelPolicy: { message: '내부 보정 이력' }, mcpServers: [] }), first)
  for (const value of [null, [], {}, { modelId: 'gpt-6.1-sol' }, { ...first, userId: 'other' }, { ...first, thoughtLevel: 3 }, { ...first, modelId: 'a'.repeat(161) }]) {
    assert.throws(() => validateDoorayResponseSettings(value), { status: 400 })
  }
})

test('계정별 선택은 분리되어 저장되고 브라우저와 서버를 다시 열어도 같은 값을 읽는다', async (t) => {
  const directory = await fixture(t)
  const store = await createDoorayResponsePreferences({ dataDirectory: directory })
  assert.equal(store.get('user1'), null)
  await Promise.all([store.put('user1', first), store.put('user2', second)])
  assert.deepEqual(store.get('user1'), first)
  assert.deepEqual(store.get('user2'), second)
  store.get('user1').modelId = 'mutated'
  assert.deepEqual(store.get('user1'), first)
  const restarted = await createDoorayResponsePreferences({ dataDirectory: directory })
  assert.deepEqual(restarted.get('user1'), first)
  assert.deepEqual(restarted.get('user2'), second)
  assert.equal(restarted.get('new-user'), null)
})

test('동시에 가져온 예전 브라우저 설정은 이미 저장한 새 계정 설정을 덮어쓰지 않는다', async (t) => {
  const directory = await fixture(t)
  const store = await createDoorayResponsePreferences({ dataDirectory: directory })
  const updates = await Promise.all([store.put('user1', first), store.put('user1', second, { onlyIfUnset: true })])
  assert.deepEqual(updates, [first, first])
  assert.deepEqual(store.get('user1'), first)
  assert.deepEqual(await store.put('user2', second, { onlyIfUnset: true }), second)
})

test('이전 실행의 보정 저장은 실행 준비 사이 다른 브라우저가 변경한 새 선택을 보존한다', async (t) => {
  const directory = await fixture(t)
  const store = await createDoorayResponsePreferences({ dataDirectory: directory })
  await store.put('user1', first)
  const previous = store.get('user1')
  await store.put('user1', second)
  assert.deepEqual(await store.put('user1', first, { expectedSettings: previous }), second)
  assert.deepEqual(store.get('user1'), second)
  assert.deepEqual(await store.put('user1', first, { expectedSettings: second }), first)
  await store.put('user2', second)
  assert.deepEqual(await store.put('user2', first, { expectedSettings: null }), second)
})

test('저장 실패는 이전 선택을 유지하고 임시 파일을 정리하며 다음 저장을 막지 않는다', async (t) => {
  const directory = await fixture(t)
  let fail = false
  const store = await createDoorayResponsePreferences({ dataDirectory: directory, replaceFile: async (source, destination) => {
    if (fail) throw new Error('격리된 저장 실패')
    await replaceFileWithRetry(source, destination)
  } })
  await store.put('user1', first)
  fail = true
  await assert.rejects(store.put('user1', second), /저장 실패/)
  assert.deepEqual(store.get('user1'), first)
  assert.deepEqual(await readdir(directory), ['_dooray-response-preferences.json'])
  fail = false
  await store.put('user1', second)
  assert.deepEqual(store.get('user1'), second)
})

test('손상된 저장 파일은 기본값으로 덮어쓰지 않고 읽기 오류로 알린다', async (t) => {
  const directory = await fixture(t)
  const file = path.join(directory, '_dooray-response-preferences.json')
  await writeFile(file, '손상된 원문', 'utf8')
  await assert.rejects(createDoorayResponsePreferences({ dataDirectory: directory }))
  assert.equal(await readFile(file, 'utf8'), '손상된 원문')
})
