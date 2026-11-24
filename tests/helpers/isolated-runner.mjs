import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'

// 연결·인증·Node preload·Git 설정을 개발 세션에서 시험 프로세스로 전달하지 않는다.
export function isolatedProcessEnvironment(source = process.env) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'PATHEXT', 'LANG', 'LC_ALL']
  return { ...Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => [key, source[key]])),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' }
}

function loopbackUrl(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', '시험 서버는 로컬 HTTP 서버여야 합니다.')
  assert.equal(url.hostname, '127.0.0.1', '시험 서버는 명시한 loopback 주소여야 합니다.')
  assert.ok(url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/')
  return url.origin
}

async function contained(root, file, { directory = false } = {}) {
  assert.ok(path.isAbsolute(file), '시험 경로는 절대 경로여야 합니다.')
  const resolved = await realpath(directory ? file : path.dirname(file))
  const relative = path.relative(root, resolved)
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    '시험 파일은 소유한 임시 디렉터리 내부여야 합니다.')
  if (!directory) {
    const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    assert.ok(!info?.isSymbolicLink(), '시험 파일의 심볼릭 링크는 허용하지 않습니다.')
  }
}

export async function isolatedBundledRunner(t, { entry, apiUrl, coreUrl, workspaceRoot, registryFile = '',
  agentModule = '', machineId = 'macbook', token = 'isolated-runner-token' }) {
  assert.ok(path.isAbsolute(entry) && (await lstat(entry)).isFile())
  const apiBase = loopbackUrl(apiUrl), coreBase = loopbackUrl(coreUrl)
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mnp-bundled-runner-')))
  const temporary = path.join(root, 'tmp'), descriptorDirectory = path.join(root, 'relay')
  await mkdir(temporary); await mkdir(descriptorDirectory)
  const descriptorFile = path.join(descriptorDirectory, 'mcp-relay.json')
  const expected = {
    ...isolatedProcessEnvironment(), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    MNP_RUNNER_API_URL: apiBase, MNP_RUNNER_AIONUI_URL: coreBase,
    MNP_RUNNER_MACHINE_ID: machineId, MNP_RUNNER_TOKEN: token,
    MNP_RUNNER_HEARTBEAT_MS: '5000', MNP_RUNNER_MCP_RELAY_FILE: descriptorFile,
    MNP_RUNNER_WORKSPACE_REGISTRY: registryFile, MNP_RUNNER_WORKSPACE_AGENT_MODULE: agentModule,
  }
  let child, exited, started = false, output = '', disposed = false

  async function validate(environment) {
    // 누락·기본 경로·다른 시험의 descriptor·상속 환경을 spawn 전에 거절한다.
    assert.deepEqual(Object.keys(environment).sort(), Object.keys(expected).sort(), '시험 환경 키가 일치해야 합니다.')
    for (const key of Object.keys(expected)) assert.ok(environment[key] === expected[key], `시험 환경 불일치: ${key}`)
    await contained(root, descriptorFile)
    await contained(root, temporary, { directory: true })
    assert.equal(Boolean(registryFile), Boolean(agentModule), 'registry와 agent는 함께 지정해야 합니다.')
    if (registryFile) {
      const workspace = await realpath(workspaceRoot)
      // registry는 명시한 Git fixture root에 있고, 쓰기 대상들은 그 내부여야 한다.
      assert.equal(await realpath(path.dirname(registryFile)), workspace)
      assert.ok(!(await lstat(registryFile)).isSymbolicLink())
      const registry = JSON.parse(await readFile(registryFile, 'utf8'))
      await contained(workspace, registry.sharedRoot, { directory: true })
      for (const item of registry.workspaces) await contained(workspace, item.root, { directory: true })
      assert.equal(await realpath(agentModule), await realpath(new URL('../../runner/lib/workspaceAgent.mjs', import.meta.url)))
    }
  }

  async function stop(signal = 'SIGTERM') {
    if (!child) return null
    if (child.exitCode !== null || child.signalCode !== null) return exited
    child.kill(signal)
    let timeout
    const expired = new Promise(resolve => { timeout = setTimeout(() => resolve(null), 8000) })
    const result = await Promise.race([exited, expired])
    clearTimeout(timeout)
    if (result) return result
    // 시험에서 생성한 PID만 회수한다. 정상 종료 실패는 숨기지 않고 시험 실패로 남긴다.
    child.kill('SIGKILL'); await exited
    throw new Error('시험용 Runner가 정상 종료되지 않아 해당 시험 PID만 회수했습니다.')
  }

  async function dispose() {
    if (disposed) return
    try { await stop() } finally {
      await rm(root, { recursive: true, force: true })
      disposed = true
    }
  }
  t.after(dispose)
  return {
    root, descriptorFile, environment: { ...expected }, validate, stop, dispose,
    output: () => output,
    exit: () => exited,
    async start(environment = expected) {
      assert.ok(!started && !disposed, '시험 Runner와 descriptor는 한 번만 점유할 수 있습니다.')
      await validate(environment)
      assert.equal(await lstat(descriptorFile).catch(error => { if (error.code === 'ENOENT') return null; throw error }), null,
        '기존 descriptor를 덮어쓸 수 없습니다.')
      // await 없는 구간에서 점유한 뒤 시작하므로 동일 fixture 병행 시작을 거절한다.
      assert.ok(!started, '시험 Runner는 중복 시작할 수 없습니다.')
      started = true
      child = spawn(process.execPath, [entry], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: environment })
      exited = new Promise(resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
        child.once('error', () => resolve({ spawnFailed: true }))
      })
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      return child
    },
    async descriptor() {
      for (let attempt = 0; attempt < 200; attempt++) {
        assert.ok(child && child.exitCode === null && child.signalCode === null, '시험 Runner가 준비 전에 종료됐습니다.')
        const value = await readFile(descriptorFile, 'utf8').then(JSON.parse).catch(error => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (value) {
          assert.equal(value.pid, child.pid)
          return { pid: value.pid, instanceId: value.instanceId, baseUrl: value.baseUrl }
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      throw new Error('시험용 descriptor 생성 대기 시간이 초과됐습니다.')
    },
  }
}
