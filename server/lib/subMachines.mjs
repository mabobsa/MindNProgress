// 메인 머신 한 대가 MnP를 단독으로 운영하고, 서브 머신은 자체 AionUi와 Unity 작업공간 풀만 가진다.
// 이 모듈은 머신 레지스트리와 사용자별 분산 작업 설정을 정규화한다.
// 메인 머신은 registry의 mainMachineId 하나로만 결정되므로 role 중복이 구조적으로 생기지 않는다.

import { createHash, timingSafeEqual } from 'node:crypto'

export const MACHINE_REGISTRY_VERSION = 1
export const MACHINE_LIMIT = 32
export const MACHINE_ID_MAX_LENGTH = 64
export const MACHINE_LABEL_MAX_LENGTH = 60
export const MACHINE_PLATFORM_MAX_LENGTH = 32
export const WORKSPACE_POOL_ID_MAX_LENGTH = 64
export const WORKSPACE_POOL_LIMIT = 16

export const MACHINE_ROLES = Object.freeze(['main', 'sub'])

// 머신 ID는 파일명·git ref·URL 경로에 그대로 들어가므로 소문자와 하이픈만 허용한다.
const MACHINE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const RESERVED_MACHINE_IDS = new Set(['__proto__', 'constructor', 'prototype'])

export class SubMachinePayloadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SubMachinePayloadError'
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return [...value]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, maxLength)
}

function isoOrNull(value) {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

export function normalizeMachineId(value) {
  const normalized = cleanText(value, MACHINE_ID_MAX_LENGTH).toLowerCase()
  if (!normalized || RESERVED_MACHINE_IDS.has(normalized)) return ''
  return MACHINE_ID_PATTERN.test(normalized) ? normalized : ''
}

function normalizeWorkspacePoolIds(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const item of value) {
    const poolId = cleanText(item, WORKSPACE_POOL_ID_MAX_LENGTH)
    if (!poolId || seen.has(poolId) || seen.size >= WORKSPACE_POOL_LIMIT) continue
    seen.add(poolId)
  }
  return [...seen]
}

export function normalizeMachine(value) {
  if (!isRecord(value)) return null
  const machineId = normalizeMachineId(value.machineId)
  if (!machineId) return null

  return {
    machineId,
    label: cleanText(value.label, MACHINE_LABEL_MAX_LENGTH) || machineId,
    platform: cleanText(value.platform, MACHINE_PLATFORM_MAX_LENGTH),
    enabled: value.enabled !== false,
    workspacePoolIds: normalizeWorkspacePoolIds(value.workspacePoolIds),
    createdAt: isoOrNull(value.createdAt),
    updatedAt: isoOrNull(value.updatedAt),
    lastSeenAt: isoOrNull(value.lastSeenAt),
    // Runner 인증 토큰은 평문을 보관하지 않고 발급 시점에 한 번만 노출한다.
    tokenHash: /^[a-f0-9]{64}$/.test(String(value.tokenHash ?? '')) ? String(value.tokenHash) : null,
  }
}

export function hashMachineToken(token) {
  return createHash('sha256').update(String(token ?? '')).digest('hex')
}

// 저장 파일은 머신 배열이고 각 항목이 role을 들고 있다.
// 정규화 단계에서 main을 하나만 남기고 나머지는 sub로 강등해 이후 로직이 분기를 갖지 않게 한다.
export function normalizeMachineRegistry(value) {
  const source = Array.isArray(value) ? value : []
  const machines = []
  const seen = new Set()
  let mainMachineId = ''

  for (const item of source) {
    const machine = normalizeMachine(item)
    if (!machine || seen.has(machine.machineId) || machines.length >= MACHINE_LIMIT) continue
    seen.add(machine.machineId)
    if (!mainMachineId && cleanText(item?.role, 16).toLowerCase() === 'main') {
      mainMachineId = machine.machineId
    }
    machines.push(machine)
  }

  return { version: MACHINE_REGISTRY_VERSION, mainMachineId, machines }
}

export function serializeMachineRegistry(registry) {
  const normalized = isRecord(registry) && Array.isArray(registry.machines)
    ? registry
    : normalizeMachineRegistry([])
  return normalized.machines.map((machine) => ({
    ...machine,
    role: machine.machineId === normalized.mainMachineId ? 'main' : 'sub',
  }))
}

