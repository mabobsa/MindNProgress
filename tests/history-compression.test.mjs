import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { brotliDecompressSync } from 'node:zlib'
import { backfillDailyBackupHistory } from '../server/lib/dailyBackupHistory.mjs'
import { cleanupUnreferencedImageAssets } from '../server/lib/imageAssetCleanup.mjs'
import {
  compressedRevisionFileName, decodeRevisionText, encodeRevisionBytes, rawRevisionFileName, revisionFileId, selectRevisionFiles,
} from '../server/lib/revisionFiles.mjs'
import { createStorageJournal, newStorageRequestId } from '../server/lib/storageJournal.mjs'
import { createStorageResources } from '../server/lib/storageResources.mjs'
import { compressRevisionHistory } from '../scripts/compress-revision-history.mjs'
import { storageApi } from './helpers/storage-api-harness.mjs'

async function fixtureDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}
async function writeBytes(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
}
const revisionBody = (id, mapId, archivedAt, nodes = [{ id: 'root', data: { label: id, kind: 'root' } }]) =>
  ({ id, mapId, archivedAt, archivedBy: { id: 'user-editor', name: '김용민' }, reason: 'update', map: { id: mapId, title: '압축 시험', nodes, edges: [], version: 1 } })

test('이력 파일 이름 규칙: 원문과 압축본을 모두 읽고 같은 ID는 압축본을 고른다', () => {
  assert.equal(revisionFileId('mabc1234-0011aabb.json'), 'mabc1234-0011aabb')
  assert.equal(revisionFileId('mabc1234-0011aabb.json.br'), 'mabc1234-0011aabb')
  assert.equal(revisionFileId('notes.txt'), null)
  assert.deepEqual(selectRevisionFiles(['a1234567.json', 'a1234567.json.br', 'b1234567.json', 'notes.txt', 'bad.json.br.tmp']), [
    { id: 'a1234567', name: 'a1234567.json.br' }, { id: 'b1234567', name: 'b1234567.json' }])
  assert.deepEqual(selectRevisionFiles(['a1234567.json', 'X.json'], (id) => /^[a-z0-9-]{8,80}$/.test(id)), [{ id: 'a1234567', name: 'a1234567.json' }])
  const text = JSON.stringify({ 한글: '압축 원문', n: 1 })
  assert.equal(decodeRevisionText('x.json.br', encodeRevisionBytes(text)), text)
  assert.equal(decodeRevisionText('x.json', Buffer.from(text)), text)
  assert.equal(compressedRevisionFileName('abc'), 'abc.json.br')
  assert.equal(rawRevisionFileName('abc'), 'abc.json')
})

test('이미지 정리는 압축 이력에서만 참조하는 이미지를 지우지 않는다', async (t) => {
  const dataDirectory = await fixtureDirectory(t, 'mnp-history-compress-assets-')
  const mapId = 'map-compressed-assets'
  const compressedAsset = `${'f'.repeat(32)}.png`
  const orphanAsset = `${'0'.repeat(32)}.png`
  const old = new Date(Date.parse('2026-11-01T00:00:00Z'))
  await writeBytes(path.join(dataDirectory, `${mapId}.json`), JSON.stringify({ id: mapId, nodes: [], edges: [] }))
  const revision = revisionBody('mcompress-00000001', mapId, '2026-10-01T00:00:00Z', [{ id: 'image', data: { kind: 'image', image: { assetId: compressedAsset } } }])
  await writeBytes(path.join(dataDirectory, '_history', mapId, compressedRevisionFileName(revision.id)), encodeRevisionBytes(JSON.stringify(revision)))
  for (const asset of [compressedAsset, orphanAsset]) {
    const file = path.join(dataDirectory, '_assets', mapId, asset)
    await writeBytes(file, asset); await utimes(file, old, old)
  }
  await cleanupUnreferencedImageAssets({ dataDirectory, minimumAgeMs: 60_000, now: Date.parse('2026-11-09T00:00:00Z') })
  await access(path.join(dataDirectory, '_assets', mapId, compressedAsset))
  await assert.rejects(access(path.join(dataDirectory, '_assets', mapId, orphanAsset)), { code: 'ENOENT' })
})

