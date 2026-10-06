import { useEffect, useState } from 'react'
import { availableAiRuntimeOptionId } from '../utils/aiRuntimeSelections.mjs'
import type { Options, ResponseSettings, useDoorayResponses } from './useDoorayResponses'
import './DoorayResponseInbox.css'

export function DoorayResponseSettings({ response, onClose }: {
  response: ReturnType<typeof useDoorayResponses>; onClose: () => void
}) {
  const { loadSettings, requestJson, saveSettings } = response
  const [options, setOptions] = useState<Options | null>(null)
  const [draft, setDraft] = useState<ResponseSettings>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    void loadSettings().then(async (saved) => {
      const result = await requestJson<Options>(`/api/integrations/aionui/options?purpose=dooray-response${saved.machineId ? `&machineId=${encodeURIComponent(saved.machineId)}` : ''}`)
      if (!mounted) return
      setOptions(result)
      const agent = result.agents.find((entry) => entry.id === saved.agentId) ?? result.agents[0]
      if (!agent) { setError('자동 요청에 사용할 허용 모델이 없습니다. AionUi 모델 목록을 확인해 주세요.'); return }
      setDraft({ ...saved, machineId: result.machineId, agentId: agent.id,
        modelId: availableAiRuntimeOptionId(agent.models, saved.modelId, agent.defaultModelId),
        thoughtLevel: availableAiRuntimeOptionId(agent.thoughtLevels, saved.thoughtLevel, agent.defaultThoughtLevel),
        mode: availableAiRuntimeOptionId(agent.modes, saved.agentId === agent.id ? saved.mode : '', agent.defaultMode) })
    }).catch((failure: unknown) => { if (mounted) setError(failure instanceof Error ? failure.message : '제안 AI 설정을 불러오지 못했습니다.') })
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [loadSettings, requestJson])
  const agent = options?.agents.find((entry) => entry.id === draft.agentId)
  const disabled = loading || response.settingsSaving
  return <form id="dooray-response-settings" className="dooray-response-settings" aria-label="제안 AI 설정" onSubmit={(event) => {
    event.preventDefault()
    void saveSettings(draft).then((saved) => { if (saved) onClose() })
  }}>
    {loading && <p role="status">제안 AI 설정을 불러오는 중…</p>}
    {(error || response.settingsError) && <p role="alert">{error || response.settingsError}</p>}
    {agent && <>
      <label>AI 종류<select value={agent.id} disabled={disabled} onChange={(event) => {
        const next = options?.agents.find((entry) => entry.id === event.target.value)
        if (next) setDraft({ ...draft, agentId: next.id, modelId: availableAiRuntimeOptionId(next.models, '', next.defaultModelId),
          thoughtLevel: availableAiRuntimeOptionId(next.thoughtLevels, '', next.defaultThoughtLevel),
          mode: availableAiRuntimeOptionId(next.modes, '', next.defaultMode) })
      }}>{options?.agents.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      <label>AI 모델<select value={draft.modelId ?? ''} disabled={disabled} onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}>
        {agent.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <label>사고 레벨<select value={draft.thoughtLevel ?? ''} disabled={disabled || !agent.thoughtLevels.length} onChange={(event) => setDraft({ ...draft, thoughtLevel: event.target.value })}>
        {agent.thoughtLevels.length ? agent.thoughtLevels.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>) : <option value="">지원하지 않음</option>}
      </select></label>
    </>}
    <div className="dooray-response-settings-actions">
      <button type="submit" disabled={disabled || !agent}>{response.settingsSaving ? '저장 중…' : '저장'}</button>
      <button type="button" disabled={response.settingsSaving} onClick={onClose}>닫기</button>
    </div>
    <p className="dooray-response-settings-help">계정별로 저장하며 새 제안과 다시 제안받기에 적용됩니다. 진행 중인 요청은 변경하지 않습니다.</p>
  </form>
}
