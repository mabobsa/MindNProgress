import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import test from 'node:test'
import { createRuntimeLifecycle } from '../server/lib/runtimeLifecycle.mjs'
import { MachineOperationQueue } from '../server/lib/machineOperations.mjs'
import { isRuntimeStoppingError } from '../server/lib/runtimeStopping.mjs'

test('정상 종료는 응답 후 저장과 중첩 백그라운드 작업을 기다리고 반복 작업을 중지한다', async () => {
  const runtime = createRuntimeLifecycle()
  let finishWrite, finishBackground, received
  const accepted = new Promise((resolve) => { received = resolve })
  const writing = new Promise((resolve) => { finishWrite = resolve })
  const background = new Promise((resolve) => { finishBackground = resolve })
  let written = false, backgroundDone = false, ticks = 0, stopped = false
  const server = createServer(runtime.request(async (_request, response) => {
    response.end('saved later')
    received()
    await writing
    written = true
    void runtime.track(async () => { await background; backgroundDone = true })
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  runtime.interval(() => { ticks++ }, 5, 'test')
  await fetch(`http://127.0.0.1:${server.address().port}`)
  await accepted
  const shutdown = runtime.stop(server).then(() => { stopped = true })
  const count = ticks
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(stopped, false)
  assert.equal(ticks, count)
  finishWrite()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(written, true)
  assert.equal(stopped, false)
  finishBackground()
  await shutdown
  assert.equal(backgroundDone, true)
})

test('종료 후 요청은 503이며 SSE를 닫아 종료를 지연시키지 않는다', async () => {
  const runtime = createRuntimeLifecycle()
  const streams = new Set()
  let connected
  const ready = new Promise((resolve) => { connected = resolve })
  const server = createServer(runtime.request((_request, response) => {
    streams.add(response)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: connected\n\n')
    connected()
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const response = await fetch(`http://127.0.0.1:${server.address().port}`)
  await ready
  await runtime.stop(server, () => { for (const stream of streams) stream.end() })
  await response.text()
  let status, body
  runtime.request(() => assert.fail('must not run'))({}, { writeHead: (value) => { status = value }, end: (value) => { body = value } })
  assert.equal(status, 503)
  assert.match(body, /종료/)
})

test('응답을 끝내지 않는 연결은 추적 작업을 마친 뒤 유예 시간이 지나면 정리한다', { timeout: 20_000 }, async () => {
  const runtime = createRuntimeLifecycle()
  const server = createServer(runtime.request((_request, response) => { response.end('ok') }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let backgroundDone = false
  void runtime.track(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); backgroundDone = true })
  // 요청 줄만 보낸 연결은 유휴로 판정되지 않아 server.close()가 끝나지 않는다.
  const socket = connect(server.address().port, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise((resolve) => socket.once('connect', resolve))
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const started = Date.now()
  await runtime.stop(server, () => {}, { connectionGraceMs: 50 })
  const elapsed = Date.now() - started
  socket.destroy()
  assert.equal(backgroundDone, true)
  assert.ok(elapsed >= 50, `유예 전에는 연결을 끊지 않는다: ${elapsed}ms`)
  assert.ok(elapsed < 10_000, `유예 뒤에는 남은 연결을 정리하고 종료한다: ${elapsed}ms`)
})

test('드레인이 실패하면 프로세스를 종료해 감시자가 무한 대기하지 않는다', { timeout: 20_000 }, async () => {
  const moduleUrl = new URL('../server/lib/runtimeLifecycle.mjs', import.meta.url).href
  const source = `const { installRuntimeShutdown } = await import(${JSON.stringify(moduleUrl)})\n`
    + `installRuntimeShutdown(async () => { throw new Error('drain failed') })\n`
    + `setInterval(() => {}, 1000)\n`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  try {
    await new Promise((resolve) => child.on('message', (message) => { if (message?.type === 'mnp:shutdown-ready') resolve() }))
    child.send({ type: 'mnp:shutdown' })
    assert.equal(await new Promise((resolve) => child.once('exit', resolve)), 1)
  } finally { if (child.exitCode === null) child.kill('SIGKILL') }
})

test('종료는 만료 타이머를 멈춰도 머신 결과와 롱폴을 해제하고 후속 저장을 기다린다', async () => {
  const runtime = createRuntimeLifecycle()
  const queue = new MachineOperationQueue()
  runtime.signal.addEventListener('abort', () => queue.shutdown(), { once: true })
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let written = false
  const operation = queue.enqueue('offline', { pathname: '/query' })
  void runtime.track(async () => {
    try { await operation.completion } catch (error) { assert.equal(isRuntimeStoppingError(error), true) }
    await new Promise(resolve => setTimeout(resolve, 30))
    written = true
  }, 'Operation cleanup')
  void runtime.track(() => queue.waitForClaim('idle', { waitMs: 25_000 }), 'Runner long-poll').catch(error => assert.equal(isRuntimeStoppingError(error), true))
  runtime.interval(() => queue.sweep(), 5, 'Operation sweep')
  const started = performance.now()
  await runtime.stop(server)
  assert.equal(written, true)
  assert.equal(queue.waiters.size, 0)
  assert.ok(performance.now() - started < 1_000)
})

test('미완료 POST 본문은 종료 신호로 중단되지만 완성된 본문 뒤 저장은 끝까지 기다린다', async () => {
  const runtime = createRuntimeLifecycle()
  let accepted
  const ready = new Promise(resolve => { accepted = resolve })
  let written = false
  const server = createServer(runtime.request(async (request, response) => {
    accepted()
    const body = await runtime.readJsonBody(request)
    await new Promise(resolve => setTimeout(resolve, 40))
    written = body.save === true
    response.end('ok')
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const socket = connect(server.address().port, '127.0.0.1')
  socket.on('error', () => {})
  await new Promise(resolve => socket.once('connect', resolve))
  socket.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 30\r\n\r\nx')
  await ready
  await runtime.stop(server)
  assert.equal(written, false)
  socket.destroy()

  const completed = createRuntimeLifecycle()
  let parsed
  const parsedBody = new Promise(resolve => { parsed = resolve })
  const second = createServer(completed.request(async (request, response) => {
    const body = await completed.readJsonBody(request)
    parsed()
    await new Promise(resolve => setTimeout(resolve, 40))
    written = body.save === true
    response.end('ok')
  }))
  await new Promise(resolve => second.listen(0, '127.0.0.1', resolve))
  const response = fetch(`http://127.0.0.1:${second.address().port}`, { method: 'POST', body: JSON.stringify({ save: true }) }).then(value => value.text())
  await parsedBody
  await completed.stop(second)
  await response
  assert.equal(written, true)
})

test('진단 시간이 지나도 저장을 포기하지 않고 작업 이름을 기록하며 종료를 기다리지 않는다', async () => {
  const runtime = createRuntimeLifecycle()
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let written = false
  const logs = []
  void runtime.track(async () => { await new Promise(resolve => setTimeout(resolve, 60)); written = true }, 'Delayed save')
  await runtime.stop(server, () => {}, { diagnosticMs: 10, warn: (...args) => logs.push(args.join(' ')) })
  assert.equal(written, true)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /Delayed save/)
})
