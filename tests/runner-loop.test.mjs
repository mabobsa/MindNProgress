import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RUNNER_DEFAULT_CONCURRENCY,
  RunnerConfigError,
  describeRunnerConfig,
  normalizeRunnerConfig,
  runnerClaimUrl,
  runnerHeartbeatUrl,
  runnerResultUrl,
} from '../runner/lib/runnerConfig.mjs'
import { createRunnerLoop } from '../runner/lib/runnerLoop.mjs'

const baseEnvironment = {
  MNP_RUNNER_API_URL: 'http://192.168.0.10:4176',
  MNP_RUNNER_MACHINE_ID: 'macbook',
  MNP_RUNNER_TOKEN: 'mnprn_secret',
}

function operation(operationId, pathname, overrides = {}) {
  return {
    operationId,
    request: { method: 'GET', pathname, timeoutMs: 8_000, ...overrides },
  }
}

test('필수 설정이 없으면 실행을 거부한다', () => {
  assert.throws(() => normalizeRunnerConfig({}), RunnerConfigError)
  assert.throws(() => normalizeRunnerConfig({ ...baseEnvironment, MNP_RUNNER_MACHINE_ID: 'Mac_Book' }), RunnerConfigError)
  assert.throws(() => normalizeRunnerConfig({ ...baseEnvironment, MNP_RUNNER_TOKEN: '  ' }), RunnerConfigError)
  assert.throws(() => normalizeRunnerConfig({ ...baseEnvironment, MNP_RUNNER_API_URL: 'ftp://host' }), RunnerConfigError)
  assert.throws(() => normalizeRunnerConfig({ ...baseEnvironment, MNP_RUNNER_API_URL: '' }), RunnerConfigError)
})

test('머신 ID는 소문자로 맞추고 주소는 경로를 제거해 정규화한다', () => {
  const config = normalizeRunnerConfig({
    ...baseEnvironment,
    MNP_RUNNER_MACHINE_ID: 'MacBook',
    MNP_RUNNER_API_URL: '192.168.0.10:4176/api/ignored?x=1',
  })

  assert.equal(config.machineId, 'macbook')
  assert.equal(config.apiBaseUrl, 'http://192.168.0.10:4176')
  assert.equal(config.aionUiBaseUrl, null)
  assert.equal(config.concurrency, RUNNER_DEFAULT_CONCURRENCY)
})

test('동시 실행 수와 대기 시간은 허용 범위 안으로 맞춘다', () => {
  const tooLow = normalizeRunnerConfig({ ...baseEnvironment, MNP_RUNNER_CONCURRENCY: '0', MNP_RUNNER_RETRY_MS: '10' })
  assert.equal(tooLow.concurrency, RUNNER_DEFAULT_CONCURRENCY)
  assert.equal(tooLow.retryDelayMs, 500)

  const tooHigh = normalizeRunnerConfig({ ...baseEnvironment, MNP_RUNNER_CONCURRENCY: '999', MNP_RUNNER_HEARTBEAT_MS: '9999999' })
  assert.equal(tooHigh.concurrency, 16)
  assert.equal(tooHigh.heartbeatIntervalMs, 600_000)
})

test('요청 주소는 머신 ID를 이스케이프해 만든다', () => {
  const config = normalizeRunnerConfig(baseEnvironment)
  assert.equal(runnerClaimUrl(config), 'http://192.168.0.10:4176/api/machines/macbook/runner/operations/claim')
  assert.equal(runnerResultUrl(config, 'op/1'), 'http://192.168.0.10:4176/api/machines/macbook/runner/operations/op%2F1/result')
  assert.equal(runnerHeartbeatUrl(config), 'http://192.168.0.10:4176/api/machines/macbook/runner/heartbeat')
})

test('설정 요약에는 토큰을 넣지 않는다', () => {
  const summary = describeRunnerConfig(normalizeRunnerConfig(baseEnvironment))
  assert.doesNotMatch(summary, /mnprn_secret/)
  assert.match(summary, /machineId=macbook/)
})

test('가져온 오퍼레이션을 로컬 AionUi에 전달하고 결과를 올린다', async () => {
  const calls = []
  const reported = []
  const loop = createRunnerLoop({
    claimOperations: async () => [operation('op-1', '/api/conversations', { method: 'POST', body: { title: '테스트' } })],
    callAionUi: async (request) => {
      calls.push(request)
      return { ok: true, data: { conversationId: 'abc' } }
    },
    reportResult: async (operationId, result) => { reported.push([operationId, result]) },
  })

  assert.equal(await loop.runOnce(), 1)
  assert.deepEqual(calls, [{ method: 'POST', pathname: '/api/conversations', timeoutMs: 8_000, body: { title: '테스트' } }])
  assert.deepEqual(reported, [['op-1', { ok: true, data: { conversationId: 'abc' } }]])
})

