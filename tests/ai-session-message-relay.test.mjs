import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REMOTE_SESSION_MESSAGE_PATH,
  normalizeSessionMessageRelayRequest,
  relaySessionMessage,
} from '../server/lib/aiSessionMessageRelay.mjs'

const machines = [
  { machineId: 'main', label: '메인 PC', enabled: true, online: true },
  { machineId: 'mac', label: 'MacBook', enabled: true, online: true },
  { machineId: 'lab', label: '실험 PC', enabled: true, online: true },
]

const request = {
  fromConversationId: 'conv-main',
  fromName: '메인 대화',
  fromWorkspace: 'D:/work',
  to: 'conv-mac',
  message: '확인 부탁합니다.',
}

function requestError(status, code, extra = {}) {
  return Object.assign(new Error(`AIONUI_REQUEST_FAILED:${status}`), { status, code, ...extra })
}

// 대상 대화가 있는 머신만 조회에 성공하는 가짜 호출이다.
function fakeMachines({ holder = 'mac', deliver = async () => ({ status: 'delivered', to: request.to }), probeFailure = {} } = {}) {
  const calls = []
  const callMachine = async (machineId, pathname, options = {}) => {
    calls.push({ machineId, pathname, options })
    if (pathname === REMOTE_SESSION_MESSAGE_PATH) return deliver(machineId, options)
    if (probeFailure[machineId]) throw probeFailure[machineId]
    if (machineId === holder) return { id: request.to }
    throw requestError(404, null)
  }
  return { calls, callMachine }
}

function relay(overrides = {}) {
  const { calls, callMachine } = fakeMachines(overrides)
  return relaySessionMessage({
    request,
    sourceMachineId: 'main',
    listMachines: () => overrides.machines ?? machines,
    homeMachineIdOf: overrides.homeMachineIdOf ?? (() => null),
    callMachine,
  }).then((result) => ({ result, calls }))
}

test('세션 메시지 중계 요청은 대화 ID와 본문을 검사하고 이름이 없으면 ID로 채운다', () => {
  const normalized = normalizeSessionMessageRelayRequest({ ...request, fromName: '  ', fromWorkspace: undefined })
  assert.deepEqual(normalized, {
    ok: true,
    value: { fromConversationId: 'conv-main', fromName: 'conv-main', to: 'conv-mac', message: '확인 부탁합니다.' },
  })
  assert.equal(normalizeSessionMessageRelayRequest({ ...request, to: '../x' }).body.code, 'schema_validation_failed')
  assert.equal(normalizeSessionMessageRelayRequest({ ...request, message: '  ' }).body.code, 'schema_validation_failed')
  assert.equal(normalizeSessionMessageRelayRequest({ ...request, to: 'conv-main' }).body.code, 'target_is_self')
  assert.equal(normalizeSessionMessageRelayRequest(null).ok, false)
})

test('대상 대화가 있는 머신을 찾아 보낸 머신 이름과 함께 전달한다', async () => {
  const { result, calls } = await relay()

  assert.deepEqual(result, {
    status: 200,
    body: {
      success: true,
      data: { status: 'delivered', to: 'conv-mac' },
      machine: { machineId: 'mac', label: 'MacBook' },
    },
  })
  assert.equal(calls.some((call) => call.machineId === 'main'), false, '보낸 머신은 다시 확인하지 않는다')
  const delivery = calls.find((call) => call.pathname === REMOTE_SESSION_MESSAGE_PATH)
  assert.equal(delivery.machineId, 'mac')
  assert.equal(delivery.options.method, 'POST')
  assert.deepEqual(delivery.options.body, { ...request, fromMachine: '메인 PC' })
})

test('대화 기록에 남은 머신을 먼저 확인한다', async () => {
  const { calls } = await relay({ holder: 'lab', homeMachineIdOf: () => 'lab' })

  assert.equal(calls[0].machineId, 'lab')
  assert.equal(calls.find((call) => call.pathname === REMOTE_SESSION_MESSAGE_PATH).machineId, 'lab')
})

test('어느 머신에도 대상이 없으면 target_not_found로 답한다', async () => {
  const { result, calls } = await relay({ holder: null })

  assert.equal(result.status, 404)
  assert.equal(result.body.code, 'target_not_found')
  assert.equal(calls.some((call) => call.pathname === REMOTE_SESSION_MESSAGE_PATH), false)
})

test('확인하지 못한 머신이 있으면 찾지 못했다고 단정하지 않는다', async () => {
  const { result } = await relay({
    holder: null,
    machines: [machines[0], { ...machines[1], online: false }, machines[2]],
  })

  assert.equal(result.status, 503)
  assert.equal(result.body.code, 'MACHINE_UNAVAILABLE')
  assert.match(result.body.error, /MacBook/)
})

test('받는 머신의 세션 메시지 오류 코드는 그대로 돌려준다', async () => {
  const { result } = await relay({ deliver: async () => { throw requestError(403, 'target_is_team') } })

  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'target_is_team')
})

test('전달 결과를 받지 못하면 이미 전달됐을 수 있다고 알린다', async () => {
  const { result } = await relay({
    deliver: async () => { throw Object.assign(new Error('timeout'), { reasonCode: 'RESULT_TIMEOUT' }) },
  })

  assert.equal(result.status, 502)
  assert.equal(result.body.code, 'MACHINE_DELIVERY_FAILED')
  assert.match(result.body.error, /이미 전달됐을 수 있으니/)
})

test('비활성 머신은 확인하지 않는다', async () => {
  const { result, calls } = await relay({
    holder: 'mac',
    machines: [machines[0], { ...machines[1], enabled: false }],
  })

  assert.equal(result.body.code, 'target_not_found')
  assert.equal(calls.length, 0)
})
