import assert from 'node:assert/strict'
import test from 'node:test'
import { sendMobilePush, MOBILE_PUSH_PATH, mobilePushTargets } from '../server/lib/mobilePush.mjs'
import { machineManageableBy, normalizeMachineRegistry } from '../server/lib/subMachines.mjs'

const registry = normalizeMachineRegistry([
  { machineId: 'main', role: 'main', enabled: true },
  { machineId: 'mine', ownerUserId: 'owner', enabled: true, tokenHash: 'a'.repeat(64), lastSeenAt: new Date(1_800_000_000_000).toISOString() },
  { machineId: 'other', ownerUserId: 'another', enabled: true },
])
const user = { id: 'owner', role: 'editor' }
const body = { machineId: 'mine', eventId: 'approval-1', kind: 'choice', title: '카드 확인 요청', body: '전체 질문과 선택지', revision: 1 }
const options = { registry, user, body, originUrl: 'https://mnp.example', now: 1_800_000_000_000 }

test('본인 머신으로 전달하고 발신자·시각은 서버에서 결정한다', async () => {
  let captured
  const result = await sendMobilePush({ ...options, body: { ...body, originId: '위조', createdAt: 1, userId: 'another' },
    sendRemote: async (machine, payload) => { captured = { machine, payload }; return { state: 'queued' } } })
  assert.equal(captured.machine, 'mine')
  assert.match(captured.payload.originId, /^[a-f0-9]{64}$/)
  assert.equal(captured.payload.createdAt, options.now)
  assert.equal(result.receivedOnPhone, false)
})

test('다른 사용자의 머신과 열람자 계정은 발송을 거부한다', async () => {
  await assert.rejects(sendMobilePush({ ...options, body: { ...body, machineId: 'other' } }), { status: 403 })
  await assert.rejects(sendMobilePush({ ...options, user: { ...user, role: 'viewer' } }), { status: 403 })
  await assert.rejects(sendMobilePush({ ...options, body: { ...body, machineId: 'unknown' } }), { status: 404 })
})

test('메인 머신은 로컬 중계를 사용하고 서브 경로를 호출하지 않는다', async () => {
  const result = await sendMobilePush({ ...options, user: { id: 'admin', role: 'admin' }, body: { ...body, machineId: 'main' },
    sendLocal: async () => ({ state: 'queued' }), sendRemote: () => assert.fail('원격 호출 금지') })
  assert.equal(result.machineId, 'main')
  assert.equal(result.delivery, 'queued')
  assert.equal(MOBILE_PUSH_PATH, '/api/internal/mobile-push/mnp')
})

test('서버가 지정한 계정만 메인 PC 푸시를 허용하며 머신 관리 권한은 바꾸지 않는다', async () => {
  const mainBody = { ...body, machineId: 'main' }
  await assert.rejects(sendMobilePush({ ...options, body: mainBody, sendLocal: () => assert.fail('권한 없는 발송') }), { status: 403 })
  const sent = await sendMobilePush({ ...options, body: mainBody, mainUserId: 'owner', sendLocal: async () => ({ state: 'queued' }) })
  assert.equal(sent.machineId, 'main')
  await assert.rejects(sendMobilePush({ ...options, body: { ...mainBody, mainUserId: 'owner' }, mainUserId: 'someone-else' }), { status: 403 })
  await assert.rejects(sendMobilePush({ ...options, body: mainBody, user: { id: 'owner', role: 'viewer' }, mainUserId: 'owner' }), { status: 403 })
  assert.equal(machineManageableBy(registry, 'main', { userId: 'owner', isAdmin: false }), false)
  assert.deepEqual(mobilePushTargets(user, registry, { mainUserId: 'owner' }).map(m => m.machineId), ['main', 'mine'])
  assert.deepEqual(mobilePushTargets(user, registry).map(m => m.machineId), ['mine'])
})

test('잘못된 개정 번호·과대 본문·외부 링크를 거부한다', async () => {
  for (const invalid of [{ revision: 0 }, { body: '가'.repeat(16001) }, { webUrl: 'https://other.example/' }, { kind: 'unknown' }]) {
    await assert.rejects(sendMobilePush({ ...options, body: { ...body, ...invalid } }), { status: 400 })
  }
})

test('사용자마다 같은 이벤트 ID를 별개로 분리한다', async () => {
  const origins = []
  for (const actor of [{ id: 'admin', role: 'admin' }, user]) {
    await sendMobilePush({ ...options, user: actor, sendRemote: async (_machine, payload) => { origins.push(payload.originId); return {} } })
  }
  assert.notEqual(origins[0], origins[1])
})

test('Runner 미설정과 연결 끊김은 큐에 넣기 전에 구분한다', async () => {
  const machines = registry.machines.map((machine) => machine.machineId === 'mine' ? { ...machine, tokenHash: null } : machine)
  await assert.rejects(sendMobilePush({ ...options, registry: { ...registry, machines } }), { code: 'RUNNER_NOT_CONFIGURED' })
  const offline = registry.machines.map((machine) => machine.machineId === 'mine' ? { ...machine, lastSeenAt: null } : machine)
  await assert.rejects(sendMobilePush({ ...options, registry: { ...registry, machines: offline } }), { code: 'RUNNER_OFFLINE' })
})
