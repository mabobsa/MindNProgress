import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const actor = { id: 'fixture', name: '격리 검증', role: 'editor' }
export const knowledge = '검증용 공유 지식입니다. '.repeat(400)
export const fixture = (id) => ({ id, title: `격리 검증 ${id}`, version: 1, color: 'violet',
  createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', createdBy: actor, updatedBy: actor,
  nodes: Array.from({ length: 20 }, (_, i) => ({ id: `card-${i}`, type: 'mind', position: { x: i * 300, y: 0 },
    data: { label: `검증 카드 ${i}`, description: '격리 환경의 시험 본문입니다. '.repeat(100), sharedKnowledge: knowledge,
      kind: i ? 'branch' : 'root', status: 'planned', progress: 0, isWork: false } })),
  edges: Array.from({ length: 19 }, (_, i) => ({ id: `edge-${i}`, source: 'card-0', target: `card-${i + 1}`, data: { relation: 'hierarchy' } })) })

export async function storageApi(t, { documents = 96, seed = async () => {}, mockAion, env = {}, readyTimeoutMs = 15000 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-storage-02-'))
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep))
  const data = path.join(directory, 'data')
  await mkdir(path.join(data, '_comments'), { recursive: true })
  await writeFile(path.join(data, '_users.json'), JSON.stringify([
    { id: 'user-editor', name: '김용민', email: 'editor@mind.local', role: 'editor', active: true, salt: 'fixture', passwordHash: '11'.repeat(64) },
    { id: 'user-second', name: '다른 편집자', email: 'second@mind.local', role: 'editor', active: true, salt: 'fixture', passwordHash: '22'.repeat(64) },
  ]))
  const ids = Array.from({ length: documents }, (_, i) => `map-bench-${i}`)
  for (const id of ids) await writeFile(path.join(data, `${id}.json`), JSON.stringify(fixture(id)))
  await seed({ data, ids })
  const fakeAion = createServer((request, response) => {
    void Promise.resolve(mockAion?.(request.url) ?? { id: request.url.split('/').at(-1), name: '격리 검증 대화', runtimes: [] }).then((data) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: true, data }))
    })
  })
  await new Promise((resolve) => fakeAion.listen(0, '127.0.0.1', resolve))
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const base = `http://127.0.0.1:${port}`
  let output = ''
  const spawnOptions = {
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '../..'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, MNP_DATA_DIR: data, MNP_TOKEN_FILE: path.join(data, '_integration-token'),
      MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port), MNP_API_URL: base, MNP_PUBLIC_URL: base,
      MNP_MACHINE_ID: 'isolated-storage', MNP_MCP_USAGE_DISABLED: '1', MNP_COMPLETED_AI_CLEANUP_DISABLED: '1',
      MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'), MNP_AIONUI_URL: `http://127.0.0.1:${fakeAion.address().port}`,
      MNP_AIONUI_DISCOVERY_FILE: path.join(directory, 'no-discovery.json'), MNP_AIONUI_USAGE_FILE: path.join(directory, 'no-usage.json'),
      AIONUI_CONVERSATION_ID: '', MNP_ADMIN_EMAIL: 'isolated@mind.local', MNP_ADMIN_PASSWORD: 'IsolatedOnly!2026', ...env },
  }
  let child, exited
  const launch = () => {
    child = spawn(process.execPath, ['--import', new URL('./storage-fs-barrier.mjs', import.meta.url).href,
      '--import', new URL('./storage-crash-phases.mjs', import.meta.url).href, 'server/index.mjs'], spawnOptions)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  }
  launch()
  t.after(async () => {
    child.kill(); await exited
    await new Promise((resolve) => fakeAion.close(resolve))
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    assert.doesNotMatch(output, /RESOURCE_(?:NOT_HELD|ORDER_VIOLATION|UPGRADE_FORBIDDEN)/, output)
  })
  async function waitReady() {
  let ready = false
  for (let attempt = 0; attempt < Math.ceil(readyTimeoutMs / 50); attempt++) {
    assert.equal(child.exitCode, null, output)
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break } } catch { /* 시작 대기 */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(ready, output)
  }
  await waitReady()
  const headers = { Authorization: `Bearer ${(await readFile(path.join(data, '_integration-token'), 'utf8')).trim()}`,
    'X-MNP-AI-Editor-Id': 'user-editor', 'X-MNP-AI-Type': 'Fixture AI', 'X-MNP-AI-Model': 'fixture', 'Content-Type': 'application/json' }
  const call = async (route, method = 'GET', body, extraHeaders = {}) => {
    const response = await fetch(base + route, { method, headers: { ...headers, ...extraHeaders }, signal: AbortSignal.timeout(20_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).catch((error) => { throw new Error(`${method} ${route}: ${error.message}\n${output}`, { cause: error }) })
    return { status: response.status, body: await response.json() }
  }
  return { data, ids, base, headers, call, ...storageControl(child, data), output: () => output,
    env: spawnOptions.env, directory,
    restart: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); const exit = await exited; launch(); await waitReady(); return exit },
    stop: async () => { child.kill('SIGKILL'); return exited },
    crash: async (name, extra = {}) => {
      const armed = new Promise((resolve) => { const listener = (value) => {
        if (value?.phase === 'crash-armed') { child.off('message', listener); resolve() }
      }; child.on('message', listener) })
      child.send({ action: 'crash-phase', name, ...extra }); await armed
    },
    read: async (relative) => JSON.parse(await readFile(path.join(data, relative), 'utf8')) }
}

export function storageControl(child, data) {
  let sequence = 0
  const message = (id, phase) => new Promise((resolve) => {
    const listener = (value) => { if (value?.id === id && value.phase === phase) { child.off('message', listener); resolve(value) } }
    child.on('message', listener)
  })
  async function barrier(file, method = 'readFile', { fail = false, failAfter = false, skip = 0, prefix = false } = {}) {
    const id = ++sequence
    const ready = message(id, 'armed')
    const reached = message(id, 'reached')
    child.send({ id, action: 'arm', file: path.resolve(data, file), method, fail, failAfter, skip, prefix })
    await ready
    return { reached, release: () => child.send({ id, action: 'release' }) }
  }
  const tick = async (delay) => {
    const id = ++sequence, ticked = message(id, 'ticked')
    child.send({ id, action: 'tick', delay })
    assert.ok((await ticked).count > 0, `예약 주기 ${delay} 등록 확인`)
  }
  const enableCleanup = async () => {
    const id = ++sequence, ready = message(id, 'cleanup-enabled')
    child.send({ id, action: 'enable-cleanup' }); await ready
  }
  const readMetrics = async (reset = false) => {
    const id = ++sequence, ready = message(id, 'read-metrics')
    child.send({ id, action: 'read-metrics', reset }); return (await ready).value
  }
  return { barrier, tick, enableCleanup, readMetrics }
}
