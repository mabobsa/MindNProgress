import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

test('연동 토큰이 교체되면 실행 중인 MCP가 토큰 파일을 다시 읽어 한 번만 재시도한다', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-token-rotation-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tokenFile = path.join(directory, '_integration-token')
  const oldToken = 'old-token-'.padEnd(43, 'o')
  const newToken = 'new-token-'.padEnd(43, 'n')
  await writeFile(tokenFile, `${oldToken}\n`)
  let acceptedToken = oldToken
  const requests = []
  const server = createServer((request, response) => {
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /, '')
    requests.push(token === oldToken ? 'old' : token === newToken ? 'new' : 'other')
    const accepted = token === acceptedToken
    response.writeHead(accepted ? 200 : 401, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(accepted ? { assignees: [{ id: 'user-editor', name: '편집자' }] } : { error: '로그인이 필요합니다.' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const client = new Client({ name: 'token-rotation-test', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(import.meta.dirname, '../mcp/server.mjs')],
    env: { ...process.env, MNP_API_URL: `http://127.0.0.1:${server.address().port}`, MNP_TOKEN_FILE: tokenFile,
      MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: '' },
    stderr: 'pipe',
  }))
  const listUsers = () => client.callTool({ name: 'mindnprogress_list_users', arguments: {} })

  assert.notEqual((await listUsers()).isError, true)
  assert.deepEqual(requests, ['old'])

  // MnP 재시작으로 토큰이 바뀐 상황: 기억한 옛 토큰은 401, 파일에는 새 토큰이 있다.
  acceptedToken = newToken
  await writeFile(tokenFile, `${newToken}\n`)
  assert.notEqual((await listUsers()).isError, true)
  assert.deepEqual(requests, ['old', 'old', 'new'])

  // 갱신한 뒤에는 처음부터 새 토큰을 쓴다.
  assert.notEqual((await listUsers()).isError, true)
  assert.deepEqual(requests.slice(3), ['new'])

  // 토큰이 그대로인 401(신원 불일치 등)은 다시 보내지 않고 오류를 돌려준다.
  acceptedToken = 'not-issued'
  const denied = await listUsers()
  assert.equal(denied.isError, true)
  assert.match(denied.content[0].text, /로그인이 필요합니다/)
  assert.deepEqual(requests.slice(4), ['new'])
})
