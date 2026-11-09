import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeAiModelId } from './aiModelPolicy.mjs'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

// AI 위임·그룹 문서 지시 새 대화의 CLI·모델·사고 강도 규칙이다.
// 실제 규칙은 계정 메뉴 「AI 위임 규칙」에서 저장한 _ai-delegation-policy.json이고, 저장값이 없으면 아래 기본 규칙을 쓴다.
// 규칙을 바꿀 때 AI 대화에 알리지 않는다. 서버가 위임할 때 적용하고 응답 aiPolicy로 알린다.
// 업무 유형(검수 여부)을 먼저 보고 표의 한 행만 적용하며, 여러 행의 값을 섞지 않는다.
// 카드 구분은 문서 루트만 상위이고, 하위에 다시 위임하는 중간 카드도 하위다.
export const AI_DELEGATION_WORK_TYPES = Object.freeze(['review', 'other'])
export const AI_DELEGATION_ANALYSIS_DEPTHS = Object.freeze(['standard', 'deep'])
export const AI_DELEGATION_CARD_LEVELS = Object.freeze(['document-root', 'sub-card'])
const RULE_CARD_LEVELS = Object.freeze(['any', ...AI_DELEGATION_CARD_LEVELS])
const RULE_ANALYSIS_DEPTHS = Object.freeze(['any', ...AI_DELEGATION_ANALYSIS_DEPTHS])
const LABELS = Object.freeze({
  review: '검수', other: '검수 외', any: '모두', 'document-root': '문서 루트', 'sub-card': '하위 카드', standard: '기본', deep: '대규모·복잡한 분석',
})
const MAX_RULES = 24

// 행 ID는 조건에서 만든다. 같은 조건의 행은 하나뿐이므로 저장·응답에서 같은 행을 같은 ID로 가리킨다.
export const aiDelegationRuleId = ({ workType, cardLevel, analysisDepth }) => `${workType}/${cardLevel}/${analysisDepth}`
const rule = (workType, cardLevel, analysisDepth, agent, modelId, thoughtLevelId) =>
  Object.freeze({ id: aiDelegationRuleId({ workType, cardLevel, analysisDepth }), workType, cardLevel, analysisDepth, agent: Object.freeze(agent), modelId, thoughtLevelId })

const CLAUDE_CODE = { backend: 'claude', label: 'Claude Code' }
const CODEX_CLI = { backend: 'codex', label: 'Codex CLI' }

/** 2026-11-09 사용자 결정 규칙. 저장된 규칙이 없을 때와 화면의 「기본값 불러오기」에 쓴다. */
export const aiDelegationPolicy = Object.freeze({
  rules: Object.freeze([
    rule('review', 'any', 'standard', CLAUDE_CODE, 'opus', 'xhigh'),
    rule('review', 'any', 'deep', CLAUDE_CODE, 'opus', 'max'),
    rule('other', 'document-root', 'any', CLAUDE_CODE, 'opus', 'xhigh'),
    rule('other', 'sub-card', 'standard', CODEX_CLI, 'gpt-6.1-sol', 'xhigh'),
    rule('other', 'sub-card', 'deep', CODEX_CLI, 'gpt-6.1-sol', 'max'),
  ]),
  // 규칙에는 권한 모드가 없다. 같은 CLI의 요청값·기존 대화 모드가 없을 때만 이 값을 쓴다.
  // 다른 CLI의 모드를 물려받으면 실행 환경이 맞지 않으므로 상속하지 않는다.
  defaultModes: Object.freeze({ claude: 'acceptEdits', codex: 'full-access' }),
})

const policyContent = (policy) => ({
  rules: policy.rules.map(({ workType, cardLevel, analysisDepth, agent, modelId, thoughtLevelId }) =>
    ({ workType, cardLevel, analysisDepth, agent: { backend: agent.backend, label: agent.label }, modelId, thoughtLevelId })),
  defaultModes: { ...policy.defaultModes },
})
export const aiDelegationPolicyRevision = (policy = aiDelegationPolicy) =>
  createHash('sha256').update(JSON.stringify(policyContent(policy))).digest('hex').slice(0, 16)