export function machineRole(registry, machineId) {
  const normalized = normalizeMachineId(machineId)
  if (!normalized) return null
  return normalized === registry?.mainMachineId ? 'main' : 'sub'
}

export function findMachine(registry, machineId) {
  const normalized = normalizeMachineId(machineId)
  if (!normalized) return null
  return registry?.machines?.find((machine) => machine.machineId === normalized) ?? null
}

export function isMainMachine(registry, machineId) {
  return machineRole(registry, machineId) === 'main'
}

export function publicMachine(registry, machine) {
  return {
    machineId: machine.machineId,
    label: machine.label,
    role: machine.machineId === registry?.mainMachineId ? 'main' : 'sub',
    platform: machine.platform,
    enabled: machine.enabled,
    workspacePoolIds: machine.workspacePoolIds,
    lastSeenAt: machine.lastSeenAt,
    hasToken: Boolean(machine.tokenHash),
  }
}

export function publicMachineRegistry(registry) {
  const normalized = isRecord(registry) && Array.isArray(registry.machines)
    ? registry
    : normalizeMachineRegistry([])
  return {
    mainMachineId: normalized.mainMachineId,
    machines: normalized.machines.map((machine) => publicMachine(normalized, machine)),
  }
}

// 메인 머신 레코드는 MnP가 실행되는 머신을 그대로 반영하므로 서버가 기동할 때마다 보정한다.
export function ensureMainMachine(registry, descriptor, now = new Date().toISOString()) {
  const machineId = normalizeMachineId(descriptor?.machineId)
  if (!machineId) throw new SubMachinePayloadError('메인 머신 ID가 올바르지 않습니다.')

  const label = cleanText(descriptor?.label, MACHINE_LABEL_MAX_LENGTH) || machineId
  const platform = cleanText(descriptor?.platform, MACHINE_PLATFORM_MAX_LENGTH)
  const existing = findMachine(registry, machineId)
  const machines = registry.machines.filter((machine) => machine.machineId !== machineId)
  const mainMachine = {
    ...(existing ?? {
      machineId,
      workspacePoolIds: [],
      createdAt: now,
      lastSeenAt: null,
    }),
    machineId,
    label: existing?.label || label,
    platform,
    enabled: true,
    updatedAt: now,
    // 서브였던 머신이 메인이 되면 남은 Runner 토큰을 폐기한다.
    tokenHash: null,
  }

  return {
    version: MACHINE_REGISTRY_VERSION,
    mainMachineId: machineId,
    machines: [mainMachine, ...machines],
  }
}

export function upsertSubMachine(registry, input, now = new Date().toISOString()) {
  if (!isRecord(input)) throw new SubMachinePayloadError('머신 정보가 올바르지 않습니다.')

  const machineId = normalizeMachineId(input.machineId)
  if (!machineId) {
    throw new SubMachinePayloadError('머신 ID는 소문자, 숫자, 하이픈만 사용할 수 있습니다.')
  }
  if (machineId === registry.mainMachineId) {
    throw new SubMachinePayloadError('메인 머신은 서브 머신으로 등록할 수 없습니다.')
  }

  const label = cleanText(input.label, MACHINE_LABEL_MAX_LENGTH)
  if (!label) throw new SubMachinePayloadError('머신 이름이 필요합니다.')

  const existing = findMachine(registry, machineId)
  if (!existing && registry.machines.length >= MACHINE_LIMIT) {
    throw new SubMachinePayloadError(`머신은 최대 ${MACHINE_LIMIT}대까지 등록할 수 있습니다.`)
  }

  const machine = {
    machineId,
    label,
    platform: cleanText(input.platform, MACHINE_PLATFORM_MAX_LENGTH),
    enabled: input.enabled !== false,
    workspacePoolIds: normalizeWorkspacePoolIds(input.workspacePoolIds),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: existing?.lastSeenAt ?? null,
    // 이름이나 플랫폼만 고칠 때 이미 발급한 Runner 토큰이 무효화되면 안 된다.
    tokenHash: existing?.tokenHash ?? null,
  }

  return {
    ...registry,
    machines: existing
      ? registry.machines.map((current) => (current.machineId === machineId ? machine : current))
      : [...registry.machines, machine],
  }
}

