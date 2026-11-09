import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  aiDelegationCardLevel,
  aiDelegationPolicy,
  aiDelegationPolicyAdjustments,
  aiDelegationPolicySignature,
  aiDelegationPolicyView,
  aiDelegationResumeModelMatches,
  aiDelegationPolicyRevision,
  applyAiDelegationPolicyRule,
  createAiDelegationPolicyStore,
  normalizeAiDelegationPolicy,
  parseAiDelegationPolicyRequest,
  resolveAiDelegationPolicyRule,
} from '../server/lib/aiDelegationPolicy.mjs'

const option = (id) => ({ id, label: id })
const agents = [
  { id: 'claude-agent', name: 'Claude Code', backend: 'claude', models: [option('opus'), option('sonnet')],
    thoughtLevels: ['high', 'xhigh', 'max'].map(option), modes: ['default', 'acceptEdits', 'bypassPermissions'].map(option) },
  { id: 'codex-agent', name: 'Codex CLI', backend: 'codex', models: [option('gpt-6.1-sol'), option('gpt-6-astra')],
    thoughtLevels: ['high', 'xhigh', 'max'].map(option), modes: ['read-only', 'full-access'].map(option) },
]

test('사용자 규칙 표의 모든 조합이 정확히 한 행에 일치하고 행의 값을 섞지 않는다', () => {
  const expected = {
    'review/document-root/standard': ['review/any/standard', 'claude', 'opus', 'xhigh'],
    'review/sub-card/standard': ['review/any/standard', 'claude', 'opus', 'xhigh'],
    'review/document-root/deep': ['review/any/deep', 'claude', 'opus', 'max'],
    'review/sub-card/deep': ['review/any/deep', 'claude', 'opus', 'max'],
    'other/document-root/standard': ['other/document-root/any', 'claude', 'opus', 'xhigh'],
    'other/document-root/deep': ['other/document-root/any', 'claude', 'opus', 'xhigh'],
    'other/sub-card/standard': ['other/sub-card/standard', 'codex', 'gpt-6.1-sol', 'xhigh'],
    'other/sub-card/deep': ['other/sub-card/deep', 'codex', 'gpt-6.1-sol', 'max'],
  }
  for (const [key, [id, backend, modelId, thoughtLevelId]] of Object.entries(expected)) {
    const [workType, cardLevel, analysisDepth] = key.split('/')
    const rule = resolveAiDelegationPolicyRule({ workType, analysisDepth }, cardLevel)
    assert.deepEqual([rule.id, rule.agent.backend, rule.modelId, rule.thoughtLevelId], [id, backend, modelId, thoughtLevelId], key)
  }
  // 모델이 CLI를 정한다(Opus → Claude Code, Sol → Codex CLI).
  for (const rule of aiDelegationPolicy.rules) assert.equal(rule.agent.backend, rule.modelId === 'opus' ? 'claude' : 'codex', rule.id)
})

test('문서 루트만 상위 카드이고 하위에 다시 위임하는 중간 카드는 하위 카드다', () => {
  assert.equal(aiDelegationCardLevel('root', 'root'), 'document-root')
  assert.equal(aiDelegationCardLevel('middle', 'root'), 'sub-card')
  assert.equal(aiDelegationCardLevel('leaf', undefined), 'sub-card')
})

test('요청 값을 검증하고, 규칙 값이 없는 이전 요청은 기존 방식으로 둔다', () => {
  assert.equal(parseAiDelegationPolicyRequest({ strategy: 'new' }), null)
  assert.equal(aiDelegationPolicySignature(null), null)
  assert.deepEqual(parseAiDelegationPolicyRequest({ workType: 'other' }), { workType: 'other', analysisDepth: 'standard', override: null })
  assert.deepEqual(parseAiDelegationPolicyRequest({ workType: 'review', analysisDepth: 'deep', aiPolicyOverride: { evidence: ' 이번엔 Sonnet으로 ' } }),
    { workType: 'review', analysisDepth: 'deep', override: { evidence: '이번엔 Sonnet으로' } })
  for (const body of [{ workType: 'implement' }, { analysisDepth: 'deep' }, { workType: 'other', analysisDepth: 'max' },
    { aiPolicyOverride: { evidence: '사용자 지정' } }, { workType: 'other', aiPolicyOverride: { evidence: '' } }, { workType: 'other', aiPolicyOverride: 'x' }]) {
    assert.throws(() => parseAiDelegationPolicyRequest(body), (error) => error.reasonCode === 'AI_DELEGATION_POLICY_REQUEST_INVALID', JSON.stringify(body))
  }
  assert.deepEqual(aiDelegationPolicySignature({ workType: 'other', analysisDepth: 'deep', override: null }),
    { workType: 'other', analysisDepth: 'deep', overrideEvidence: null })
})