const policyError = (status, reasonCode, message) => Object.assign(new Error(message), { status, reasonCode })
const invalid = (message) => policyError(400, 'AI_DELEGATION_POLICY_INVALID', message)
const cleanText = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null
const describeCombination = ({ workType, cardLevel, analysisDepth }) => `${LABELS[workType]}·${LABELS[cardLevel]}·${LABELS[analysisDepth]}`

/**
 * 화면·파일에서 받은 규칙을 검증한다. 업무 유형·카드 구분·분석 규모의 8개 조합이 모두 정확히 한 행에 일치해야 한다.
 * 모델·사고 강도가 실행 머신에 있는지는 위임할 때 확인한다(머신마다 다를 수 있다).
 */
export function normalizeAiDelegationPolicy(input) {
  if (!Array.isArray(input?.rules) || input.rules.length === 0 || input.rules.length > MAX_RULES) {
    throw invalid(`위임 규칙은 1~${MAX_RULES}개 행이어야 합니다.`)
  }
  const rules = input.rules.map((candidate, index) => {
    const row = `${index + 1}번째 행`
    if (!AI_DELEGATION_WORK_TYPES.includes(candidate?.workType)) throw invalid(`${row}의 업무 유형이 올바르지 않습니다.`)
    if (!RULE_CARD_LEVELS.includes(candidate.cardLevel)) throw invalid(`${row}의 카드 구분이 올바르지 않습니다.`)
    if (!RULE_ANALYSIS_DEPTHS.includes(candidate.analysisDepth)) throw invalid(`${row}의 분석 규모가 올바르지 않습니다.`)
    const backend = cleanText(candidate.agent?.backend, 40)
    if (!backend || !/^[a-z0-9][a-z0-9_-]*$/.test(backend)) throw invalid(`${row}의 CLI가 올바르지 않습니다.`)
    const modelId = cleanText(candidate.modelId, 200)
    const thoughtLevelId = cleanText(candidate.thoughtLevelId, 80)
    if (!modelId) throw invalid(`${row}의 모델을 선택하세요.`)
    if (!thoughtLevelId) throw invalid(`${row}의 사고 강도를 선택하세요.`)
    return rule(candidate.workType, candidate.cardLevel, candidate.analysisDepth,
      { backend, label: cleanText(candidate.agent.label, 80) ?? backend }, modelId, thoughtLevelId)
  })
  const problems = []
  for (const workType of AI_DELEGATION_WORK_TYPES) for (const cardLevel of AI_DELEGATION_CARD_LEVELS) for (const analysisDepth of AI_DELEGATION_ANALYSIS_DEPTHS) {
    const count = rules.filter((candidate) => candidate.workType === workType && ['any', cardLevel].includes(candidate.cardLevel)
      && ['any', analysisDepth].includes(candidate.analysisDepth)).length
    if (count !== 1) problems.push(`${describeCombination({ workType, cardLevel, analysisDepth })}(${count === 0 ? '맞는 행 없음' : `${count}개 행이 겹침`})`)
  }
  if (problems.length > 0) throw invalid(`모든 조건이 정확히 한 행에 맞아야 합니다. 확인할 조건: ${problems.join(', ')}`)
  const defaultModes = {}
  for (const [backend, modeId] of Object.entries(input.defaultModes ?? {})) {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(backend)) throw invalid('기본 권한 모드의 CLI가 올바르지 않습니다.')
    if (modeId === null || modeId === '') continue
    const mode = cleanText(modeId, 80)
    if (!mode) throw invalid(`${backend}의 기본 권한 모드가 올바르지 않습니다.`)
    defaultModes[backend] = mode
  }
  return Object.freeze({ rules: Object.freeze(rules), defaultModes: Object.freeze(defaultModes) })
}

