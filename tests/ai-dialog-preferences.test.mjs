import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAiDialogPreferences } from '../server/lib/aiDialogPreferences.mjs'
import { replaceFileWithRetry } from '../server/lib/replaceFileWithRetry.mjs'
import { isAiDialogSectionsPatch, normalizeAiDialogSections } from '../src/utils/aiDialogSections.mjs'

const defaults = { workspace: true, mcp: true, skills: true }
test('세 영역은 기본 펼침이며 저장 형식은 불리언 부분 변경만 허용한다', () => {
  for (const input of [null, undefined, {}, [], 'false']) assert.deepEqual(normalizeAiDialogSections(input), defaults)
  assert.deepEqual(normalizeAiDialogSections({ workspace: false, mcp: 'false', skills: 0 }), { ...defaults, workspace: false })
  assert.equal(isAiDialogSectionsPatch({ mcp: false, skills: true }), true)
  for (const input of [null, [], {}, { workspace: 0 }, { other: false }, { mcp: 'false' }]) assert.equal(isAiDialogSectionsPatch(input), false)
})

test('계정별 독립 저장·동시 부분 변경·재시작 복원 및 실패 후 재시도를 검증한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dialog-preferences-'))
  let failWrite = false
  try {
    const store = await createAiDialogPreferences({ dataDirectory: directory, replaceFile: async (from, to) => {
      if (failWrite) throw Error('테스트 저장 실패')
      await replaceFileWithRetry(from, to)
    } })
    assert.deepEqual(store.get('user-a'), defaults)
    await Promise.all([store.patch('user-a', { workspace: false }), store.patch('user-a', { mcp: false }), store.patch('user-b', { skills: false })])
    assert.deepEqual(store.get('user-a'), { workspace: false, mcp: false, skills: true })
    assert.deepEqual(store.get('user-b'), { ...defaults, skills: false })
    const copy = store.get('user-a'); copy.skills = false
    assert.equal(store.get('user-a').skills, true, '조회 결과 수정은 저장값을 변경하지 않는다')
    const before = await readFile(path.join(directory, '_ai-dialog-preferences.json'), 'utf8')
    failWrite = true
    await assert.rejects(store.patch('user-a', { skills: false }), /테스트 저장 실패/)
    assert.equal(store.get('user-a').skills, true)
    assert.equal(await readFile(path.join(directory, '_ai-dialog-preferences.json'), 'utf8'), before)
    failWrite = false
    await store.patch('user-a', { skills: false })
    const restarted = await createAiDialogPreferences({ dataDirectory: directory })
    assert.deepEqual(restarted.get('user-a'), { workspace: false, mcp: false, skills: false })
    assert.deepEqual(restarted.get('user-b'), { ...defaults, skills: false })
    assert.throws(() => restarted.patch('user-a', { injected: true }), error => error.status === 400)
  } finally {
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-dialog-preferences-'))
    await rm(directory, { recursive: true, force: true })
  }
})

test('일시적 EPERM은 제한 재시도 후 기존 파일을 원자적으로 교체한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dialog-preferences-'))
  const file = path.join(directory, '_ai-dialog-preferences.json')
  let attempts = 0
  try {
    const initial = await createAiDialogPreferences({ dataDirectory: directory })
    await initial.patch('user-a', { workspace: false })
    const before = await readFile(file, 'utf8')
    const store = await createAiDialogPreferences({
      dataDirectory: directory,
      replaceFile: (from, to) => replaceFileWithRetry(from, to, { renameFile: async (source, target) => {
        attempts += 1
        assert.equal(await readFile(target, 'utf8'), before)
        assert.deepEqual(store.get('user-a'), { ...defaults, workspace: false })
        if (attempts === 1) throw Object.assign(new Error('일시적 파일 점유'), { code: 'EPERM' })
        await rename(source, target)
      } }),
    })
    assert.deepEqual(await store.patch('user-a', { mcp: false }), { ...defaults, workspace: false, mcp: false })
    assert.equal(attempts, 2)
    assert.deepEqual((await createAiDialogPreferences({ dataDirectory: directory })).get('user-a'), store.get('user-a'))
    assert.deepEqual(await readdir(directory), ['_ai-dialog-preferences.json'])
  } finally {
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-dialog-preferences-'))
    await rm(directory, { recursive: true, force: true })
  }
})

test('지속적 EPERM은 유한 재시도 후 실패하고 기존 저장값을 보존한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dialog-preferences-'))
  const file = path.join(directory, '_ai-dialog-preferences.json')
  let attempts = 0
  try {
    const initial = await createAiDialogPreferences({ dataDirectory: directory })
    await initial.patch('user-a', { workspace: false })
    const before = await readFile(file, 'utf8')
    const store = await createAiDialogPreferences({
      dataDirectory: directory,
      replaceFile: (from, to) => replaceFileWithRetry(from, to, { renameFile: async () => {
        attempts += 1
        assert.equal(await readFile(file, 'utf8'), before)
        throw Object.assign(new Error('지속적 파일 점유'), { code: 'EPERM' })
      } }),
    })
    await assert.rejects(store.patch('user-a', { skills: false }), error => error.code === 'EPERM' && error.message === '지속적 파일 점유')
    assert.equal(attempts, 6)
    assert.deepEqual(store.get('user-a'), { ...defaults, workspace: false })
    assert.equal(await readFile(file, 'utf8'), before)
    assert.deepEqual(await readdir(directory), ['_ai-dialog-preferences.json'])
  } finally {
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-dialog-preferences-'))
    await rm(directory, { recursive: true, force: true })
  }
})
