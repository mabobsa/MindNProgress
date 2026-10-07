import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const project = path.resolve(import.meta.dirname, '..')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
function command(descriptor, instanceId = descriptor.instanceId) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.pipe)
    socket.setTimeout(2000, () => socket.destroy(new Error('control timeout')))
    socket.on('error', reject)
    let reply = ''
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'mnp:shutdown', instanceId }) + '\n'))
    socket.on('data', (chunk) => { reply += chunk })
    socket.on('end', () => resolve(reply.trim()))
  })
}

test('감시자는 정상 종료 중 API가 반환한 실패 종료 코드를 보존한다', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-supervisor-failure-'))
  const fixtureFile = path.join(directory, 'child.mjs')
  const hostFile = path.join(directory, 'host.mjs')
  await writeFile(fixtureFile, `process.on('message', message => { if (message?.type === 'mnp:shutdown') process.exit(Number(process.argv[2])) });
process.on('disconnect', () => process.exit(0));
process.send({ type: 'mnp:shutdown-ready' });
console.log('fixture-ready-' + process.argv[2]);`)
  const moduleUrl = pathToFileURL(path.join(project, 'scripts/runtime/supervisor.mjs')).href
  await writeFile(hostFile, `import { supervise } from ${JSON.stringify(moduleUrl)};
await supervise({ projectDirectory: ${JSON.stringify(directory)}, stateDirectory: ${JSON.stringify(directory)}, entries: [
{ name: 'api', file: ${JSON.stringify(fixtureFile)}, args: ['1'] },
{ name: 'web', file: ${JSON.stringify(fixtureFile)}, args: ['0'] }] });`)
  const child = spawn(process.execPath, [hostFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', descriptor
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  const done = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  try {
    for (let i = 0; i < 100; i++) {
      try { descriptor = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8')) } catch {}
      if (descriptor && output.includes('fixture-ready-1') && output.includes('fixture-ready-0')) break
      await wait(50)
    }
    assert.ok(descriptor, output)
    assert.equal(await command(descriptor), 'accepted')
    assert.equal(await done, 1, output)
    assert.match(output, /api shutdown exit code 1/)
    assert.match(output, /web process exit/)
  } finally {
    if (child.exitCode === null && descriptor) {
      try { await command(descriptor); await Promise.race([done, wait(2000)]) } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await done }
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-supervisor-failure-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('독립 감시자는 API·웹을 정상 종료하고 새 인스턴스로 시작하며 잘못된 제어 요청·중복 기동을 거부한다', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-runtime-test-'))
  const apiPort = await freePort(), webPort = await freePort()
  assert.notEqual(apiPort, webPort)
  let child, done, descriptor, output = ''
  const children = []
  const env = { ...process.env, MNP_RUNTIME_STATE_DIR: path.join(directory, 'state'), MNP_DATA_DIR: path.join(directory, 'data'),
    MNP_API_PORT: String(apiPort), MNP_WEB_PORT: String(webPort), MNP_API_HOST: '127.0.0.1',
    MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'),
    MNP_ADMIN_EMAIL: 'runtime-test@mind.local', MNP_ADMIN_PASSWORD: 'isolated-runtime-test-password' }
  const start = () => {
    child = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: project, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    child.stdout.on('data', (data) => { output += data })
    child.stderr.on('data', (data) => { output += data })
    done = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  }
  const ready = async () => {
    for (let i = 0; i < 180; i++) {
      if (child.exitCode !== null) throw new Error(`runtime exited: ${output}`)
      try {
        descriptor = JSON.parse(await readFile(path.join(env.MNP_RUNTIME_STATE_DIR, 'runtime.json'), 'utf8'))
        const [api, web] = await Promise.all([fetch(`http://127.0.0.1:${apiPort}/api/health`), fetch(`http://127.0.0.1:${webPort}`)])
        if (api.status === 200 && web.status === 200) return
      } catch {}
      await wait(100)
    }
    throw new Error(`runtime not ready: ${output}`)
  }
  try {
    start(); await ready()
    const original = descriptor
    assert.equal(await command(descriptor, 'wrong-instance'), 'rejected')
    assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/health`)).status, 200)
    // The stale PID hint deliberately points at this unrelated test process.
    await writeFile(path.join(env.MNP_RUNTIME_STATE_DIR, 'dev.pids'), String(process.pid))
    const duplicate = spawn(process.execPath, ['scripts/dev.mjs'], { cwd: project, windowsHide: true, env, stdio: 'ignore' })
    children.push(duplicate)
    assert.notEqual(await new Promise((resolve) => duplicate.once('exit', resolve)), 0)
    assert.equal(JSON.parse(await readFile(path.join(env.MNP_RUNTIME_STATE_DIR, 'runtime.json'), 'utf8')).instanceId, original.instanceId)
    const started = performance.now()
    if (process.platform === 'win32') {
      const ps = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          ". (Join-Path $env:MNP_TEST_PROJECT 'scripts/mnp-runtime.ps1'); $descriptor = Get-Content -LiteralPath (Join-Path $env:MNP_RUNTIME_STATE_DIR 'runtime.json') -Raw | ConvertFrom-Json; $record = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $descriptor.pid); $context = [pscustomobject]@{ Project=$env:MNP_TEST_PROJECT; StateDirectory=$env:MNP_RUNTIME_STATE_DIR }; $snapshot = [pscustomobject]@{ Records=@([pscustomobject]@{ Role='supervisor'; Process=$record }) }; $verified = Get-MnpDescriptor $context $snapshot; if (-not $verified) { throw 'descriptor verification failed' }; Send-MnpShutdown $verified"],
        { windowsHide: true, env: { ...env, MNP_TEST_PROJECT: project }, stdio: ['ignore', 'pipe', 'pipe'] })
      let message = ''
      ps.stdout.on('data', (data) => { message += data }); ps.stderr.on('data', (data) => { message += data })
      assert.equal(await new Promise((resolve) => ps.once('exit', resolve)), 0, message)
    } else assert.equal(await command(descriptor), 'accepted')
    assert.equal(await done, 0)
    for (const entry of original.children) assert.throws(() => process.kill(entry.pid, 0))
    await assert.rejects(readFile(path.join(env.MNP_RUNTIME_STATE_DIR, 'runtime.json')), { code: 'ENOENT' })
    start(); await ready()
    assert.notEqual(descriptor.instanceId, original.instanceId)
    assert.notEqual(descriptor.pid, original.pid)
    console.log(`[isolated runtime stop + start + HTTP] ${Math.round(performance.now() - started)}ms`)
    console.log(output.split(/\r?\n/).filter((line) => line.startsWith('[Runtime')).join('\n'))
    assert.equal(await command(descriptor), 'accepted')
    assert.equal(await done, 0)
  } finally {
    if (child?.exitCode === null && descriptor) { try { await command(descriptor); await Promise.race([done, wait(5000)]) } catch {} }
    // Only processes spawned by this fixture may be cleaned up.
    for (const spawned of children) if (spawned.exitCode === null) spawned.kill()
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-runtime-test-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