const actorView = (actor) => actor?.id ? { id: String(actor.id), name: String(actor.name ?? actor.id) } : null

/** 위임 규칙 저장소. 파일이 없으면 기본 규칙을 쓰고, 형식이 깨진 파일은 다른 규칙으로 대신하지 않고 기동을 멈춘다. */
export async function createAiDelegationPolicyStore({ dataDirectory, replaceFile = replaceFileWithRetry }) {
  const file = path.join(dataDirectory, '_ai-delegation-policy.json')
  let state = { policy: aiDelegationPolicy, source: 'default', updatedAt: null, updatedBy: null }
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    if (stored?.version !== 1) throw new Error('AI 위임 규칙 파일(_ai-delegation-policy.json)의 형식을 확인할 수 없습니다.')
    let policy
    try { policy = normalizeAiDelegationPolicy(stored) } catch (error) { throw new Error(`AI 위임 규칙 파일(_ai-delegation-policy.json)이 올바르지 않습니다: ${error.message}`) }
    state = { policy, source: 'saved', updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null, updatedBy: actorView(stored.updatedBy) }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let queue = Promise.resolve()
  const view = () => ({ ...state, revision: aiDelegationPolicyRevision(state.policy) })
  const set = (input, { baseRevision, actor }) => {
    const operation = queue.then(async () => {
      if (baseRevision !== aiDelegationPolicyRevision(state.policy)) {
        throw Object.assign(policyError(409, 'AI_DELEGATION_POLICY_CONFLICT', '다른 곳에서 위임 규칙이 먼저 바뀌었습니다. 최신 규칙을 다시 불러온 뒤 수정하세요.'), { current: view() })
      }
      const policy = normalizeAiDelegationPolicy(input)
      const updatedAt = new Date().toISOString()
      const updatedBy = actorView(actor)
      await mkdir(dataDirectory, { recursive: true })
      const temporaryFile = `${file}.${randomBytes(5).toString('hex')}.tmp`
      try {
        await writeFile(temporaryFile, `${JSON.stringify({ version: 1, ...policyContent(policy), updatedAt, updatedBy }, null, 2)}\n`, 'utf8')
        await replaceFile(temporaryFile, file)
      } catch (error) { await rm(temporaryFile, { force: true }).catch(() => {}); throw error }
      state = { policy, source: 'saved', updatedAt, updatedBy }
      return view()
    })
    queue = operation.catch(() => {})
    return operation
  }
  return { get: view, set }
}

/** 화면에 주는 규칙 표현. 행 ID는 조건에서 다시 만들 수 있어 내보내지 않는다. */
export const aiDelegationPolicyPublicView = (policy) => policyContent(policy)

/**
 * 요청 본문의 workType·analysisDepth·aiPolicyOverride를 읽는다.
 * 세 값이 모두 없으면 null이며, 이전 도구 정의를 쓰는 대화의 요청처럼 기존 선택·상속을 그대로 쓴다.
 */
export function parseAiDelegationPolicyRequest(body) {
  const { workType, analysisDepth, aiPolicyOverride } = body ?? {}
  if (workType === undefined && analysisDepth === undefined && aiPolicyOverride === undefined) return null
  if (!AI_DELEGATION_WORK_TYPES.includes(workType)) {
    throw policyError(400, 'AI_DELEGATION_POLICY_REQUEST_INVALID', 'workType은 review(검수) 또는 other(검수 외)여야 합니다. analysisDepth·aiPolicyOverride도 workType과 함께 전달하세요.')
  }
  if (analysisDepth !== undefined && !AI_DELEGATION_ANALYSIS_DEPTHS.includes(analysisDepth)) {
    throw policyError(400, 'AI_DELEGATION_POLICY_REQUEST_INVALID', 'analysisDepth는 standard(기본) 또는 deep(대규모·복잡한 분석)이어야 합니다.')
  }
  let override = null
  if (aiPolicyOverride !== undefined) {
    const evidence = typeof aiPolicyOverride?.evidence === 'string' ? aiPolicyOverride.evidence.trim() : ''
    if (!evidence || evidence.length > 1_000) {
      throw policyError(400, 'AI_DELEGATION_POLICY_REQUEST_INVALID', 'aiPolicyOverride.evidence에는 이번 위임의 AI 설정을 직접 지정한 사용자 발언을 1~1000자로 적으세요.')
    }
    override = { evidence }
  }
  return { workType, analysisDepth: analysisDepth ?? 'standard', override }
}

