import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MACHINE_LIMIT,
  SubMachinePayloadError,
  distributedWorkTargets,
  ensureMainMachine,
  findMachine,
  isMainMachine,
  machineRole,
  normalizeDistributedWorkSettings,
  normalizeMachineId,
  normalizeMachineRegistry,
  publicMachineRegistry,
  removeSubMachine,
  resolveDistributedWorkSettings,
  serializeMachineRegistry,
  setMachineToken,
  touchMachine,
  upsertSubMachine,
  verifyMachineToken,
} from '../server/lib/subMachines.mjs'

const mainDescriptor = { machineId: 'desk-win', label: '메인 데스크탑', platform: 'win32' }

function registryWithSub(overrides = {}) {
  const base = ensureMainMachine(normalizeMachineRegistry([]), mainDescriptor, '2026-09-07T00:00:00.000Z')
  return upsertSubMachine(base, {
    machineId: 'macbook',
    label: '맥북',
    platform: 'darwin',
    workspacePoolIds: ['holdem'],
    ...overrides,
  }, '2026-09-07T01:00:00.000Z')
}

test('머신 ID는 소문자 하이픈 형식만 허용한다', () => {
  assert.equal(normalizeMachineId('MacBook'), 'macbook')
  assert.equal(normalizeMachineId('  desk-win  '), 'desk-win')
  assert.equal(normalizeMachineId('mac_book'), '')
  assert.equal(normalizeMachineId('-macbook'), '')
  assert.equal(normalizeMachineId('macbook-'), '')
  assert.equal(normalizeMachineId('__proto__'), '')
  assert.equal(normalizeMachineId(''), '')
  assert.equal(normalizeMachineId(null), '')
})

test('저장 파일에 main이 여러 개 있어도 하나만 남기고 나머지는 서브로 강등한다', () => {
  const registry = normalizeMachineRegistry([
    { machineId: 'desk-win', label: '메인', role: 'main' },
    { machineId: 'macbook', label: '맥북', role: 'main' },
    { machineId: 'spare', label: '예비', role: 'sub' },
  ])

  assert.equal(registry.mainMachineId, 'desk-win')
  assert.equal(machineRole(registry, 'desk-win'), 'main')
  assert.equal(machineRole(registry, 'macbook'), 'sub')
  assert.equal(machineRole(registry, 'spare'), 'sub')
  assert.equal(registry.machines.length, 3)
})

test('중복 머신 ID와 형식이 잘못된 항목은 불러올 때 버린다', () => {
  const registry = normalizeMachineRegistry([
    { machineId: 'macbook', label: '맥북', role: 'sub' },
    { machineId: 'MACBOOK', label: '중복', role: 'sub' },
    { machineId: 'bad_id', label: '형식 오류', role: 'sub' },
    null,
    '문자열',
  ])

  assert.equal(registry.machines.length, 1)
  assert.equal(registry.machines[0].machineId, 'macbook')
  assert.equal(registry.mainMachineId, '')
})

test('메인 머신 레코드가 없으면 생성하고 있으면 이름을 유지한다', () => {
  const created = ensureMainMachine(normalizeMachineRegistry([]), mainDescriptor, '2026-09-07T00:00:00.000Z')
  assert.equal(created.mainMachineId, 'desk-win')
  assert.equal(created.machines[0].label, '메인 데스크탑')
  assert.equal(created.machines[0].createdAt, '2026-09-07T00:00:00.000Z')

  const renamed = { ...created, machines: [{ ...created.machines[0], label: '사용자 지정 이름' }] }
  const kept = ensureMainMachine(renamed, mainDescriptor, '2026-09-08T00:00:00.000Z')
  assert.equal(kept.machines[0].label, '사용자 지정 이름')
  assert.equal(kept.machines[0].createdAt, '2026-09-07T00:00:00.000Z')
  assert.equal(kept.machines[0].updatedAt, '2026-09-08T00:00:00.000Z')
})

test('메인 머신은 항상 활성 상태로 보정하고 목록 맨 앞에 둔다', () => {
  const registry = ensureMainMachine(normalizeMachineRegistry([
    { machineId: 'macbook', label: '맥북', role: 'sub' },
    { machineId: 'desk-win', label: '메인', role: 'sub', enabled: false },
  ]), mainDescriptor)

  assert.equal(registry.mainMachineId, 'desk-win')
  assert.equal(registry.machines[0].machineId, 'desk-win')
  assert.equal(registry.machines[0].enabled, true)
  assert.equal(registry.machines.length, 2)
})

