import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')

async function waitForServer(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* 서버 시작 대기 */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Dooray 연결 지점 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

test('데이터 폴더에 연결 설정을 두면 Dooray 업무 미리보기가 외부 모듈을 거치고, 지우면 재시작 없이 원래 API로 돌아간다', { timeout: 40_000 }, async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-dooray-transport-api-'))
  const moduleFile = path.join(dataDirectory, '..', `${path.basename(dataDirectory)}-external.mjs`)
  const upstreamUrls = []
  const upstream = createServer((request, response) => {
    upstreamUrls.push(request.url)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ header: { isSuccessful: true }, result: { subject: '원래 API 업무', project: { id: '11' }, taskNumber: 'API/1' } }))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  // 외부 모듈은 받은 Public API 주소와 인증 헤더를 확인할 수 있게 제목에 남긴다.
  await writeFile(moduleFile, `export async function fetch(input, init) {
    const url = new URL(String(input))
    return new Response(JSON.stringify({ header: { isSuccessful: true }, result: {
      subject: '외부 모듈 업무 ' + url.pathname + ' ' + (init?.headers?.Authorization ?? ''), project: { id: '11' }, taskNumber: 'EXT/1' } }), { status: 200 })
  }`)
  const port = 30_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: { ...process.env, MNP_DATA_DIR: dataDirectory, MNP_API_HOST: '127.0.0.1', MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
      MNP_DOORAY_API_KEY: 'transport-key', MNP_DOORAY_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, MNP_MCP_USAGE_DISABLED: '1' },
    stdio: 'ignore',
  })
  t.after(async () => {
    if (server.exitCode === null) { const done = new Promise((resolve) => server.once('exit', resolve)); server.kill(); await done }
    await new Promise((resolve) => upstream.close(resolve))
    await rm(dataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    await rm(moduleFile, { force: true })
  })
  await waitForServer(baseUrl)
  const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
  const preview = async (postId) => {
    const response = await fetch(`${baseUrl}/api/integrations/dooray/task-preview`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-MNP-Editor-Id': 'user-editor', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://nhnent.dooray.com/task/11/${postId}` }) })
    assert.equal(response.status, 200)
    return (await response.json()).task.subject
  }

  assert.equal(await preview('101'), '원래 API 업무', '설정이 없으면 원래 API')
  assert.equal(upstreamUrls.length, 1)
  await writeFile(path.join(dataDirectory, '_dooray-transport.json'), JSON.stringify({ module: moduleFile }))
  assert.equal(await preview('102'), '외부 모듈 업무 /project/v1/posts/102 dooray-api transport-key', '설정하면 같은 Public API 요청이 외부 모듈로 간다')
  assert.equal(upstreamUrls.length, 1, '외부 모듈을 쓰는 동안 원래 API를 부르지 않는다')
  await rm(path.join(dataDirectory, '_dooray-transport.json'))
  assert.equal(await preview('103'), '원래 API 업무', '설정을 지우면 재시작 없이 원래 API')
  assert.equal(upstreamUrls.length, 2)
})
