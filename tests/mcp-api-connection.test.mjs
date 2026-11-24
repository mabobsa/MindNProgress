import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  createMnpApiConnectionResolver,
  normalizeMnpRunnerRelayDescriptor,
} from '../mcp/apiConnection.mjs'

const relayFile = path.resolve('test-relay.json')
const tokenFile = path.resolve('test-integration-token')
const integrationToken = 'i'.repeat(48)
const relayToken = `mnprl_${'r'.repeat(43)}`

function readFiles(records) {
  return async (file) => {
    if (!(file in records)) {
      const error = new Error('NOT_FOUND')
      error.code = 'ENOENT'
      throw error
    }
    return records[file]
  }
}

test('명시한 API 주소는 기존 연동 토큰을 사용하고 자동 탐색을 건너뛴다', async () => {
  const fetchCalls = []
  const resolver = createMnpApiConnectionResolver({
    explicitApiBaseUrl: 'http://main.example:4176/path',
    tokenFile,
    relayFile,
    readFileImpl: readFiles({ [tokenFile]: integrationToken }),
    fetchImpl: async (...args) => {
      fetchCalls.push(args)
      return new Response('{}')
    },
  })

  assert.deepEqual(await resolver.resolve(), {
    mode: 'explicit',
    apiBaseUrl: 'http://main.example:4176/path',
    token: integrationToken,
  })
  assert.equal(fetchCalls.length, 0)
})

test('메인 PC에서는 Runner 탐색 파일이 있어도 로컬 MnP를 우선한다', async () => {
  const descriptor = {
    schemaVersion: 1,
    baseUrl: 'http://127.0.0.1:43129',
    token: relayToken,
    instanceId: 'relay_instance_123456',
    pid: 1234,
  }
  const resolver = createMnpApiConnectionResolver({
    tokenFile,
    relayFile,
    readFileImpl: readFiles({
      [tokenFile]: integrationToken,
      [relayFile]: JSON.stringify(descriptor),
    }),
    fetchImpl: async (url) => new Response(JSON.stringify({ status: 'ok', publicBaseUrl: 'http://main.example:4175' }), {
      status: String(url).endsWith('/api/health') ? 200 : 500,
      headers: { 'Content-Type': 'application/json' },
    }),
    processExists: () => true,
  })

  assert.deepEqual(await resolver.resolve(), {
    mode: 'local',
    apiBaseUrl: 'http://127.0.0.1:4176',
    token: integrationToken,
  })
})

test('서브 머신에서는 실행 중인 AionUi Runner의 loopback 중계를 사용한다', async () => {
  const descriptor = {
    schemaVersion: 1,
    baseUrl: 'http://127.0.0.1:43129',
    token: relayToken,
    instanceId: 'relay_instance_123456',
    pid: 1234,
  }
  const resolver = createMnpApiConnectionResolver({
    tokenFile,
    relayFile,
    readFileImpl: readFiles({ [relayFile]: JSON.stringify(descriptor) }),
    fetchImpl: async () => new Response('{}', { status: 503 }),
    processExists: (pid) => pid === 1234,
  })

  assert.deepEqual(await resolver.resolve(), {
    mode: 'runner-relay',
    apiBaseUrl: descriptor.baseUrl,
    token: relayToken,
    instanceId: descriptor.instanceId,
    pid: 1234,
  })
})

test('종료된 프로세스나 외부 주소를 가리키는 Runner 탐색 정보는 거부한다', () => {
  const common = {
    schemaVersion: 1,
    token: relayToken,
    instanceId: 'relay_instance_123456',
    pid: 1234,
  }
  assert.equal(normalizeMnpRunnerRelayDescriptor({ ...common, baseUrl: 'http://10.0.0.9:43129' }, () => true), null)
  assert.equal(normalizeMnpRunnerRelayDescriptor({ ...common, baseUrl: 'http://127.0.0.1:43129' }, () => false), null)
})

test('401 뒤에는 토큰 파일을 다시 읽어 값이 바뀐 경우에만 연결을 갱신한다', async () => {
  const files = { [tokenFile]: integrationToken }
  const resolver = createMnpApiConnectionResolver({
    tokenFile,
    relayFile,
    readFileImpl: readFiles(files),
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok', publicBaseUrl: 'http://main.example:4175' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  })
  const first = await resolver.resolve()
  assert.equal(await resolver.refreshAfterUnauthorized(first), false, '토큰이 그대로면 다른 이유의 401이므로 재시도하지 않는다')
  assert.equal(await resolver.resolve(), first)

  const rotatedToken = 'n'.repeat(43)
  files[tokenFile] = `${rotatedToken}
`
  assert.equal(await resolver.refreshAfterUnauthorized(first), true)
  const refreshed = await resolver.resolve()
  assert.deepEqual(refreshed, { ...first, token: rotatedToken })
  assert.equal(await resolver.refreshAfterUnauthorized(first), true, '동시에 401을 받은 요청도 이미 갱신된 새 토큰으로 다시 보낸다')
  assert.equal(await resolver.refreshAfterUnauthorized(refreshed), false)

  delete files[tokenFile]
  assert.equal(await resolver.refreshAfterUnauthorized(refreshed), false, '토큰 파일을 읽지 못하면 기존 연결을 유지한다')
  assert.equal(await resolver.resolve(), refreshed)
})

test('명시 주소와 Runner 중계도 401 뒤 바뀐 자격 증명만 다시 읽는다', async () => {
  const files = { [tokenFile]: integrationToken }
  const explicit = createMnpApiConnectionResolver({ explicitApiBaseUrl: 'http://main.example:4176', tokenFile, relayFile, readFileImpl: readFiles(files) })
  const before = await explicit.resolve()
  files[tokenFile] = 'e'.repeat(43)
  assert.equal(await explicit.refreshAfterUnauthorized(before), true)
  assert.equal((await explicit.resolve()).token, 'e'.repeat(43))

  const descriptor = { schemaVersion: 1, baseUrl: 'http://127.0.0.1:43129', token: relayToken, instanceId: 'relay_instance_123456', pid: 1234 }
  const relayFiles = { [relayFile]: JSON.stringify(descriptor) }
  const relay = createMnpApiConnectionResolver({
    tokenFile,
    relayFile,
    readFileImpl: readFiles(relayFiles),
    fetchImpl: async () => new Response('{}', { status: 503 }),
    processExists: (pid) => pid === 1234,
  })
  const relayConnection = await relay.resolve()
  assert.equal(await relay.refreshAfterUnauthorized(relayConnection), false)
  const reissued = `mnprl_${'s'.repeat(43)}`
  relayFiles[relayFile] = JSON.stringify({ ...descriptor, token: reissued })
  assert.equal(await relay.refreshAfterUnauthorized(relayConnection), true)
  assert.equal((await relay.resolve()).token, reissued)
})
