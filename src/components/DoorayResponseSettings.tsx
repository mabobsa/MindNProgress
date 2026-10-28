import { useEffect, useRef, useState } from 'react'
import { availableAiRuntimeOptionId } from '../utils/aiRuntimeSelections.mjs'
import { claudeAccountMark, resolveDialogClaudeAccountId } from '../utils/claudeAccounts.mjs'
import type { Options, ResponseSettings, useDoorayResponses } from './useDoorayResponses'
import './DoorayResponseInbox.css'

export function DoorayResponseSettings({ response, onClose, onConfirm }: {
  response: ReturnType<typeof useDoorayResponses>; onClose: () => void
  onConfirm?: (settings: ResponseSettings) => Promise<boolean>
}) {
  const { loadSettings, requestJson, saveSettings } = response
  const [options, setOptions] = useState<Options | null>(null)
  const [draft, setDraft] = useState<ResponseSettings>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  useEffect(() => {
    let mounted = true
    void loadSettings().then(async (saved) => {
      const result = await requestJson<Options>(`/api/integrations/aionui/options?purpose=dooray-response${saved.machineId ? `&machineId=${encodeURIComponent(saved.machineId)}` : ''}`)
      if (!mounted) return
      setOptions(result)
      const agent = result.agents.find((entry) => entry.id === saved.agentId) ?? result.agents[0]
      if (!agent) { setError('자동 요청에 사용할 허용 모델이 없습니다. AionUi 모델 목록을 확인해 주세요.'); return }
      setDraft({ ...saved, machineId: result.machineId, agentId: agent.id,
        pushMachineId: saved.pushMachineId || (result.pushMachines?.length === 1 ? result.pushMachines[0].machineId : ''),
        modelId: availableAiRuntimeOptionId(agent.models, saved.modelId, agent.defaultModelId),
        thoughtLevel: availableAiRuntimeOptionId(agent.thoughtLevels, saved.thoughtLevel, agent.defaultThoughtLevel),
        mode: availableAiRuntimeOptionId(agent.modes, saved.agentId === agent.id ? saved.mode : '', agent.defaultMode) })
    }).catch((failure: unknown) => { if (mounted) setError(failure instanceof Error ? failure.message : '제안 AI 설정을 불러오지 못했습니다.') })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [loadSettings, requestJson])
  const agent = options?.agents.find((entry) => entry.id === draft.agentId)
  // Claude 멀티 계정: 계정이 1개면 claudeAccounts가 없어 설정에 계정을 넣지 않는다.
  const claudeAccountId = resolveDialogClaudeAccountId(agent?.claudeAccounts, draft.claudeAccountId, options?.claudeAccountPolicy?.others)
  const disabled = loading || response.settingsSaving || submitting
  const canSubmit = !disabled && !error && agent?.models.some((model) => model.id === draft.modelId)
    && (!draft.pushEnabled || options?.pushMachines?.some(machine => machine.machineId === draft.pushMachineId))
  const submit = async () => {
    if (!canSubmit || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    const { claudeAccountId: _previous, ...rest } = draft
    const settings = claudeAccountId ? { ...rest, claudeAccountId } : rest
    try {
      if (await (onConfirm ? onConfirm(settings) : saveSettings(settings))) onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '제안 AI 설정을 적용하지 못했습니다.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  return <form id="dooray-response-settings" className="dooray-response-settings" aria-label="제안 AI 설정" onSubmit={(event) => {
    event.preventDefault()
    void submit()
  }}>
    {loading && <p role="status">제안 AI 설정을 불러오는 중…</p>}
    {(error || response.settingsError) && <p role="alert">{error || response.settingsError}</p>}
    {agent && <>
      <label>AI 종류<select autoFocus={Boolean(onConfirm)} value={agent.id} disabled={disabled} onChange={(event) => {
        const next = options?.agents.find((entry) => entry.id === event.target.value)
        if (next) setDraft({ ...draft, agentId: next.id, modelId: availableAiRuntimeOptionId(next.models, '', next.defaultModelId),
          thoughtLevel: availableAiRuntimeOptionId(next.thoughtLevels, '', next.defaultThoughtLevel),
          mode: availableAiRuntimeOptionId(next.modes, '', next.defaultMode) })
      }}>{options?.agents.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      {agent.claudeAccounts && <label>Claude 계정<select value={claudeAccountId} disabled={disabled} onChange={(event) => setDraft({ ...draft, claudeAccountId: event.target.value })}>
        {agent.claudeAccounts.map((entry) => <option key={entry.id} value={entry.id}>{`${claudeAccountMark(entry.number)} ${entry.label}`}</option>)}
      </select></label>}
      <label>AI 모델<select value={draft.modelId ?? ''} disabled={disabled} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}>
        {agent.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <label>사고 레벨<select value={draft.thoughtLevel ?? ''} disabled={disabled || !agent.thoughtLevels.length} onChange={(event) => setDraft({ ...draft, thoughtLevel: event.target.value })}>
        {agent.thoughtLevels.length ? agent.thoughtLevels.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>) : <option value="">지원하지 않음</option>}
      </select></label>
    </>}
    {agent && <fieldset className="dooray-response-push-settings" disabled={disabled}>
      <legend>휴대폰 알림</legend>
      <label className="dooray-response-push-toggle"><input type="checkbox" checked={draft.pushEnabled === true}
        onChange={event => setDraft({ ...draft, pushEnabled: event.target.checked })} />추가 정보 필요·승인 대기 시 푸시 받기</label>
      {draft.pushEnabled && <label>휴대폰이 연결된 PC<select aria-label="휴대폰이 연결된 PC" value={draft.pushMachineId ?? ''}
        onChange={event => setDraft({ ...draft, pushMachineId: event.target.value })}>
        <option value="">PC 선택</option>
        {options?.pushMachines?.map(machine => <option key={machine.machineId} value={machine.machineId}>{machine.label}</option>)}
      </select></label>}
      <p className="dooray-response-settings-help">선택한 PC의 AionUi에서 ‘휴대폰 푸시 사용’과 ‘MnP 알림 받기’를 켜 주세요. AI 실행 머신과 달라도 됩니다.</p>
    </fieldset>}
    <div className="dooray-response-settings-actions">
      <button type="submit" disabled={!canSubmit}>{onConfirm ? (submitting ? '요청 준비 중…' : '확인하고 제안받기') : (submitting ? '저장 중…' : '저장')}</button>
      <button type="button" disabled={response.settingsSaving || submitting} onClick={onClose}>{onConfirm ? '취소' : '닫기'}</button>
    </div>
    <p className="dooray-response-settings-help">계정별로 저장하며 새 제안과 다시 제안받기에 적용됩니다. 진행 중인 요청은 변경하지 않습니다.</p>
  </form>
}
