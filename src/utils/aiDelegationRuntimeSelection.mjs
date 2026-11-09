// 2026-11-09 사용자 결정: 하위 위임의 AI 설정은 계정 메뉴 「AI 위임 규칙」(서버 규칙)으로 일원화했다.
// 대화 시작 화면의 위임 설정은 코드와 저장값을 남긴 채 사용하지 않는다(미사용 고정). true로 바꾸면 다시 쓸 수 있다.
export const AI_DELEGATION_DIALOG_SETTING_AVAILABLE = false
const storagePrefix = 'mindnprogress-ai-delegation-runtime:'
const optionalFields = ['modelId', 'mode', 'thoughtLevel']
export const AI_DELEGATION_NARRATIVE_MAX_LENGTH = 4_000

export function normalizeAiDelegationRuntime(value) {
  const clean = field => typeof value?.[field] === 'string' && value[field].trim().length <= 512 ? value[field].trim() : ''
  const agentId = clean('agentId')
  return { agentId, ...Object.fromEntries(optionalFields.map(field => [field, agentId ? clean(field) : ''])) }
}

function storageKey(userId, machineId) {
  return userId && machineId ? `${storagePrefix}${encodeURIComponent(userId)}:${encodeURIComponent(machineId)}` : null
}

export function normalizeAiDelegationPreferences(value) {
  return {
    enabled: value?.enabled === true,
    selection: normalizeAiDelegationRuntime(value?.selection),
    narrativeMode: value?.narrativeMode === true,
    narrativeText: typeof value?.narrativeText === 'string' && value.narrativeText.length <= AI_DELEGATION_NARRATIVE_MAX_LENGTH ? value.narrativeText : '',
  }
}

export function readAiDelegationPreferences(userId, machineId, storage) {
  const key = storageKey(userId, machineId)
  if (!key) return null
  try {
    const saved = JSON.parse((storage ?? globalThis.localStorage).getItem(key) ?? 'null')
    if (![1, 2, 3].includes(saved?.version)) return null
    // 이전 선택형 설정도 자동 복원하되 읽기만으로 저장 원본을 덮어쓰지 않는다.
    const value = normalizeAiDelegationPreferences(saved.version === 1 ? { selection: saved.selection } : saved)
    // 사용 여부가 없던 버전은 실제 전달하던 설정이 있을 때만 사용 상태로 복원한다.
    if (saved.version < 3) value.enabled = value.narrativeMode ? Boolean(value.narrativeText.trim()) : Boolean(value.selection.agentId)
    return value
  } catch {
    return null
  }
}

export function saveAiDelegationPreferences(userId, machineId, value, storage) {
  const key = storageKey(userId, machineId)
  if (!key) return false
  try {
    // 사용자 조작에서만 저장한다. 명시적으로 비운 값도 다음 진입에서 그대로 복원한다.
    (storage ?? globalThis.localStorage).setItem(key, JSON.stringify({ version: 3, ...normalizeAiDelegationPreferences(value) }))
    return true
  } catch {
    // 저장이 불가능해도 현재 팝업의 선택과 대화 시작은 유지한다.
    return false
  }
}

export function resolveAiDelegationRuntime(value, agents) {
  const saved = normalizeAiDelegationRuntime(value)
  const agent = agents.find(item => item.id === saved.agentId)
  if (!agent) return { selection: normalizeAiDelegationRuntime(null), unavailableFields: saved.agentId ? ['AI 종류'] : [] }
  const selection = { ...saved }
  const unavailableFields = []
  for (const [field, list, label] of [['modelId', 'models', '모델'], ['mode', 'modes', '권한'], ['thoughtLevel', 'thoughtLevels', '사고 수준']]) {
    if (saved[field] && !agent[list].some(item => item.id === saved[field])) {
      selection[field] = ''
      unavailableFields.push(label)
    }
  }
  return { selection, unavailableFields }
}