/** 요청 서명에 넣을 값. 규칙 요청이 없으면 null이라 기존 요청의 서명이 바뀌지 않는다. */
export const aiDelegationPolicySignature = (request) => request
  ? { workType: request.workType, analysisDepth: request.analysisDepth, overrideEvidence: request.override?.evidence ?? null }
  : null

export const aiDelegationCardLevel = (targetCardId, documentRootCardId) =>
  targetCardId && targetCardId === documentRootCardId ? 'document-root' : 'sub-card'

export function resolveAiDelegationPolicyRule(request, cardLevel, policy = aiDelegationPolicy) {
  const matches = policy.rules.filter((candidate) => candidate.workType === request.workType
    && ['any', cardLevel].includes(candidate.cardLevel)
    && ['any', request.analysisDepth].includes(candidate.analysisDepth))
  if (matches.length !== 1) {
    throw policyError(500, 'AI_DELEGATION_POLICY_RULE_AMBIGUOUS', `위임 규칙에서 한 행을 정하지 못했습니다(일치 ${matches.length}행). 서버 위임 규칙 표를 확인하세요.`)
  }
  return matches[0]
}

const sameModel = (left, right) => Boolean(normalizeAiModelId(left)) && normalizeAiModelId(left) === normalizeAiModelId(right)
const optionId = (value) => String((value && typeof value === 'object' ? value.id : value) ?? '').trim()
const sourceAgentId = (source) => optionId(source?.agent) || String(source?.agentId ?? '').trim()
const sourceModeId = (source) => optionId(source?.mode) || String(source?.modeId ?? '').trim()

/**
 * 규칙 한 행을 실행 머신의 AionUi 에이전트 목록에 맞춘다.
 * 규칙의 모델·사고 강도가 없으면 다른 값으로 대체하지 않고 실패한다.
 */
export function applyAiDelegationPolicyRule({ rule: selected, agents, requested, inherited = [], policy = aiDelegationPolicy }) {
  const candidates = (agents ?? []).filter((agent) => agent.backend === selected.agent.backend
    && agent.models.some((model) => sameModel(model.id, selected.modelId)))
  const preferredAgentIds = [sourceAgentId(requested), ...inherited.map(sourceAgentId)].filter(Boolean)
  const agent = preferredAgentIds.map((id) => candidates.find((candidate) => candidate.id === id)).find(Boolean) ?? candidates[0]
  if (!agent) {
    throw policyError(409, 'AI_DELEGATION_POLICY_UNAVAILABLE', `위임 규칙의 ${selected.agent.label}·${selected.modelId}를 실행 머신의 AionUi에서 확인할 수 없어 위임하지 않았습니다. 다른 모델로 바꾸지 않았습니다. AionUi 에이전트·모델 설정 또는 서버 위임 규칙을 확인하세요.`)
  }
  const model = agent.models.find((candidate) => candidate.id === selected.modelId)
    ?? agent.models.find((candidate) => sameModel(candidate.id, selected.modelId))
  const thoughtLevel = agent.thoughtLevels.find((candidate) => candidate.id === selected.thoughtLevelId)
  if (agent.thoughtLevels.length > 0 && !thoughtLevel) {
    throw policyError(409, 'AI_DELEGATION_POLICY_UNAVAILABLE', `위임 규칙의 사고 강도 ${selected.thoughtLevelId}를 ${agent.name}에서 확인할 수 없어 위임하지 않았습니다. 다른 사고 강도로 바꾸지 않았습니다.`)
  }
  const validMode = (id) => id && (agent.modes.length === 0 || agent.modes.some((mode) => mode.id === id))
  const sameAgentModes = [requested, ...inherited]
    .filter((source) => source && (!sourceAgentId(source) ? source === requested : sourceAgentId(source) === agent.id))
    .map(sourceModeId)
  const modeId = sameAgentModes.find(validMode) || [policy.defaultModes[selected.agent.backend]].find(validMode) || null
  const label = (options, id) => options.find((option) => option.id === id)?.label ?? id
  return {
    agent: { id: agent.id, label: agent.name },
    model: { id: model.id, label: model.label },
    providerId: model.providerId ?? null,
    thoughtLevel: { id: selected.thoughtLevelId, label: label(agent.thoughtLevels, selected.thoughtLevelId) },
    mode: modeId ? { id: modeId, label: label(agent.modes, modeId) } : null,
  }
}