test('일일 백업 보정은 압축 이력과 원문 이력을 함께 읽는다', async (t) => {
  const dataDirectory = await fixtureDirectory(t, 'mnp-history-compress-daily-')
  const mapId = 'map-compressed-daily'
  const history = path.join(dataDirectory, '_history', mapId)
  const compressed = revisionBody('mcompress-00000002', mapId, '2026-10-02T01:00:00Z')
  const raw = revisionBody('mcompress-00000003', mapId, '2026-10-03T01:00:00Z')
  await writeBytes(path.join(history, compressedRevisionFileName(compressed.id)), encodeRevisionBytes(JSON.stringify(compressed)))
  await writeBytes(path.join(history, rawRevisionFileName(raw.id)), JSON.stringify(raw, null, 2))
  const written = []
  const map = { id: mapId, title: '현재', nodes: [{ id: 'root', data: { label: '현재' } }], edges: [], updatedAt: '2026-11-09T00:00:00Z' }
  const result = await backfillDailyBackupHistory({
    dataDirectory, map, isValidMapId: () => true, isValidRevisionId: (id) => /^[a-z0-9-]{8,80}$/.test(id),
    isValidMap: (value) => Array.isArray(value?.nodes), dateString: (date) => date.toISOString().slice(0, 10),
    writeBackup: async (snapshot, _user, date) => {
      written.push({ date, label: snapshot.nodes[0].data.label })
      await writeBytes(path.join(dataDirectory, '_daily-backups', mapId, `${date}.json`), JSON.stringify({ map: snapshot }))
      return { date }
    },
    writeIndex: async (file, value) => writeBytes(file, JSON.stringify(value)),
  })
  assert.equal(result.historyReadCount, 4, '두 이력의 날짜를 읽고, 빠진 날짜 백업을 만들 때 다시 읽는다')
  assert.deepEqual(written.filter((item) => item.date < '2026-11-01').sort((a, b) => a.date.localeCompare(b.date)),
    [{ date: '2026-10-02', label: compressed.id }, { date: '2026-10-03', label: raw.id }])
})

test('저장 복구 기록은 반영이 끝난 사본만 압축 보관하고, 반영 전 기록은 원문 사본으로 다시 반영한다', async (t) => {
  const root = await fixtureDirectory(t, 'mnp-history-compress-journal-')
  const file = path.join(root, 'state.json')
  const before = JSON.stringify({ items: [] })
  const after = JSON.stringify({ items: Array.from({ length: 500 }, (_, index) => ({ id: index, label: `위임 상태 ${index}` })) })
  await writeFile(file, before)
  const journal = createStorageJournal({ root, resources: createStorageResources(), keyForFile: () => 'state:a', compressAppliedImages: true })
  const request = { requestId: newStorageRequestId(), scope: { editor: 'a' }, digest: 'digest' }
  const record = await journal.commit({ transactionId: journal.transactionId(request.requestId), request, keys: ['state:a'],
    files: new Map([[file, { before: Buffer.from(before), after: Buffer.from(after) }]]), directories: new Set(), durableEffects: [] })
  assert.equal(await readFile(file, 'utf8'), after)
  await journal.imageCompactionIdle()
  const directory = path.join(root, '_storage-transactions', record.transactionId)
  const names = await readdir(directory)
  assert.ok(names.includes('image-0.br') && !names.includes('image-0'), names.join())
  assert.equal(brotliDecompressSync(await readFile(path.join(directory, 'image-0.br'))).toString(), after, '압축본은 반영한 내용과 같다')
  assert.ok((await stat(path.join(directory, 'image-0.br'))).size < after.length / 3)
  // 반영 표시가 있는 기록은 재기동 때 다시 반영하지 않고, 결과 조회는 그대로 된다.
  const restarted = createStorageJournal({ root, resources: createStorageResources(), keyForFile: () => 'state:a', compressAppliedImages: true })
  await restarted.recover()
  assert.equal(restarted.lookup(request, true).body.outcome, 'committed')

  // 반영 전에 서버가 꺼진 기록은 원문 사본으로 redo하고, 그 뒤에 압축한다.
  const next = JSON.stringify({ items: ['다음 상태'] })
  const second = { requestId: newStorageRequestId(), scope: { editor: 'a' }, digest: 'digest-2' }
  const pending = await restarted.commit({ transactionId: restarted.transactionId(second.requestId), request: second, keys: ['state:a'],
    files: new Map([[file, { before: Buffer.from(after), after: Buffer.from(next) }]]), directories: new Set(), durableEffects: [] })
  await restarted.imageCompactionIdle()
  const pendingDirectory = path.join(root, '_storage-transactions', pending.transactionId)
  await rm(path.join(pendingDirectory, 'applied.json'))
  await writeFile(path.join(pendingDirectory, 'image-0'), brotliDecompressSync(await readFile(path.join(pendingDirectory, 'image-0.br'))))
  await rm(path.join(pendingDirectory, 'image-0.br'))
  await writeFile(file, after)
  const recovery = createStorageJournal({ root, resources: createStorageResources(), keyForFile: () => 'state:a', compressAppliedImages: true })
  await recovery.recover()
  assert.equal(await readFile(file, 'utf8'), next, '원문 사본으로 redo')
  await recovery.imageCompactionIdle()
  assert.deepEqual((await readdir(pendingDirectory)).filter((name) => name.startsWith('image-')), ['image-0.br'])
})

