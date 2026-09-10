import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveDoorayResponseConversation, doorayResponseWorkspace, doorayResponseMcpNames, prepareDoorayResponseMcps, selectDoorayResponseMcps } from '../server/lib/doorayResponseIntegration.mjs'

const catalog = doorayResponseMcpNames.map((name, index) => ({ id: `mcp-${index}`, name, enabled: true }))
const operation = { machineId: 'selected-machine', conversationId: 'test-chat' }
const idle = () => ({ state: 'idle' })

test('필수 MCP 네 종류의 실제 ID만 선택하며 누락·비활성·중복을 허용하지 않는다', () => {
  assert.deepEqual(selectDoorayResponseMcps([...catalog, { id: 'unused', name: 'other', enabled: true }]), catalog.map((server) => ({ id: server.id, label: server.name })))
  for (const invalid of [catalog.slice(1), [{ ...catalog[0], enabled: false }, ...catalog.slice(1)], [...catalog, { ...catalog[0], id: 'duplicate' }], null]) {
    assert.throws(() => selectDoorayResponseMcps(invalid), /MindNProgress/)
  }
})

test('기존 대화와 세션 MCP를 보존하며 해당 실행 머신에서 네 MCP를 추가하고 다시 조회한다', async () => {
  let extra = { mcp_server_ids: ['existing'], mcp_servers: ['existing-tool'], session_mcp_servers: [{ name: 'session-tool', command: 'test-only' }] }
  const calls = []
  const call = async (machineId, pathname, options = {}) => {
    assert.equal(machineId, operation.machineId)
    calls.push({ pathname, method: options.method ?? 'GET' })
    if (pathname === '/api/mcp/servers') return [...catalog, { id: 'existing', name: 'existing-tool', enabled: true }]
    if (options.method === 'PUT') {
      assert.deepEqual(options.body.mcp_server_ids, ['existing', ...catalog.map((server) => server.id)])
      assert.deepEqual(options.body.session_mcp_servers, extra.session_mcp_servers)
      extra = { ...extra, mcp_server_ids: options.body.mcp_server_ids, mcp_servers: ['existing-tool', ...doorayResponseMcpNames] }
    }
    return { id: operation.conversationId, extra }
  }
  assert.equal((await prepareDoorayResponseMcps(call, idle, operation)).mcpServers.length, 4)
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'PUT', 'GET'])
  calls.length = 0
  await prepareDoorayResponseMcps(call, idle, operation)
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET'], '재확인 시 이미 적용된 런타임을 다시 중지하지 않는다')
})

test('실행 중인 대화에는 MCP 설정을 쓰거나 런타임을 재시작하지 않는다', async () => {
  const call = async (_machineId, pathname, options = {}) => {
    assert.notEqual(options.method, 'PUT')
    return pathname === '/api/mcp/servers' ? catalog : { id: operation.conversationId, extra: {} }
  }
  assert.equal((await prepareDoorayResponseMcps(call, () => ({ state: 'running' }), operation)).waiting, true)
})

test('저장 성공 응답만으로 활성화됐다고 판단하지 않고 실제 선택을 검증한다', async () => {
  const call = async (_machineId, pathname) => pathname === '/api/mcp/servers' ? catalog : { id: operation.conversationId, extra: {} }
  await assert.rejects(prepareDoorayResponseMcps(call, idle, operation), /확인하지 못했/)
})

test('필수 MCP가 없으면 기존 대화를 변경하기 전에 중단한다', async () => {
  const call = async (_machineId, pathname) => { assert.equal(pathname, '/api/mcp/servers'); return [] }
  await assert.rejects(prepareDoorayResponseMcps(call, idle, operation), /필수 MCP/)
})

test('기존 MCP 설정이 손상되었으면 빈 목록으로 덮어쓰지 않는다', async () => {
  const call = async (_machineId, pathname, options = {}) => {
    assert.notEqual(options.method, 'PUT')
    return pathname === '/api/mcp/servers' ? catalog : { id: operation.conversationId, extra: { session_mcp_servers: 'invalid' } }
  }
  await assert.rejects(prepareDoorayResponseMcps(call, idle, operation), /변경하지 않았/)
})

test('전용 대화는 계정별 공통 폴더를 사용하고 서브 머신 경로를 메인 경로로 추측하지 않는다', () => {
  const workspace = doorayResponseWorkspace('C:/data', 'main', { machineId: 'main' }, 'user1')
  assert.match(workspace, /user1[\\/]Dooray AI 대응$/)
  assert.notEqual(workspace, doorayResponseWorkspace('C:/data', 'main', { machineId: 'main' }, 'user2'))
  assert.equal(doorayResponseWorkspace('C:/data', 'main', { machineId: 'sub', proposalWorkspace: '/srv/dooray-proposals' }, 'user1'), '/srv/dooray-proposals')
  assert.match(doorayResponseWorkspace('C:/data', 'main', { machineId: 'sub', proposalWorkspace: 'D:\\Proposals' }, 'user1'), /^D:\\Proposals$/)
  for (const value of ['', 'relative', '/', 'C:\\', 'C:\\folder\\..']) {
    assert.throws(() => doorayResponseWorkspace('C:/data', 'main', { machineId: 'sub', proposalWorkspace: value }, 'user1'), /절대 경로/)
  }
})

test('보관은 이 요청이 만든 유휴 대화만 대상으로 하며 기존 업무·다른 계정·변경된 작업 위치는 보호한다', async () => {
  const calls = []
  const call = async (machineId, pathname, options) => calls.push({ machineId, pathname, options })
  const reference = { machineId: 'sub', conversationId: 'own-chat', workspace: '/proposals' }
  const extra = { mnpDoorayOperationId: 'job-1-route-0-0', mnpDoorayUserId: 'user1', workspace: reference.workspace }
  let conversation = { id: reference.conversationId, extra }
  const read = async (machineId, id) => { assert.equal(machineId, 'sub'); assert.equal(id, 'own-chat'); return conversation }
  const archive = (runtime = idle) => archiveDoorayResponseConversation(call, read, runtime, { id: 'user1' }, reference, 'job-1')
  await archive()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].pathname, '/api/sidebar/conversation/own-chat/archive')
  assert.equal(calls[0].options.method, 'POST')
  conversation = { ...conversation, extra: {} }
  await archive()
  conversation = { ...conversation, extra: { ...extra, mnpDoorayOperationId: 'job-2-review-0' } }
  await archive()
  conversation = { ...conversation, extra: { ...extra, mnpDoorayUserId: 'user2' } }
  await assert.rejects(archive(), /다른 계정/)
  conversation = { ...conversation, extra: { ...extra, workspace: '/real-project' } }
  await assert.rejects(archive(), /작업 위치/)
  conversation = { ...conversation, extra }
  await assert.rejects(archive(() => ({ state: 'running' })), /실행 중/)
  conversation = null
  await archive()
  assert.equal(calls.length, 1)
})
