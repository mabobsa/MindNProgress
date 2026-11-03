const SNAPSHOT_STATES = new Set(['loading', 'ready', 'partial', 'unavailable'])
const PROVIDER_STATES = new Set(['loading', 'ready', 'unavailable'])

function isoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function normalizedPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

function normalizeWindow(value, { includeDuration = false } = {}) {
  if (!value || typeof value !== 'object') return null
  const usedPercent = normalizedPercent(value.usedPercent)
  if (usedPercent === null) return null
  const window = {
    usedPercent,
    resetsAt: isoDate(value.resetsAt),
  }
  if (includeDuration) {
    const duration = Number(value.windowDurationMins)
    window.windowDurationMins = Number.isFinite(duration) && duration > 0 ? duration : null
  }
  return window
}

function providerIsStale(state, updatedAt, now, staleAfterMs) {
  if (state !== 'ready') return false
  if (!updatedAt) return true
  const age = now - Date.parse(updatedAt)
  return !Number.isFinite(age) || age > staleAfterMs
}

function normalizeClaude(value, now, staleAfterMs) {
  const state = PROVIDER_STATES.has(value?.state) ? value.state : 'unavailable'
  const updatedAt = isoDate(value?.updatedAt)
  return {
    state,
    updatedAt,
    stale: providerIsStale(state, updatedAt, now, staleAfterMs),
    session: normalizeWindow(value?.session),
    weekly: normalizeWindow(value?.weekly),
  }
}

function normalizeCodex(value, now, staleAfterMs) {
  const state = PROVIDER_STATES.has(value?.state) ? value.state : 'unavailable'
  const updatedAt = isoDate(value?.updatedAt)
  return {
    state,
    updatedAt,
    stale: providerIsStale(state, updatedAt, now, staleAfterMs),
    // 5시간 창은 요금제에 따라 없다. 키가 없거나(이전 스냅숏) null이면 null이다. 한도 도달은 AionUi가 두 창을 함께 판정한 값을 쓴다.
    session: normalizeWindow(value?.session, { includeDuration: true }),
    weekly: normalizeWindow(value?.weekly, { includeDuration: true }),
    limitReached: value?.limitReached === true,
  }
}

export function normalizeAionUiSubscriptionUsage(value, {
  now = Date.now(),
  staleAfterMs = 180_000,
} = {}) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    return {
      available: false,
      state: 'unavailable',
      generatedAt: null,
      updatedAt: null,
      retryAfterMs: null,
      claude: null,
      codex: null,
    }
  }

  const retryAfterMs = Number(value.retryAfterMs)
  return {
    available: true,
    state: SNAPSHOT_STATES.has(value.state) ? value.state : 'unavailable',
    generatedAt: isoDate(value.generatedAt),
    updatedAt: isoDate(value.updatedAt),
    retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.max(1_000, Math.min(60_000, retryAfterMs))
      : null,
    claude: normalizeClaude(value.claude, now, staleAfterMs),
    codex: normalizeCodex(value.codex, now, staleAfterMs),
    ...normalizeClaudeAccounts(value.claudeAccounts, now, staleAfterMs),
  }
}

// Claude 멀티 계정: 계정이 2개 이상일 때만 계정별 사용량을 더한다. `claude`는 기본 계정이다.
function normalizeClaudeAccounts(value, now, staleAfterMs) {
  if (!Array.isArray(value) || value.length < 2) return {}
  const claudeAccounts = value.flatMap((account) => {
    const id = String(account?.id ?? '').trim().slice(0, 120)
    const number = Number(account?.number)
    if (!id || !Number.isInteger(number) || number < 1) return []
    return [{ id, number, label: String(account?.label ?? '').trim().slice(0, 80) || id, ...normalizeClaude(account, now, staleAfterMs) }]
  })
  return claudeAccounts.length >= 2 ? { claudeAccounts } : {}
}

export async function readAionUiSubscriptionUsage(filePath, {
  readText,
  now = Date.now(),
  staleAfterMs = 180_000,
} = {}) {
  try {
    const text = await readText(filePath)
    return normalizeAionUiSubscriptionUsage(JSON.parse(text), { now, staleAfterMs })
  } catch {
    return normalizeAionUiSubscriptionUsage(null, { now, staleAfterMs })
  }
}