test('규칙 행을 실행 머신의 에이전트에 맞추고, 모드는 같은 CLI의 값만 물려받는다', () => {
  const sub = resolveAiDelegationPolicyRule({ workType: 'other', analysisDepth: 'standard' }, 'sub-card')
  const claudeParent = { agent: { id: 'claude-agent' }, mode: { id: 'acceptEdits' } }
  // Claude 상위 대화의 acceptEdits를 Codex 하위 대화에 넘기지 않고 Codex 기본 모드를 쓴다.
  const fromClaudeParent = applyAiDelegationPolicyRule({ rule: sub, agents, requested: { agentId: 'claude-agent', modelId: 'opus', modeId: 'bypassPermissions' }, inherited: [null, claudeParent] })
  assert.deepEqual(fromClaudeParent.agent, { id: 'codex-agent', label: 'Codex CLI' })
  assert.deepEqual([fromClaudeParent.model.id, fromClaudeParent.thoughtLevel.id, fromClaudeParent.mode.id], ['gpt-6.1-sol', 'xhigh', 'full-access'])
  // 같은 카드의 이전 Codex 대화 모드는 물려받는다.
  const fromCodexLink = applyAiDelegationPolicyRule({ rule: sub, agents, requested: undefined, inherited: [{ agent: { id: 'codex-agent' }, mode: { id: 'read-only' } }, claudeParent] })
  assert.equal(fromCodexLink.mode.id, 'read-only')
  // 에이전트를 적지 않은 요청의 모드는 그 CLI에 있으면 쓴다.
  assert.equal(applyAiDelegationPolicyRule({ rule: sub, agents, requested: { modeId: 'read-only' } }).mode.id, 'read-only')
  const review = resolveAiDelegationPolicyRule({ workType: 'review', analysisDepth: 'deep' }, 'sub-card')
  const reviewer = applyAiDelegationPolicyRule({ rule: review, agents, requested: {}, inherited: [{ agent: { id: 'claude-agent' }, mode: { id: 'bypassPermissions' } }] })
  assert.deepEqual([reviewer.agent.id, reviewer.model.id, reviewer.thoughtLevel.id, reviewer.mode.id], ['claude-agent', 'opus', 'max', 'bypassPermissions'])
  assert.equal(applyAiDelegationPolicyRule({ rule: review, agents, requested: {} }).mode.id, 'acceptEdits')
})

test('규칙의 모델·사고 강도가 실행 머신에 없으면 다른 값으로 바꾸지 않고 거절한다', () => {
  const sub = resolveAiDelegationPolicyRule({ workType: 'other', analysisDepth: 'deep' }, 'sub-card')
  const withoutSol = agents.map((agent) => agent.backend === 'codex' ? { ...agent, models: [option('gpt-6-astra')] } : agent)
  assert.throws(() => applyAiDelegationPolicyRule({ rule: sub, agents: withoutSol, requested: {} }),
    (error) => error.reasonCode === 'AI_DELEGATION_POLICY_UNAVAILABLE' && error.status === 409 && /gpt-6\.1-sol/.test(error.message))
  const withoutMax = agents.map((agent) => agent.backend === 'codex' ? { ...agent, thoughtLevels: [option('xhigh')] } : agent)
  assert.throws(() => applyAiDelegationPolicyRule({ rule: sub, agents: withoutMax, requested: {} }),
    (error) => error.reasonCode === 'AI_DELEGATION_POLICY_UNAVAILABLE' && /max/.test(error.message))
})

test('이어갈 대화의 모델 비교와 응답 표기는 옛 규칙 값과 새 대화 전환을 알린다', () => {
  const sub = resolveAiDelegationPolicyRule({ workType: 'other', analysisDepth: 'standard' }, 'sub-card')
  assert.equal(aiDelegationResumeModelMatches(sub, 'gpt-6.1-sol'), true)
  assert.equal(aiDelegationResumeModelMatches(sub, 'GPT-6.1-Sol'), true)
  assert.equal(aiDelegationResumeModelMatches(sub, 'opus'), false)
  assert.equal(aiDelegationResumeModelMatches(sub, ''), null)
  const selection = { agent: { id: 'codex-agent', label: 'Codex CLI' }, model: { id: 'gpt-6.1-sol' }, thoughtLevel: { id: 'xhigh' }, mode: { id: 'full-access' } }
  const adjustments = aiDelegationPolicyAdjustments({ agentId: 'codex-agent', modelId: 'gpt-6-astra', thoughtLevelId: 'high', workspace: 'C:/x' }, selection)
  assert.deepEqual(adjustments, [{ field: 'modelId', requested: 'gpt-6-astra', applied: 'gpt-6.1-sol' }, { field: 'thoughtLevelId', requested: 'high', applied: 'xhigh' }])
  const view = aiDelegationPolicyView({ request: { workType: 'other', analysisDepth: 'standard', override: null }, cardLevel: 'sub-card', rule: sub, selection, adjustments,
    resumeConversion: { conversationId: 'old', currentModelId: 'opus', expectedModelId: 'gpt-6.1-sol' } })
  assert.equal(view.rule, 'other/sub-card/standard')
  assert.deepEqual(view.applied, { agent: 'Codex CLI', model: 'gpt-6.1-sol', thoughtLevel: 'xhigh', mode: 'full-access' })
  assert.match(view.message, /규칙 값을 적용/)
  assert.match(view.message, /old의 모델\(opus\)이 위임 규칙 모델\(gpt-6\.1-sol\)과 달라 새 대화로 바꿨습니다/)
  assert.match(view.revision, /^[a-f0-9]{16}$/)
  assert.deepEqual(aiDelegationPolicyAdjustments(undefined, selection), [])
})