export function removeSubMachine(registry, machineId) {
  const normalized = normalizeMachineId(machineId)
  if (!normalized) throw new SubMachinePayloadError('삭제할 머신 ID가 올바르지 않습니다.')
  if (normalized === registry.mainMachineId) {
    throw new SubMachinePayloadError('메인 머신은 삭제할 수 없습니다.')
  }
  if (!findMachine(registry, normalized)) {
    throw new SubMachinePayloadError('등록된 머신을 찾지 못했습니다.')
  }
  return {
    ...registry,
    machines: registry.machines.filter((machine) => machine.machineId !== normalized),
  }
}

// 토큰은 서브 머신에만 발급한다. 메인 머신의 AionUi는 항상 루프백으로 직접 호출한다.
export function setMachineToken(registry, machineId, token, now = new Date().toISOString()) {
  const machine = findMachine(registry, machineId)
  if (!machine) throw new SubMachinePayloadError('등록된 머신을 찾지 못했습니다.')
  if (machine.machineId === registry.mainMachineId) {
    throw new SubMachinePayloadError('메인 머신에는 Runner 토큰을 발급하지 않습니다.')
  }
  const tokenHash = token === null ? null : hashMachineToken(token)
  return {
    ...registry,
    machines: registry.machines.map((current) => (
      current.machineId === machine.machineId ? { ...current, tokenHash, updatedAt: now } : current
    )),
  }
}

export function verifyMachineToken(registry, machineId, token) {
  const machine = findMachine(registry, machineId)
  if (!machine || !machine.enabled || !machine.tokenHash) return false
  if (machine.machineId === registry.mainMachineId) return false
  const candidate = Buffer.from(hashMachineToken(token), 'hex')
  const expected = Buffer.from(machine.tokenHash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

export function touchMachine(registry, machineId, now = new Date().toISOString()) {
  const machine = findMachine(registry, machineId)
  if (!machine) return registry
  return {
    ...registry,
    machines: registry.machines.map((current) => (
      current.machineId === machine.machineId ? { ...current, lastSeenAt: now } : current
    )),
  }
}

// 분산 작업은 사용자가 계정 설정에서 켤 때만 동작한다.
// 비활성 사용자는 기존 단일 머신 흐름을 그대로 사용해야 하므로 기본값은 항상 꺼진 상태다.
export function normalizeDistributedWorkSettings(value) {
  const source = isRecord(value) ? value : {}
  return {
    enabled: source.enabled === true,
    defaultMachineId: normalizeMachineId(source.defaultMachineId) || null,
  }
}

// 등록이 취소되거나 비활성화된 머신이 기본값으로 남아 있으면 조용히 메인으로 되돌린다.
export function resolveDistributedWorkSettings(value, registry) {
  const settings = normalizeDistributedWorkSettings(value)
  if (!settings.enabled) return { enabled: false, defaultMachineId: null }

  const machine = findMachine(registry, settings.defaultMachineId)
  return {
    enabled: true,
    defaultMachineId: machine && machine.enabled ? machine.machineId : null,
  }
}

// 사용자가 위임 대상으로 고를 수 있는 머신 목록이다.
// 활성화하지 않은 사용자에게는 메인 머신만 노출해 기존 동작과 같은 상태를 유지한다.
export function distributedWorkTargets(registry, value) {
  const normalized = isRecord(registry) && Array.isArray(registry.machines)
    ? registry
    : normalizeMachineRegistry([])
  const settings = resolveDistributedWorkSettings(value, normalized)
  const machines = normalized.machines
    .filter((machine) => machine.enabled)
    .filter((machine) => settings.enabled || machine.machineId === normalized.mainMachineId)
    .map((machine) => publicMachine(normalized, machine))

  machines.sort((first, second) => {
    if (first.role !== second.role) return first.role === 'main' ? -1 : 1
    return first.label.localeCompare(second.label, 'ko-KR')
  })

  return {
    enabled: settings.enabled,
    defaultMachineId: settings.defaultMachineId ?? normalized.mainMachineId,
    machines,
  }
}