test('서브 머신을 등록하고 같은 ID로 다시 등록하면 생성 시각을 유지한 채 갱신한다', () => {
  const registry = registryWithSub()
  const machine = findMachine(registry, 'macbook')
  assert.equal(machine.label, '맥북')
  assert.deepEqual(machine.workspacePoolIds, ['holdem'])
  assert.equal(machine.createdAt, '2026-09-07T01:00:00.000Z')

  const updated = upsertSubMachine(registry, {
    machineId: 'macbook',
    label: '맥북 16',
    platform: 'darwin',
    enabled: false,
  }, '2026-09-09T00:00:00.000Z')
  const updatedMachine = findMachine(updated, 'macbook')

  assert.equal(updated.machines.length, 2)
  assert.equal(updatedMachine.label, '맥북 16')
  assert.equal(updatedMachine.enabled, false)
  assert.deepEqual(updatedMachine.workspacePoolIds, [])
  assert.equal(updatedMachine.createdAt, '2026-09-07T01:00:00.000Z')
  assert.equal(updatedMachine.updatedAt, '2026-09-09T00:00:00.000Z')
})

test('메인 머신은 서브로 등록하거나 삭제할 수 없다', () => {
  const registry = registryWithSub()
  assert.throws(() => upsertSubMachine(registry, { machineId: 'desk-win', label: '메인' }), SubMachinePayloadError)
  assert.throws(() => removeSubMachine(registry, 'desk-win'), SubMachinePayloadError)
  assert.equal(isMainMachine(registry, 'desk-win'), true)
})

test('머신 이름이 없거나 ID 형식이 틀리면 등록을 거부한다', () => {
  const registry = registryWithSub()
  assert.throws(() => upsertSubMachine(registry, { machineId: 'spare', label: '   ' }), SubMachinePayloadError)
  assert.throws(() => upsertSubMachine(registry, { machineId: 'bad_id', label: '예비' }), SubMachinePayloadError)
  assert.throws(() => upsertSubMachine(registry, null), SubMachinePayloadError)
})

test('등록 상한을 넘는 신규 머신은 거부하고 기존 머신 갱신은 허용한다', () => {
  let registry = ensureMainMachine(normalizeMachineRegistry([]), mainDescriptor)
  for (let index = registry.machines.length; index < MACHINE_LIMIT; index += 1) {
    registry = upsertSubMachine(registry, { machineId: `sub-${index}`, label: `서브 ${index}` })
  }

  assert.equal(registry.machines.length, MACHINE_LIMIT)
  assert.throws(() => upsertSubMachine(registry, { machineId: 'one-more', label: '초과' }), SubMachinePayloadError)
  assert.equal(upsertSubMachine(registry, { machineId: 'sub-1', label: '갱신' }).machines.length, MACHINE_LIMIT)
})

test('등록되지 않은 머신 삭제는 거부한다', () => {
  assert.throws(() => removeSubMachine(registryWithSub(), 'unknown'), SubMachinePayloadError)
  assert.equal(removeSubMachine(registryWithSub(), 'macbook').machines.length, 1)
})

test('직렬화는 role을 복원하고 왕복해도 같은 레지스트리가 된다', () => {
  const registry = registryWithSub()
  const stored = serializeMachineRegistry(registry)

  assert.deepEqual(stored.map((machine) => [machine.machineId, machine.role]), [
    ['desk-win', 'main'],
    ['macbook', 'sub'],
  ])
  assert.deepEqual(normalizeMachineRegistry(stored), registry)
})

test('클라이언트 응답에는 내부 시각 필드를 넣지 않는다', () => {
  const machine = publicMachineRegistry(registryWithSub()).machines[1]
  assert.deepEqual(Object.keys(machine).sort(), [
    'enabled', 'hasToken', 'label', 'lastSeenAt', 'machineId', 'platform', 'role', 'workspacePoolIds',
  ])
  assert.equal(machine.hasToken, false)
})

test('Runner 토큰은 해시로만 보관하고 발급한 머신에서만 검증에 성공한다', () => {
  const registry = upsertSubMachine(registryWithSub(), { machineId: 'spare', label: '예비' })
  const issued = setMachineToken(registry, 'macbook', 'runner-secret-token')

  assert.equal(findMachine(issued, 'macbook').tokenHash.length, 64)
  assert.notEqual(findMachine(issued, 'macbook').tokenHash, 'runner-secret-token')
  assert.equal(publicMachineRegistry(issued).machines[1].hasToken, true)

  assert.equal(verifyMachineToken(issued, 'macbook', 'runner-secret-token'), true)
  assert.equal(verifyMachineToken(issued, 'macbook', 'wrong-token'), false)
  assert.equal(verifyMachineToken(issued, 'spare', 'runner-secret-token'), false)
  assert.equal(verifyMachineToken(issued, 'unknown', 'runner-secret-token'), false)
})

test('메인 머신에는 Runner 토큰을 발급하지 않는다', () => {
  assert.throws(() => setMachineToken(registryWithSub(), 'desk-win', 'token'), SubMachinePayloadError)
  assert.throws(() => setMachineToken(registryWithSub(), 'unknown', 'token'), SubMachinePayloadError)
})