test('압축을 끈 저널은 기존처럼 원문 사본을 남긴다', async (t) => {
  const root = await fixtureDirectory(t, 'mnp-history-compress-journal-off-')
  const file = path.join(root, 'state.json')
  await writeFile(file, 'a')
  const journal = createStorageJournal({ root, resources: createStorageResources(), keyForFile: () => 'state:a' })
  const request = { requestId: newStorageRequestId(), scope: { editor: 'a' }, digest: 'digest' }
  const record = await journal.commit({ transactionId: journal.transactionId(request.requestId), request, keys: ['state:a'],
    files: new Map([[file, { before: Buffer.from('a'), after: Buffer.from('b') }]]), directories: new Set(), durableEffects: [] })
  await journal.imageCompactionIdle()
  assert.ok((await readdir(path.join(root, '_storage-transactions', record.transactionId))).includes('image-0'))
})

test('기존 이력 변환 도구는 시험 실행에서 바꾸지 않고, 실행하면 원문과 바이트가 같은 압축본만 남긴다', async (t) => {
  const dataDirectory = await fixtureDirectory(t, 'mnp-history-compress-migrate-')
  const mapId = 'map-migrate'
  const history = path.join(dataDirectory, '_history', mapId)
  const ids = ['mmigrate-00000001', 'mmigrate-00000002']
  const originals = new Map()
  for (const id of ids) {
    const bytes = Buffer.from(`${JSON.stringify(revisionBody(id, mapId, '2026-10-01T00:00:00Z'), null, 2)}\n`)
    originals.set(id, bytes)
    await writeBytes(path.join(history, rawRevisionFileName(id)), bytes)
  }
  const mtime = new Date('2026-10-01T00:00:00Z')
  await utimes(path.join(history, rawRevisionFileName(ids[0])), mtime, mtime)
  await writeBytes(path.join(history, 'notes.json'), '{"note":"이력 ID가 아님"}')
  await writeBytes(path.join(history, 'mmigrate-corrupt.json'), '{ 손상')
  // 이전 실행이 압축본만 쓰고 끊긴 경우
  const resumedId = 'mmigrate-00000003'
  const resumedBytes = Buffer.from(JSON.stringify(revisionBody(resumedId, mapId, '2026-10-02T00:00:00Z')))
  await writeBytes(path.join(history, rawRevisionFileName(resumedId)), resumedBytes)
  await writeBytes(path.join(history, compressedRevisionFileName(resumedId)), encodeRevisionBytes(resumedBytes))
  const closedServer = 'http://127.0.0.1:9'

  const dry = await compressRevisionHistory({ dataDirectory, serverUrl: closedServer })
  assert.equal(dry.apply, false)
  assert.equal(dry.rawFiles, 4)
  assert.ok(dry.packedBytes < dry.rawBytes)
  assert.deepEqual(dry.skipped.map((item) => item.reason), ['JSON이 아니어서 그대로 둠'])
  assert.ok((await readdir(history)).includes(rawRevisionFileName(ids[0])), '시험 실행은 바꾸지 않는다')

  const applied = await compressRevisionHistory({ dataDirectory, apply: true, serverUrl: closedServer })
  assert.equal(applied.converted, 2)
  assert.equal(applied.resumed, 1)
  const names = (await readdir(history)).sort()
  assert.deepEqual(names, ['mmigrate-00000001.json.br', 'mmigrate-00000002.json.br', 'mmigrate-00000003.json.br', 'mmigrate-corrupt.json', 'notes.json'])
  for (const id of ids) {
    assert.ok(brotliDecompressSync(await readFile(path.join(history, compressedRevisionFileName(id)))).equals(originals.get(id)), `${id} 바이트 일치`)
  }
  assert.equal((await stat(path.join(history, compressedRevisionFileName(ids[0])))).mtime.toISOString(), mtime.toISOString(), '수정 시각 유지')
  const again = await compressRevisionHistory({ dataDirectory, apply: true, serverUrl: closedServer })
  assert.equal(again.converted + again.resumed, 0, '다시 실행해도 바꿀 것이 없다')

  // 서버가 응답하면 실행을 거부한다.
  const running = createServer((request, response) => { response.writeHead(request.url === '/api/health' ? 200 : 404); response.end('{}') })
  await new Promise((resolve) => running.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => running.close(resolve)))
  await assert.rejects(compressRevisionHistory({ dataDirectory, apply: true, serverUrl: `http://127.0.0.1:${running.address().port}` }), { code: 'SERVER_RUNNING' })
})

