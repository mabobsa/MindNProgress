import { AsyncLocalStorage } from 'node:async_hooks'
import { createResourceQueue, currentStorageBudget } from './storageBudget.mjs'

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const rank = (key) => key === 'catalog' ? 0 : key.startsWith('doc:') ? 1 : key.startsWith('state:') ? 2 : 3
export const compareResourceKeys = (a, b) => rank(a) - rank(b) || compare(a, b)

export function storageResourceError(code, message) {
  return Object.assign(new Error(message), { code, status: code === 'RECOVERY_REQUIRED' ? 503 : 409, storageResourceError: true })
}

export function normalizeResourceKey(key) {
  if (key === 'catalog') return key
  if (/^(doc|notification):[a-zA-Z0-9_-]+$/.test(key)) return key
  if (key.startsWith('state:')) {
    const relative = key.slice(6).replaceAll('\\', '/')
    if (relative && !relative.startsWith('/') && !relative.includes(':')
      && relative.split('/').every((part) => part && part !== '.' && part !== '..')) return `state:${relative}`
  }
  throw storageResourceError('INVALID_RESOURCE_KEY', '저장 자원 경로가 올바르지 않습니다.')
}

// 한 데이터 루트의 API 프로세스 내부에서 사용한다. FIFO RW 큐이며 승격은 허용하지 않는다.
export function createStorageResources(options = {}) {
  const context = new AsyncLocalStorage()
  const queue = createResourceQueue(options)
  const blocked = new Set()
  function acquire(key, mode) {
    if (blocked.has(key)) throw storageResourceError('RECOVERY_REQUIRED', '저장 복구가 필요한 자원입니다.')
    return queue.acquire(key, mode)
  }
  const current = () => {
    const value = context.getStore()
    for (let scope = value; scope; scope = scope.parent) if (!scope.active) return null
    return value?.active ? value : null
  }
  const holds = (key, mode = 'read') => {
    const held = current()?.held.get(normalizeResourceKey(key))
    return held === 'write' || held === mode
  }
  const assert = (key, mode = 'write') => {
    if (!holds(key, mode)) throw storageResourceError('RESOURCE_NOT_HELD', `저장 자원 보호가 필요합니다: ${key}`)
  }
  async function withResources(requests, operation) {
    const budget = currentStorageBudget()
    budget?.assert()
    const parent = current()
    const requested = new Map()
    for (const item of requests) {
      const { key, mode = 'write' } = typeof item === 'string' ? { key: item } : item
      const normalized = normalizeResourceKey(key)
      if (!['read', 'write'].includes(mode)) throw new TypeError('Invalid resource mode')
      if (requested.get(normalized) !== 'write') requested.set(normalized, mode)
    }
    const held = new Map(parent?.held ?? [])
    const missing = [...requested].filter(([key, mode]) => {
      if (!held.has(key)) return true
      if (held.get(key) === 'read' && mode === 'write') throw storageResourceError('RESOURCE_UPGRADE_FORBIDDEN', '보유 중인 읽기 잠금을 쓰기로 승격할 수 없습니다.')
      // 전달된 보호 문맥을 재사용하며 같은 키의 큐에는 다시 들어가지 않는다.
      return false
    }).sort(([a], [b]) => compareResourceKeys(a, b))
    const last = [...held.keys()].sort(compareResourceKeys).at(-1)
    if (missing.length && last && compareResourceKeys(missing[0][0], last) < 0) {
      throw storageResourceError('RESOURCE_ORDER_VIOLATION', `자원 집합을 먼저 확정해야 합니다: ${missing[0][0]}`)
    }
    const releases = []
    const scope = { held, active: true, parent }
    let holdStarted
    try {
      for (const [key, mode] of missing) {
        releases.push(await acquire(key, mode))
        holdStarted ??= Date.now()
        budget?.resources.add(key)
        if (blocked.has(key)) throw storageResourceError('RECOVERY_REQUIRED', '저장 복구가 필요한 자원입니다.')
        held.set(key, mode)
      }
      budget?.assert()
      if (budget) budget.phase = 'validation'
      return await context.run(scope, () => operation(scope))
    } finally {
      scope.active = false
      for (const release of releases.reverse()) release()
      if (budget && holdStarted && !parent?.held.size) budget.lockHoldMs += Date.now() - holdStarted
    }
  }
  return { withResources, holds, assert, current, detached: (operation) => context.run(null, operation),
    isQuarantined: (key) => blocked.has(normalizeResourceKey(key)),
    quarantine: (keys) => { for (const key of keys) blocked.add(normalizeResourceKey(key)) },
    pending: queue.pending,
  }
}
