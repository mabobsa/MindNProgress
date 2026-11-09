import { useCallback, useEffect, useMemo, useState } from 'react'
import './AiDelegationPolicyDialog.css'

// 하위 카드 위임·그룹 문서 지시의 새 대화 CLI·모델·사고 강도를 정하는 서버 위임 규칙 편집 화면.
// 저장하면 다음 위임부터 서버가 적용하며 AI 대화에는 알리지 않는다(server/lib/aiDelegationPolicy.mjs).

type WorkType = 'review' | 'other'
type CardLevel = 'any' | 'document-root' | 'sub-card'
type AnalysisDepth = 'any' | 'standard' | 'deep'
type PolicyRule = {
  workType: WorkType
  cardLevel: CardLevel
  analysisDepth: AnalysisDepth
  agent: { backend: string; label: string }
  modelId: string
  thoughtLevelId: string
}
type PolicyContent = { rules: PolicyRule[]; defaultModes: Record<string, string> }
type PolicyResponse = {
  policy: PolicyContent
  revision: string
  source: 'default' | 'saved'
  updatedAt: string | null
  updatedBy: { id: string; name: string } | null
  defaults: PolicyContent
}
type AionOption = { id: string; label: string }
type AionAgent = {
  id: string
  name: string
  backend: string
  models: AionOption[]
  thoughtLevels: AionOption[]
  modes: AionOption[]
  defaultModelId?: string
  defaultThoughtLevel?: string
  defaultMode?: string
}

const WORK_TYPES: { id: WorkType; label: string }[] = [{ id: 'review', label: '검수' }, { id: 'other', label: '검수 외' }]
const CARD_LEVELS: { id: CardLevel; label: string }[] = [{ id: 'any', label: '모두' }, { id: 'document-root', label: '문서 루트' }, { id: 'sub-card', label: '하위 카드' }]
const ANALYSIS_DEPTHS: { id: AnalysisDepth; label: string }[] = [{ id: 'any', label: '모두' }, { id: 'standard', label: '기본' }, { id: 'deep', label: '대규모·복잡한 분석' }]

