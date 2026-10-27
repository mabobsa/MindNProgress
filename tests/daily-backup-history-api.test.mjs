import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const email = 'daily-history-test@mind.local'
const password = 'isolated-daily-history-test-password'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value), 'utf8')
}

async function startFixture(dataDirectory) {
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_MACHINE_ID: 'daily-history-main',
      MNP_ADMIN_EMAIL: email, MNP_ADMIN_PASSWORD: password,
      MNP_WORKSPACE_POOL_REGISTRY: path.join(dataDirectory, 'no-workspace-registry.json'),
      MNP_AIONUI_DISCOVERY_FILE: path.join(dataDirectory, 'no-aion-discovery.json'),
      MNP_AIONUI_URL: 'http://127.0.0.1:9' },
  })
  const base = `http://127.0.0.1:${port}`
  let output = ''
  let exited = false
  const done = new Promise(resolve => {
    child.once('exit', code => { exited = true; resolve(code) })
    child.once('error', error => { output += error.message; exited = true; resolve(-1) })
  })
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  const stop = async () => {
    if (exited) return
    if (child.connected) child.send({ type: 'mnp:shutdown' })
    const timer = setTimeout(() => { if (!exited) child.kill() }, 5000)
    try { await done } finally { clearTimeout(timer) }
  }
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      assert.equal(exited, false, output)
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) return { base, stop, output: () => output }
      } catch { /* 격리 서버 준비 대기 */ }
      await wait(100)
    }
    throw new Error(`격리 일일 백업 API 시작 실패: ${output}`)
  } catch (error) {
    await stop()
    throw error
  }
}

test('API 재기동은 과거 본문 재조회 없이 일일 백업 조회·미리보기·복원을 유지한다', { timeout: 60_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-daily-history-api-'))
  const mapId = 'map-daily-history-api'
  const actor = { id: 'fixture-editor', name: '검증 사용자', role: 'editor' }
  const map = { id: mapId, title: '기동 보정 검증', color: '#5577aa', version: 3,
    createdAt: '2026-01-01T00:00:00Z', createdBy: actor, updatedAt: '2026-01-03T00:00:00Z', updatedBy: actor,
    nodes: [{ id: 'root-history', type: 'mind', position: { x: 0, y: 0 },
      data: { label: '현재 카드', kind: 'root', status: 'planned', progress: 0 } }], edges: [] }
  const mapFile = path.join(dataDirectory, `${mapId}.json`)
  const indexFile = path.join(dataDirectory, '_migrations', 'daily-backup-history-v1', `${mapId}.json`)
  const pastBackupFile = path.join(dataDirectory, '_daily-backups', mapId, '2026-01-01.json')
  let server
  try {
    await writeJson(mapFile, map)
    for (const [id, hour, label] of [['revision-earlier', '01', '이전 카드'], ['revision-latest', '02', '당일 최신 카드']]) {
      await writeJson(path.join(dataDirectory, '_history', mapId, `${id}.json`), {
        id, mapId, archivedAt: `2026-01-01T${hour}:00:00Z`, archivedBy: actor,
        map: { ...map, updatedAt: `2026-01-01T${hour}:00:00Z`, nodes: [{ ...map.nodes[0], data: { ...map.nodes[0].data, label } }] },
      })
    }
    server = await startFixture(dataDirectory)
    assert.match(server.output(), /이력 본문 읽기 3회, 인덱스 재사용 0개/)
    const backupBefore = await readFile(pastBackupFile, 'utf8')
    assert.equal(JSON.parse(backupBefore).map.nodes[0].data.label, '당일 최신 카드')
    const indexBefore = await readFile(indexFile, 'utf8')
    await server.stop()
    server = await startFixture(dataDirectory)
    assert.match(server.output(), /이력 본문 읽기 0회, 인덱스 재사용 2개/)
    assert.equal(await readFile(pastBackupFile, 'utf8'), backupBefore)
    assert.equal(await readFile(indexFile, 'utf8'), indexBefore)

    const login = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    })
    assert.equal(login.status, 200)
    const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] }
    const daily = await fetch(`${server.base}/api/maps/${mapId}/backups/daily`, { headers })
    assert.equal(daily.status, 200)
    const dates = (await daily.json()).dailyBackups.map(backup => backup.date)
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
    assert.ok(dates.includes('2026-01-01'))
    assert.ok(dates.includes('2026-01-03'))
    assert.ok(dates.includes(today), '오늘의 정기 백업도 계속 생성해야 합니다.')
    const currentBefore = await readFile(mapFile, 'utf8')
    const preview = await fetch(`${server.base}/api/maps/${mapId}/backups/daily/2026-01-01/preview`, { headers })
    assert.equal(preview.status, 200)
    const previewedBackup = (await preview.json()).backup
    assert.equal(previewedBackup.map.nodes[0].data.label, '당일 최신 카드')
    assert.equal(await readFile(mapFile, 'utf8'), currentBefore)

    const currentMap = (await (await fetch(`${server.base}/api/maps/${mapId}`, { headers })).json()).map
    const restored = await fetch(`${server.base}/api/maps/${mapId}/backups/daily/2026-01-01/restore`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: currentMap.version, baseLifecycleVersion: currentMap.lifecycleVersion ?? 0, expectedSnapshotSha256: previewedBackup.snapshotSha256 }) })
    assert.equal(restored.status, 200)
    assert.equal((await restored.json()).map.nodes[0].data.label, '당일 최신 카드')
    assert.equal(await readFile(pastBackupFile, 'utf8'), backupBefore)
    assert.equal(JSON.parse(await readFile(mapFile, 'utf8')).nodes[0].data.label, '당일 최신 카드')
  } finally {
    await server?.stop()
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