test('실제 서버는 새 이력을 압축해 저장하고, 원문·압축 이력 모두 목록에 보이며 복원할 수 있다', { timeout: 90_000 }, async (t) => {
  const legacyId = 'mlegacy0-0000aaaa'
  const api = await storageApi(t, { documents: 1, seed: async ({ data, ids }) => {
    const revision = revisionBody(legacyId, ids[0], '2026-10-01T00:00:00.000Z')
    revision.map = { ...revision.map, id: ids[0], title: '예전 원문 이력', nodes: [{ id: 'card-0', type: 'mind', position: { x: 0, y: 0 }, data: { label: '예전 카드', kind: 'root', status: 'planned', progress: 0 } }] }
    await writeBytes(path.join(data, '_history', ids[0], rawRevisionFileName(legacyId)), `${JSON.stringify(revision, null, 2)}\n`)
  } })
  const [mapId] = api.ids
  const historyDirectory = path.join(api.data, '_history', mapId)
  const current = (await api.call(`/api/maps/${mapId}`)).body.map
  const edited = { ...current, nodes: current.nodes.map((node) => node.id === 'card-1' ? { ...node, data: { ...node.data, label: '수정한 카드' } } : node) }
  const saved = await api.call(`/api/maps/${mapId}`, 'PUT', { baseVersion: current.version, baseLifecycleVersion: current.lifecycleVersion ?? 0, map: edited })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const names = await readdir(historyDirectory)
  const compressedNames = names.filter((name) => name.endsWith('.json.br'))
  assert.equal(compressedNames.length, 1, names.join())
  assert.ok(names.includes(rawRevisionFileName(legacyId)))
  const stored = JSON.parse(decodeRevisionText(compressedNames[0], await readFile(path.join(historyDirectory, compressedNames[0]))))
  assert.equal(stored.mapId, mapId)

  const list = (await api.call(`/api/maps/${mapId}/history`)).body
  assert.deepEqual(new Set(list.revisions.map((revision) => revision.id)), new Set([legacyId, revisionFileId(compressedNames[0])]))
  const snapshotHashes = new Map(list.revisions.map((revision) => [revision.id, revision.snapshotSha256]))
  for (const revisionId of [legacyId, revisionFileId(compressedNames[0])]) {
    const latest = (await api.call(`/api/maps/${mapId}`)).body.map
    assert.ok(snapshotHashes.get(revisionId), '목록은 복원 조건 해시를 준다')
    const restored = await api.call(`/api/maps/${mapId}/history/${revisionId}/restore`, 'POST', { baseVersion: latest.version, baseLifecycleVersion: latest.lifecycleVersion ?? 0, expectedSnapshotSha256: snapshotHashes.get(revisionId) })
    assert.equal(restored.status, 200, `${revisionId}: ${JSON.stringify(restored.body)}`)
  }
  assert.equal((await api.call(`/api/maps/${mapId}`)).body.map.nodes.find((node) => node.id === 'card-1').data.label, '검증 카드 1', '압축 이력으로 저장 전 상태를 복원')
  assert.ok((await readdir(historyDirectory)).filter((name) => name.endsWith('.json.br')).length >= 3, '복원 직전 상태도 압축 이력으로 남는다')
})