class PolicyRequestError extends Error {
  readonly status: number
  readonly body: { current?: PolicyResponse }
  constructor(message: string, status: number, body: { current?: PolicyResponse }) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function policyRequest<T>(pathname: string, init?: RequestInit) {
  const response = await fetch(pathname, {
    ...init,
    credentials: 'include',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string; current?: PolicyResponse }
  if (!response.ok) throw new PolicyRequestError(body.error ?? '요청을 처리하지 못했습니다.', response.status, body)
  return body
}

/** 서버 검증과 같은 기준으로, 모든 조건이 정확히 한 행에 맞는지 미리 알린다. */
function coverageProblems(rules: PolicyRule[]) {
  const problems: string[] = []
  for (const workType of WORK_TYPES) for (const cardLevel of CARD_LEVELS.slice(1)) for (const depth of ANALYSIS_DEPTHS.slice(1)) {
    const count = rules.filter((rule) => rule.workType === workType.id && ['any', cardLevel.id].includes(rule.cardLevel)
      && ['any', depth.id].includes(rule.analysisDepth)).length
    if (count !== 1) problems.push(`${workType.label}·${cardLevel.label}·${depth.label} (${count === 0 ? '맞는 행 없음' : `${count}개 행이 겹침`})`)
  }
  return problems
}

const sameContent = (left: PolicyContent | null, right: PolicyContent | null) => JSON.stringify(left) === JSON.stringify(right)
const cloneContent = (content: PolicyContent): PolicyContent => JSON.parse(JSON.stringify(content))

export function AiDelegationPolicyDialog({ onClose }: { onClose: () => void }) {
  const [saved, setSaved] = useState<PolicyResponse | null>(null)
  const [draft, setDraft] = useState<PolicyContent | null>(null)
  const [agents, setAgents] = useState<AionAgent[]>([])
  const [agentsError, setAgentsError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const applySaved = useCallback((payload: PolicyResponse) => {
    setSaved(payload)
    setDraft(cloneContent(payload.policy))
  }, [])

  useEffect(() => {
    let active = true
    void Promise.allSettled([
      policyRequest<PolicyResponse>('/api/account/ai-delegation-policy'),
      policyRequest<{ agents: AionAgent[] }>('/api/integrations/aionui/options'),
    ]).then(([policy, options]) => {
      if (!active) return
      if (policy.status === 'fulfilled') applySaved(policy.value)
      else setError(policy.reason instanceof Error ? policy.reason.message : 'AI 위임 규칙을 불러오지 못했습니다.')
      if (options.status === 'fulfilled') setAgents(options.value.agents ?? [])
      else setAgentsError(options.reason instanceof Error ? options.reason.message : 'AionUi 에이전트 목록을 불러오지 못했습니다.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [applySaved])

  const dirty = Boolean(saved && draft && !sameContent(saved.policy, draft))
  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('저장하지 않은 위임 규칙 변경을 버릴까요?')) return
    onClose()
  }, [dirty, onClose])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') requestClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [requestClose])

  // CLI는 AionUi 에이전트의 backend로 고른다. 같은 backend가 여럿이면 첫 에이전트의 모델·사고 강도 목록을 쓴다.
  const agentsByBackend = useMemo(() => {
    const map = new Map<string, AionAgent>()
    for (const agent of agents) if (agent.backend && !map.has(agent.backend)) map.set(agent.backend, agent)
    return map
  }, [agents])
  const problems = useMemo(() => (draft ? coverageProblems(draft.rules) : []), [draft])
  const usedBackends = useMemo(() => [...new Set(draft?.rules.map((rule) => rule.agent.backend) ?? [])], [draft])

  const updateRule = (index: number, patch: Partial<PolicyRule>) => {
    setDraft((current) => current && { ...current, rules: current.rules.map((rule, position) => position === index ? { ...rule, ...patch } : rule) })
    setNotice('')
  }

  const changeBackend = (index: number, backend: string) => {
    const agent = agentsByBackend.get(backend)
    if (!agent || !draft) return
    const current = draft.rules[index]
    const modelId = agent.models.some((model) => model.id === agent.defaultModelId) ? agent.defaultModelId! : agent.models[0]?.id ?? ''
    const thoughtLevelId = agent.thoughtLevels.some((level) => level.id === current.thoughtLevelId) ? current.thoughtLevelId
      : agent.thoughtLevels.some((level) => level.id === agent.defaultThoughtLevel) ? agent.defaultThoughtLevel! : agent.thoughtLevels[0]?.id ?? current.thoughtLevelId
    updateRule(index, { agent: { backend, label: agent.name }, modelId, thoughtLevelId })
  }

  const addRule = () => {
    const base = draft?.rules.at(-1)
    if (!draft || !base) return
    setDraft({ ...draft, rules: [...draft.rules, { ...base, agent: { ...base.agent } }] })
    setNotice('')
  }

  const removeRule = (index: number) => {
    setDraft((current) => current && { ...current, rules: current.rules.filter((_, position) => position !== index) })
    setNotice('')
  }

  const save = async () => {
    if (!saved || !draft || problems.length > 0) return
    setSubmitting(true)
    setError('')
    setNotice('')
    try {
      const defaultModes = Object.fromEntries(usedBackends.flatMap((backend) => draft.defaultModes[backend] ? [[backend, draft.defaultModes[backend]]] : []))
      const result = await policyRequest<PolicyResponse>('/api/account/ai-delegation-policy', {
        method: 'PUT',
        body: JSON.stringify({ rules: draft.rules, defaultModes, baseRevision: saved.revision }),
      })
      applySaved(result)
      setNotice('위임 규칙을 저장했습니다. 다음 위임부터 적용되며 AI 대화에는 따로 알리지 않습니다.')
    } catch (saveError) {
      if (saveError instanceof PolicyRequestError && saveError.status === 409 && saveError.body.current) {
        setSaved(saveError.body.current)
      }
      setError(saveError instanceof Error ? saveError.message : '위임 규칙을 저장하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  // AionUi에서 확인되지 않은 저장값도 지우지 않고 그대로 보여준다.
  const optionsWithCurrent = (options: AionOption[], current: string) =>
    options.some((option) => option.id === current) || !current ? options : [{ id: current, label: `${current} (AionUi에서 확인 안 됨)` }, ...options]
  const editable = agents.length > 0 && !submitting

  return (
    <div className="history-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) requestClose() }}>
      <section className="history-modal ai-delegation-policy-modal" role="dialog" aria-modal="true" aria-label="AI 위임 규칙">
        <header>
          <div><span>내 계정</span><strong>AI 위임 규칙</strong></div>
          <button onClick={requestClose} aria-label="AI 위임 규칙 닫기">
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>

        {loading ? (
          <div className="ai-delegation-policy-loading" role="status">위임 규칙을 불러오는 중…</div>
        ) : (
          <div className="ai-delegation-policy-body">
            <p className="ai-delegation-policy-intro">
              하위 카드 위임과 그룹 문서 지시로 새 AI 대화를 만들 때 서버가 이 표에서 한 행을 골라 CLI·모델·사고 강도를 정합니다.
              업무 유형(검수 여부)을 먼저 보며, 문서 루트만 상위 카드이고 하위에 다시 위임하는 중간 카드도 하위 카드입니다.
              이어가려는 대화의 모델이 규칙과 다르면 새 대화로 실행합니다. 저장하면 다음 위임부터 적용되며 AI 대화에는 따로 알리지 않습니다.
            </p>

            {agentsError && <div className="password-error" role="alert">{agentsError} 목록을 불러오기 전에는 규칙을 바꿀 수 없습니다.</div>}
            {error && <div className="password-error" role="alert">{error}</div>}
            {notice && <div className="distributed-work-notice" role="status">{notice}</div>}

            {draft && (
              <>
                <div className="ai-delegation-policy-table-wrap">
                  <table className="ai-delegation-policy-table">
                    <thead>
                      <tr><th>업무 유형</th><th>카드 구분</th><th>분석 규모</th><th>CLI</th><th>모델</th><th>사고 강도</th><th aria-label="행 삭제" /></tr>
                    </thead>
                    <tbody>
                      {draft.rules.map((rule, index) => {
                        const agent = agentsByBackend.get(rule.agent.backend)
                        const backendOptions = optionsWithCurrent([...agentsByBackend.values()].map((candidate) => ({ id: candidate.backend, label: candidate.name })), rule.agent.backend)
                        return (
                          <tr key={index}>
                            <td>
                              <select aria-label={`${index + 1}번째 행 업무 유형`} value={rule.workType} disabled={!editable} onChange={(event) => updateRule(index, { workType: event.target.value as WorkType })}>
                                {WORK_TYPES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <select aria-label={`${index + 1}번째 행 카드 구분`} value={rule.cardLevel} disabled={!editable} onChange={(event) => updateRule(index, { cardLevel: event.target.value as CardLevel })}>
                                {CARD_LEVELS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <select aria-label={`${index + 1}번째 행 분석 규모`} value={rule.analysisDepth} disabled={!editable} onChange={(event) => updateRule(index, { analysisDepth: event.target.value as AnalysisDepth })}>
                                {ANALYSIS_DEPTHS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <select aria-label={`${index + 1}번째 행 CLI`} value={rule.agent.backend} disabled={!editable} onChange={(event) => changeBackend(index, event.target.value)}>
                                {backendOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <select aria-label={`${index + 1}번째 행 모델`} value={rule.modelId} disabled={!editable || !agent} onChange={(event) => updateRule(index, { modelId: event.target.value })}>
                                {optionsWithCurrent(agent?.models ?? [], rule.modelId).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <select aria-label={`${index + 1}번째 행 사고 강도`} value={rule.thoughtLevelId} disabled={!editable || !agent} onChange={(event) => updateRule(index, { thoughtLevelId: event.target.value })}>
                                {optionsWithCurrent(agent?.thoughtLevels ?? [], rule.thoughtLevelId).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                              </select>
                            </td>
                            <td>
                              <button type="button" className="ai-delegation-policy-remove" disabled={!editable || draft.rules.length <= 1} onClick={() => removeRule(index)} aria-label={`${index + 1}번째 행 삭제`}>삭제</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="ai-delegation-policy-row-actions">
                  <button type="button" disabled={!editable} onClick={addRule}>행 추가</button>
                  <button type="button" disabled={!editable || !saved || sameContent(saved.defaults, draft)} onClick={() => { if (saved) { setDraft(cloneContent(saved.defaults)); setNotice('') } }}>기본값 불러오기</button>
                  <button type="button" disabled={submitting || !dirty} onClick={() => { if (saved) { setDraft(cloneContent(saved.policy)); setNotice('') } }}>변경 취소</button>
                </div>

                {problems.length > 0
                  ? <div className="password-error" role="alert">모든 조건이 정확히 한 행에 맞아야 저장할 수 있습니다. 확인할 조건: {problems.join(', ')}</div>
                  : <p className="ai-delegation-policy-hint">조건 8개({WORK_TYPES.map((option) => option.label).join('·')} × 문서 루트·하위 카드 × 기본·대규모 분석)가 모두 한 행에 맞습니다.</p>}

                <section className="ai-delegation-policy-modes">
                  <h4>기본 권한 모드</h4>
                  <p>규칙에는 권한 모드가 없습니다. 같은 CLI의 요청값이나 기존 대화의 모드가 없을 때만 이 값을 씁니다. 다른 CLI의 모드는 물려받지 않습니다.</p>
                  {usedBackends.map((backend) => {
                    const agent = agentsByBackend.get(backend)
                    const current = draft.defaultModes[backend] ?? ''
                    return (
                      <label key={backend} className="distributed-work-field">
                        <span>{agent?.name ?? draft.rules.find((rule) => rule.agent.backend === backend)?.agent.label ?? backend}</span>
                        <select value={current} disabled={!editable || !agent} onChange={(event) => { setDraft({ ...draft, defaultModes: { ...draft.defaultModes, [backend]: event.target.value } }); setNotice('') }}>
                          <option value="">지정 안 함 (AionUi 기본값)</option>
                          {optionsWithCurrent(agent?.modes ?? [], current).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                        </select>
                      </label>
                    )
                  })}
                </section>

                <p className="ai-delegation-policy-meta">
                  {saved?.source === 'saved'
                    ? `마지막 저장: ${saved.updatedBy?.name ?? '알 수 없음'} · ${saved.updatedAt ? new Date(saved.updatedAt).toLocaleString('ko-KR') : '시각 없음'}`
                    : '아직 저장한 적이 없어 기본 규칙(2026-11-09 결정)을 쓰고 있습니다.'}
                  {saved && <> · 규칙 버전 <code>{saved.revision}</code></>}
                </p>
              </>
            )}
          </div>
        )}

        <footer className="distributed-work-footer">
          <div className="password-actions">
            <button type="button" onClick={requestClose}>닫기</button>
            <button type="submit" disabled={!editable || !dirty || problems.length > 0} onClick={() => void save()}>{submitting ? '저장 중…' : '저장'}</button>
          </div>
        </footer>
      </section>
    </div>
  )
}
