import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const childOutputLimit = 8_000

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function captureChildOutput(child) {
  let stdout = ''
  let stderr = ''
  const append = (current, chunk) => `${current}${chunk}`.slice(-childOutputLimit)

  child.stdout?.on('data', (chunk) => {
    stdout = append(stdout, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr = append(stderr, chunk)
  })

  return () => [
    `child stdout:\n${stdout.trim() || '(비어 있음)'}`,
    `child stderr:\n${stderr.trim() || '(비어 있음)'}`,
  ].join('\n')
}

function childTermination(child) {
  if (hasExited(child)) {
    return Promise.resolve({ kind: 'exit', code: child.exitCode, signal: child.signalCode })
  }

  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ kind: 'error', error }))
    child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }))
  })
}

function formatStartupError(message, child, output, lastHealthError) {
  const state = `exitCode=${String(child.exitCode)}, signalCode=${String(child.signalCode)}`
  const health = lastHealthError ? `마지막 health 오류: ${lastHealthError}` : '마지막 health 오류: 없음'
  return new Error(`${message}\nchild 상태: ${state}\n${health}\n${output()}`)
}

function throwIfTerminated(result, child, output, lastHealthError) {
  if (result.kind === 'error') {
    throw formatStartupError(
      `이벤트 스트림 검증 서버 프로세스를 시작하지 못했습니다: ${result.error.message}`,
      child,
      output,
      lastHealthError,
    )
  }
  if (result.kind === 'exit') {
    throw formatStartupError(
      `이벤트 스트림 검증 서버가 준비 전에 종료되었습니다: code=${String(result.code)}, signal=${String(result.signal)}`,
      child,
      output,
      lastHealthError,
    )
  }
}

async function findAvailablePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })

  const address = probe.address()
  if (!address || typeof address === 'string') {
    probe.close()
    throw new Error('운영체제가 할당한 테스트 포트를 확인할 수 없습니다.')
  }

  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}

async function waitForServer(baseUrl, child, output, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const terminated = childTermination(child)
  let lastHealthError = ''

  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw formatStartupError(
        `이벤트 스트림 검증 서버가 ${timeoutMs}ms 안에 시작되지 않았습니다.`,
        child,
        output,
        lastHealthError,
      )
    }

    const health = fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(Math.min(1_000, remaining)),
    }).then(
      (response) => ({ kind: 'health', ok: response.ok, status: response.status }),
      (error) => ({ kind: 'health', ok: false, error }),
    )
    const result = await Promise.race([health, terminated])
    throwIfTerminated(result, child, output, lastHealthError)
    if (result.ok) return

    lastHealthError = result.error?.message ?? `HTTP ${result.status}`
    const pause = new Promise((resolve) => {
      setTimeout(() => resolve({ kind: 'pause' }), Math.min(100, remaining))
    })
    const pauseResult = await Promise.race([pause, terminated])
    throwIfTerminated(pauseResult, child, output, lastHealthError)
  }
}

async function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return true

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopChild(child, output) {
  if (hasExited(child)) return

  child.kill()
  if (await waitForExit(child, 2_000)) return

  child.kill('SIGKILL')
  if (await waitForExit(child, 2_000)) return

  throw new Error(`이벤트 스트림 검증 서버 프로세스를 종료하지 못했습니다.\n${output()}`)
}

test('이벤트 스트림이 클라이언트가 확인할 수 있는 heartbeat를 전송한다', { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-event-stream-api-'))
  const port = await findAvailablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_EVENT_HEARTBEAT_INTERVAL_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const output = captureChildOutput(server)
  const controller = new AbortController()
  let timeout = null

  try {
    await waitForServer(baseUrl, server, output)
    const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const response = await fetch(`${baseUrl}/api/events?clientId=test-event-stream`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-MNP-Editor-Id': 'user-editor',
      },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/)

    timeout = setTimeout(() => controller.abort(), 5_000)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let received = ''
    while (!received.includes('"type":"heartbeat"')) {
      const result = await reader.read()
      if (result.done) break
      received += decoder.decode(result.value, { stream: true })
    }
    assert.match(received, /"type":"connected"/)
    assert.match(received, /"type":"heartbeat"/)
    await reader.cancel()
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
    try {
      await stopChild(server, output)
    } finally {
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }
})