/** 이어갈 대화의 현재 모델이 규칙 모델과 같은지. 모델을 확인할 수 없으면 null이다. */
export function aiDelegationResumeModelMatches(selected, currentModelId) {
  if (!normalizeAiModelId(currentModelId)) return null
  return sameModel(currentModelId, selected.modelId)
}

/** 요청에 적은 AI 설정 중 규칙 적용으로 바뀐 항목. AI가 기억한 옛 규칙을 응답에서 바로잡는 용도다. */
export function aiDelegationPolicyAdjustments(requested, selection) {
  if (!requested || typeof requested !== 'object') return []
  return [
    ['agentId', selection.agent?.id], ['modelId', selection.model?.id], ['thoughtLevelId', selection.thoughtLevel?.id],
  ].flatMap(([key, applied]) => {
    const value = String(requested[key] ?? '').trim()
    return value && value !== applied ? [{ field: key, requested: value, applied: applied ?? null }] : []
  })
}

export function aiDelegationPolicyView({ request, cardLevel, rule: selected, selection, adjustments = [], resumeConversion = null, policy = aiDelegationPolicy }) {
  const applied = selection ? {
    agent: selection.agent?.label ?? selection.agent?.id ?? null,
    model: selection.model?.id ?? null,
    thoughtLevel: selection.thoughtLevel?.id ?? null,
    mode: selection.mode?.id ?? null,
  } : null
  const notes = []
  if (request.override) notes.push('사용자가 이번 위임에 직접 지정한 설정을 aiPolicyOverride로 받아 위임 규칙 대신 적용했습니다.')
  if (adjustments.length > 0) notes.push('요청에 적은 AI 설정 일부가 현재 위임 규칙과 달라 규칙 값을 적용했습니다. 위임 규칙은 서버가 정하므로 카드·지시에 AI 설정을 옮겨 적지 마세요.')
  if (resumeConversion) notes.push(`이어가려던 대화 ${resumeConversion.conversationId}의 모델(${resumeConversion.currentModelId})이 위임 규칙 모델(${resumeConversion.expectedModelId})과 달라 새 대화로 바꿨습니다. 이전 대화의 맥락은 이어지지 않습니다.`)
  return {
    revision: aiDelegationPolicyRevision(policy),
    workType: request.workType,
    analysisDepth: request.analysisDepth,
    cardLevel,
    rule: request.override ? null : selected.id,
    override: Boolean(request.override),
    applied,
    ...(adjustments.length > 0 ? { adjustments } : {}),
    ...(resumeConversion ? { resumeConversion } : {}),
    ...(notes.length > 0 ? { message: notes.join(' ') } : {}),
  }
}