test('비활성화한 머신과 토큰을 폐기한 머신은 검증에 실패한다', () => {
  const issued = setMachineToken(registryWithSub(), 'macbook', 'runner-secret-token')

  const disabled = upsertSubMachine(issued, { machineId: 'macbook', label: '맥북', enabled: false })
  assert.equal(verifyMachineToken(disabled, 'macbook', 'runner-secret-token'), false)

  const revoked = setMachineToken(issued, 'macbook', null)
  assert.equal(findMachine(revoked, 'macbook').tokenHash, null)
  assert.equal(verifyMachineToken(revoked, 'macbook', 'runner-secret-token'), false)
})

test('머신 정보를 수정해도 이미 발급한 Runner 토큰은 유지한다', () => {
  const issued = setMachineToken(registryWithSub(), 'macbook', 'runner-secret-token')
  const renamed = upsertSubMachine(issued, { machineId: 'macbook', label: '맥북 16', platform: 'darwin' })

  assert.equal(renamed.machines[1].label, '맥북 16')
  assert.equal(verifyMachineToken(renamed, 'macbook', 'runner-secret-token'), true)
})

test('서브였던 머신이 메인이 되면 남은 Runner 토큰을 폐기한다', () => {
  const issued = setMachineToken(registryWithSub(), 'macbook', 'runner-secret-token')
  const promoted = ensureMainMachine(issued, { machineId: 'macbook', label: '맥북', platform: 'darwin' })

  assert.equal(promoted.mainMachineId, 'macbook')
  assert.equal(findMachine(promoted, 'macbook').tokenHash, null)
  assert.equal(verifyMachineToken(promoted, 'macbook', 'runner-secret-token'), false)
})

test('마지막 접속 시각은 등록된 머신에만 기록한다', () => {
  const registry = registryWithSub()
  const touched = touchMachine(registry, 'macbook', '2026-09-10T00:00:00.000Z')
  assert.equal(findMachine(touched, 'macbook').lastSeenAt, '2026-09-10T00:00:00.000Z')
  assert.equal(touchMachine(registry, 'unknown', '2026-09-10T00:00:00.000Z'), registry)
})

test('분산 작업 설정의 기본값은 꺼진 상태다', () => {
  assert.deepEqual(normalizeDistributedWorkSettings(undefined), { enabled: false, defaultMachineId: null })
  assert.deepEqual(normalizeDistributedWorkSettings({ enabled: 'true' }), { enabled: false, defaultMachineId: null })
  assert.deepEqual(normalizeDistributedWorkSettings({ enabled: true, defaultMachineId: 'MacBook' }), {
    enabled: true,
    defaultMachineId: 'macbook',
  })
})

test('비활성 사용자의 기본 머신 선택은 무시한다', () => {
  const settings = resolveDistributedWorkSettings({ enabled: false, defaultMachineId: 'macbook' }, registryWithSub())
  assert.deepEqual(settings, { enabled: false, defaultMachineId: null })
})

test('사라졌거나 비활성화된 기본 머신은 선택을 해제한다', () => {
  const registry = registryWithSub()
  assert.equal(resolveDistributedWorkSettings({ enabled: true, defaultMachineId: 'macbook' }, registry).defaultMachineId, 'macbook')
  assert.equal(resolveDistributedWorkSettings({ enabled: true, defaultMachineId: 'gone' }, registry).defaultMachineId, null)

  const disabled = upsertSubMachine(registry, { machineId: 'macbook', label: '맥북', enabled: false })
  assert.equal(resolveDistributedWorkSettings({ enabled: true, defaultMachineId: 'macbook' }, disabled).defaultMachineId, null)
})

test('활성화하지 않은 사용자에게는 메인 머신만 위임 대상으로 노출한다', () => {
  const targets = distributedWorkTargets(registryWithSub(), { enabled: false })
  assert.equal(targets.enabled, false)
  assert.equal(targets.defaultMachineId, 'desk-win')
  assert.deepEqual(targets.machines.map((machine) => machine.machineId), ['desk-win'])
})

test('활성화한 사용자에게는 메인을 앞에 두고 활성 서브 머신을 함께 노출한다', () => {
  const registry = upsertSubMachine(registryWithSub(), { machineId: 'spare', label: '가', platform: 'linux' })
  const withDisabled = upsertSubMachine(registry, { machineId: 'off', label: '중지', enabled: false })
  const targets = distributedWorkTargets(withDisabled, { enabled: true, defaultMachineId: 'macbook' })

  assert.equal(targets.enabled, true)
  assert.equal(targets.defaultMachineId, 'macbook')
  assert.deepEqual(targets.machines.map((machine) => machine.machineId), ['desk-win', 'spare', 'macbook'])
  assert.equal(targets.machines[0].role, 'main')
})

test('머신이 없는 레지스트리와 잘못된 입력에서도 위임 대상 조회가 안전하다', () => {
  assert.deepEqual(distributedWorkTargets(null, { enabled: true }), {
    enabled: true,
    defaultMachineId: '',
    machines: [],
  })
})
