import assert from 'node:assert/strict'
import test from 'node:test'
import { doorayResponseMcpNames, prepareDoorayResponseMcps, selectDoorayResponseMcps } from '../server/lib/doorayResponseIntegration.mjs'

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