test('가져올 오퍼레이션이 없으면 아무것도 호출하지 않는다', async () => {
  let called = 0
  const loop = createRunnerLoop({
    claimOperations: async () => [],
    callAionUi: async () => { called += 1; return { ok: true } },
    reportResult: async () => {},
  })

  assert.equal(await loop.runOnce(), 0)
  assert.equal(called, 0)
})

test('로컬 AionUi 호출이 실패해도 결과를 반드시 올린다', async () => {
  const reported = []
  const loop = createRunnerLoop({
    claimOperations: async () => [operation('op-1', '/api/down')],
    callAionUi: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1986') },
    reportResult: async (operationId, result) => { reported.push([operationId, result]) },
  })

  await loop.runOnce()
  // 결과를 비워 두면 요청자가 서버 상한까지 기다려야 한다.
  assert.equal(reported.length, 1)
  assert.equal(reported[0][1].ok, false)
  assert.equal(reported[0][1].code, 'RUNNER_LOCAL_CALL_FAILED')
  assert.match(reported[0][1].message, /ECONNREFUSED/)
})

test('AionUi가 오류 응답을 주면 상태와 코드를 그대로 올린다', async () => {
  const reported = []
  const loop = createRunnerLoop({
    claimOperations: async () => [operation('op-1', '/api/missing')],
    callAionUi: async () => ({ ok: false, status: 404, code: 'NOT_FOUND' }),
    reportResult: async (operationId, result) => { reported.push([operationId, result]) },
  })

  await loop.runOnce()
  assert.deepEqual(reported, [['op-1', { ok: false, status: 404, code: 'NOT_FOUND' }]])
})

test('결과 전달이 실패해도 같은 오퍼레이션을 다시 실행하지 않는다', async () => {
  const events = []
  let callCount = 0
  const loop = createRunnerLoop({
    claimOperations: async () => [operation('op-1', '/api/x')],
    callAionUi: async () => { callCount += 1; return { ok: true, data: {} } },
    reportResult: async () => { throw new Error('MNP_REQUEST_FAILED:409') },
    onEvent: (event) => events.push(event.type),
  })

  await loop.runOnce()
  assert.equal(callCount, 1)
  assert.ok(events.includes('report-failed'))
})

test('여러 오퍼레이션을 동시 실행 수 안에서 처리한다', async () => {
  const operations = Array.from({ length: 7 }, (_, index) => operation(`op-${index}`, `/api/${index}`))
  let active = 0
  let peak = 0
  const reported = []

  const loop = createRunnerLoop({
    claimOperations: async () => operations,
    callAionUi: async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return { ok: true, data: {} }
    },
    reportResult: async (operationId) => { reported.push(operationId) },
    concurrency: 2,
  })

  assert.equal(await loop.runOnce(), 7)
  assert.equal(reported.length, 7)
  assert.ok(peak <= 2, `동시 실행 ${peak}건은 상한 2건을 넘었습니다.`)
})

test('MnP 연결이 끊기면 대기 후 다시 시도하고 중단하면 주기를 끝낸다', async () => {
  const events = []
  const sleeps = []
  let attempts = 0

  const loop = createRunnerLoop({
    claimOperations: async () => {
      attempts += 1
      if (attempts <= 2) throw new Error('fetch failed')
      loop.stop()
      return []
    },
    callAionUi: async () => ({ ok: true }),
    reportResult: async () => {},
    retryDelayMs: 3_000,
    sleep: async (ms) => { sleeps.push(ms) },
    onEvent: (event) => events.push(event.type),
  })

  await loop.start()
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [3_000, 3_000])
  assert.equal(events.filter((type) => type === 'claim-failed').length, 2)
  assert.equal(events.at(-1), 'stopped')
  assert.equal(loop.running, false)
})

test('이미 실행 중인 주기를 다시 시작하지 않는다', async () => {
  const loop = createRunnerLoop({
    claimOperations: async () => { loop.stop(); return [] },
    callAionUi: async () => ({ ok: true }),
    reportResult: async () => {},
  })

  const first = loop.start()
  await assert.rejects(() => loop.start(), /이미 실행 중/)
  await first
})