const content = (policy) => JSON.parse(JSON.stringify({ rules: policy.rules.map(({ id: _id, ...rest }) => rest), defaultModes: policy.defaultModes }))

test('저장할 규칙은 8개 조건이 모두 정확히 한 행에 맞아야 하고, 빠짐·겹침 조건을 알린다', () => {
  const base = content(aiDelegationPolicy)
  assert.deepEqual(content(normalizeAiDelegationPolicy(base)), base)
  const missing = { ...base, rules: base.rules.filter((rule) => !(rule.workType === 'other' && rule.analysisDepth === 'deep')) }
  assert.throws(() => normalizeAiDelegationPolicy(missing), (error) => error.reasonCode === 'AI_DELEGATION_POLICY_INVALID'
    && /검수 외·하위 카드·대규모·복잡한 분석\(맞는 행 없음\)/.test(error.message))
  const overlap = { ...base, rules: [...base.rules, { ...base.rules[0], cardLevel: 'sub-card' }] }
  assert.throws(() => normalizeAiDelegationPolicy(overlap), /검수·하위 카드·기본\(2개 행이 겹침\)/)
  for (const broken of [{ workType: 'implement' }, { cardLevel: 'middle' }, { analysisDepth: 'max' }, { agent: { backend: 'Claude Code' } }, { modelId: ' ' }, { thoughtLevelId: '' }]) {
    assert.throws(() => normalizeAiDelegationPolicy({ ...base, rules: [{ ...base.rules[0], ...broken }, ...base.rules.slice(1)] }),
      (error) => error.reasonCode === 'AI_DELEGATION_POLICY_INVALID', JSON.stringify(broken))
  }
  assert.throws(() => normalizeAiDelegationPolicy({ rules: [] }), /1~24개 행/)
  // 사용자가 문서 루트의 대규모 분석만 max로 나누는 것처럼 행 구조도 바꿀 수 있다.
  const split = { ...base, rules: [...base.rules.filter((rule) => rule.cardLevel !== 'document-root'),
    { ...base.rules[2], analysisDepth: 'standard' }, { ...base.rules[2], analysisDepth: 'deep', thoughtLevelId: 'max' }] }
  const normalized = normalizeAiDelegationPolicy(split)
  assert.equal(resolveAiDelegationPolicyRule({ workType: 'other', analysisDepth: 'deep' }, 'document-root', normalized).thoughtLevelId, 'max')
  assert.equal(normalizeAiDelegationPolicy({ ...base, defaultModes: { claude: '', codex: 'auto' } }).defaultModes.claude, undefined)
})

test('위임 규칙 저장소는 저장값을 다시 읽고, 다른 곳의 먼저 저장을 덮지 않으며, 깨진 파일로 기본값을 대신 쓰지 않는다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-delegation-policy-'))
  try {
    const store = await createAiDelegationPolicyStore({ dataDirectory: directory })
    const initial = store.get()
    assert.equal(initial.source, 'default')
    assert.equal(initial.revision, aiDelegationPolicyRevision(aiDelegationPolicy))
    const changed = content(aiDelegationPolicy)
    changed.rules[3] = { ...changed.rules[3], modelId: 'gpt-6-astra', thoughtLevelId: 'high' }
    const saved = await store.set(changed, { baseRevision: initial.revision, actor: { id: 'user-editor', name: '김용민', email: 'x@y' } })
    assert.equal(saved.source, 'saved')
    assert.deepEqual(saved.updatedBy, { id: 'user-editor', name: '김용민' })
    assert.notEqual(saved.revision, initial.revision)
    await assert.rejects(store.set(content(aiDelegationPolicy), { baseRevision: initial.revision, actor: null }),
      (error) => error.reasonCode === 'AI_DELEGATION_POLICY_CONFLICT' && error.status === 409 && error.current.revision === saved.revision)
    const reloaded = (await createAiDelegationPolicyStore({ dataDirectory: directory })).get()
    assert.equal(reloaded.revision, saved.revision)
    assert.equal(resolveAiDelegationPolicyRule({ workType: 'other', analysisDepth: 'standard' }, 'sub-card', reloaded.policy).modelId, 'gpt-6-astra')
    const file = path.join(directory, '_ai-delegation-policy.json')
    const stored = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.rules.length, 5)
    await writeFile(file, JSON.stringify({ ...stored, rules: stored.rules.slice(1) }))
    await assert.rejects(createAiDelegationPolicyStore({ dataDirectory: directory }), /_ai-delegation-policy\.json\)이 올바르지 않습니다/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
