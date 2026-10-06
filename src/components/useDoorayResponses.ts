import { useCallback, useEffect, useRef, useState } from 'react'
import type { DoorayHandoffLaunch } from './DoorayResponseHandoff'

export type DoorayDecision = { kind: 'input' | 'approval' | 'proposal'; reason: string; questions: string[];
  approval: { title: string; scope: string[]; exclusions: string[] } | null }
type DoorayApproval = { revision: string; approvedAt: string; approvedBy: { id: string; name: string }; proposal: string;
  title: string; scope: string[]; exclusions: string[];
  conversation?: { conversationId: string; homeMachineRole: 'main' | 'sub'; linkedAt: string };
  handoffs?: { id: string; target: { mapId: string; cardId: string; documentTitle: string; cardTitle: string };
    conversation?: { conversationId: string; homeMachineRole: 'main' | 'sub'; linkedAt: string } }[] }

export type ResponseSettings = { agentId?: string; modelId?: string; mode?: string; thoughtLevel?: string; machineId?: string; proposalWorkspace?: string }
type Option = { id: string; label: string }
type Agent = { id: string; name: string; models: Option[]; modes: Option[]; thoughtLevels: Option[]; defaultModelId: string; defaultMode: string; defaultThoughtLevel: string }
export type Options = { machineId: string; machineRole?: 'main' | 'sub'; machines: { machineId: string; label: string }[]; agents: Agent[] }
export type DoorayResponseJob = {
  id: string; itemKey: string; postId: string; subject: string; sourceUrl: string; status: string; proposal: string; error: string
  createdAt: string; updatedAt: string; conversationId: string | null; homeMachineRole: 'main' | 'sub'; canRetry: boolean
  recoveringAfterRestart?: boolean
  canRecoverResult?: boolean; proposalSource?: 'router' | 'review' | null
  settings?: ResponseSettings; modelPolicy?: { changed: boolean; previousModelId: string | null; message: string } | null
  routingWarning?: { code: string; conversationId: string; message: string } | null
  completedAt?: string | null; archiveStatus?: 'pending' | 'done' | 'warning' | null; archiveError?: string
  decision?: DoorayDecision | null; proposalRevision?: string; approval?: DoorayApproval | null; approvalHistory?: DoorayApproval[]
  route: { action: string; mapId: string; cardId: string; documentTitle: string; cardTitle: string; reason: string; requestSummary: string } | null
}
export const doorayResponseStatus: Record<string, string> = {
  routing: '담당 탐색 중', reviewing: '담당 AI 검토 중', 'waiting-target': '담당 AI 대기 중',
  proposal: '제안 도착', 'needs-input': '추가 정보 필요', failed: '확인 필요', completed: '대응 완료',
  'needs-approval': '승인 대기', approved: '승인 완료',
}
const active = new Set(['routing', 'reviewing', 'waiting-target'])
const base = '/api/integrations/dooray/mentions/responses'
const settingsEndpoint = '/api/integrations/dooray/mentions/response-settings'

function legacySettings(userId: string): ResponseSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(`mindnprogress-dooray-response-ai:${userId}`) ?? 'null')
    if (stored && typeof stored === 'object') return stored
  } catch { return {} }
  return {}
}

export function useDoorayResponses(clientId: string, userId: string) {
  const [jobs, setJobs] = useState<DoorayResponseJob[]>([])
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [open, setOpen] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  const [notice, setNotice] = useState('')
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<ResponseSettings>({})
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const pending = useRef(new Set<string>())
  const settingsSequence = useRef(0)
  const requestJson = useCallback(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(url, { ...init, credentials: 'include', signal: controllerRef.current?.signal,
      headers: { 'Content-Type': 'application/json', 'X-MindNProgress-Client': clientId, ...init.headers } })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'AI 대응 정보를 불러오지 못했습니다.')
    return body as T
  }, [clientId])
  const load = useCallback(async () => {
    const signal = controllerRef.current?.signal
    const current = ++sequence.current
    try {
      const body = await requestJson<{ jobs: DoorayResponseJob[] }>(base)
      if (!signal?.aborted && current === sequence.current) { setJobs(body.jobs); setError('') }
    } catch (failure) {
      if (!signal?.aborted && current === sequence.current) setError(failure instanceof Error ? failure.message : 'AI 대응 조회에 실패했습니다.')
    }
  }, [requestJson])
  const cacheSettings = useCallback((next: ResponseSettings) => {
    setSettings(next)
    try { localStorage.setItem(`mindnprogress-dooray-response-ai:${userId}`, JSON.stringify(next)) } catch { /* 서버의 계정 설정이 원본이다. */ }
  }, [userId])
  const loadSettings = useCallback(async (): Promise<ResponseSettings> => {
    const signal = controllerRef.current?.signal
    const current = ++settingsSequence.current
    setSettingsLoading(true)
    try {
      let migrationError = ''
      let result = await requestJson<{ userId: string; settings: ResponseSettings | null }>(settingsEndpoint)
      if (result.userId !== userId) throw new Error('로그인 계정이 변경되었습니다. 다시 열어 설정해 주세요.')
      if (!result.settings) {
        const legacy = legacySettings(userId)
        if (legacy.agentId && legacy.modelId) {
          try {
            result = await requestJson<{ userId: string; settings: ResponseSettings }>(settingsEndpoint, {
              method: 'PUT', body: JSON.stringify({ expectedUserId: userId, settings: legacy, onlyIfUnset: true }),
            })
          } catch {
            // 삭제된 AI 등 오래된 브라우저 설정 때문에 새 종류·모델 선택까지 막지 않는다.
            migrationError = '이전 설정을 가져오지 못했습니다. 제안 AI 설정에서 다시 선택해 주세요.'
          }
        }
      }
      if (result.userId !== userId) throw new Error('로그인 계정이 변경되었습니다. 다시 열어 설정해 주세요.')
      const next = result.settings ?? {}
      if (!signal?.aborted && current === settingsSequence.current) { cacheSettings(next); setSettingsError(migrationError) }
      return next
    } catch (failure) {
      if (!signal?.aborted && current === settingsSequence.current) setSettingsError(failure instanceof Error ? failure.message : '제안 AI 설정을 불러오지 못했습니다.')
      throw failure
    } finally { if (!signal?.aborted && current === settingsSequence.current) setSettingsLoading(false) }
  }, [cacheSettings, requestJson, userId])
  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    setSettings({})
    setJobs([])
    setSelectedId('')
    void load()
    void loadSettings().catch(() => {})
    return () => { controller.abort(); if (controllerRef.current === controller) controllerRef.current = null }
  }, [load, loadSettings])
  const needsRefresh = jobs.some((job) => (!job.completedAt && (active.has(job.status) || job.conversationId))
    || job.approval?.handoffs?.some((entry) => !entry.conversation))
  useEffect(() => {
    if (!needsRefresh) return
    const timer = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(timer)
  }, [needsRefresh, load])
  const saveSettings = useCallback(async (next: ResponseSettings): Promise<boolean> => {
    const signal = controllerRef.current?.signal
    const current = ++settingsSequence.current
    setSettingsSaving(true)
    try {
      const result = await requestJson<{ userId: string; settings: ResponseSettings }>(settingsEndpoint, {
        method: 'PUT', body: JSON.stringify({ expectedUserId: userId, settings: next }),
      })
      if (result.userId !== userId) throw new Error('로그인 계정이 변경되었습니다. 다시 열어 설정해 주세요.')
      if (signal?.aborted || current !== settingsSequence.current) return false
      cacheSettings(result.settings)
      setSettingsError('')
      return true
    } catch (failure) {
      if (!signal?.aborted && current === settingsSequence.current) setSettingsError(failure instanceof Error ? failure.message : '제안 AI 설정을 저장하지 못했습니다.')
      return false
    } finally { if (!signal?.aborted) { setSettingsSaving(false); if (current === settingsSequence.current) setSettingsLoading(false) } }
  }, [cacheSettings, requestJson, userId])
  const request = async (itemKey: string) => {
    if (pending.current.has(itemKey)) return
    // 상태가 표시된 버튼은 기록을 여는 동작이다. 재제안은 refine에서만 요청한다.
    const previous = jobs.find((job) => job.itemKey === itemKey)
    if (previous) {
      setSelectedId(previous.id)
      setShowCompleted(Boolean(previous.completedAt))
      setOpen(true)
      setError('')
      setNotice('')
      return
    }
    pending.current.add(itemKey)
    setPendingKeys(new Set(pending.current))
    setOpen(true)
    setError('')
    const signal = controllerRef.current?.signal
    try {
      const { job } = await requestJson<{ job: DoorayResponseJob }>(base, { method: 'POST', body: JSON.stringify({ itemKey }) })
      if (signal?.aborted) return
      sequence.current++
      setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)])
      setSelectedId(job.id)
      setShowCompleted(Boolean(job.completedAt))
      void loadSettings().catch(() => {})
      setNotice('')
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'AI 대응 요청에 실패했습니다.')
    } finally {
      pending.current.delete(itemKey)
      if (!signal?.aborted) setPendingKeys(new Set(pending.current))
    }
  }
  const recoverResult = async (job: DoorayResponseJob) => {
    try {
      await requestJson(`${base}/${encodeURIComponent(job.id)}/recover-result`, {
        method: 'POST', body: JSON.stringify({ expectedUpdatedAt: job.updatedAt }),
      })
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '완료 답변 복구에 실패했습니다.') }
  }
  const retry = async (id: string) => {
    try { await requestJson(`${base}/${encodeURIComponent(id)}/retry`, { method: 'POST' }); await load() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '상태 확인에 실패했습니다.') }
  }
  const refine = async (id: string, hint: string) => {
    try {
      const { job } = await requestJson<{ job: DoorayResponseJob }>(`${base}/${encodeURIComponent(id)}/refine`, { method: 'POST', body: JSON.stringify({ hint }) })
      sequence.current++
      setJobs((current) => current.map((entry) => entry.id === id ? job : entry))
      setError('')
      void loadSettings().catch(() => {})
      setNotice('')
      return true
    } catch (failure) { setError(failure instanceof Error ? failure.message : '추가 정보 전달에 실패했습니다.'); return false }
  }
  const complete = async (id: string) => {
    const signal = controllerRef.current?.signal
    sequence.current++
    try {
      const { job } = await requestJson<{ job: DoorayResponseJob }>(`${base}/${encodeURIComponent(id)}/complete`, { method: 'POST' })
      if (signal?.aborted) return
      sequence.current++
      setJobs((current) => current.map((entry) => entry.id === id ? job : entry))
      setError('')
      setNotice(job.archiveStatus === 'warning' ? '대응은 완료했습니다. 완료 내역에서 대화 보관 상태를 확인해 주세요.' : '대응을 완료 내역으로 옮겼습니다. 제안과 완료 기록은 대화를 삭제해도 보존됩니다.')
      setSelectedId('')
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : '완료 처리에 실패했습니다.') }
  }
  const approve = async (job: DoorayResponseJob): Promise<DoorayHandoffLaunch | null> => {
    const signal = controllerRef.current?.signal
    try {
      const result = await requestJson<{ job: DoorayResponseJob }>(`${base}/${encodeURIComponent(job.id)}/approve`, {
        method: 'POST', body: JSON.stringify({ proposalRevision: job.proposalRevision }),
      })
      if (signal?.aborted) return null
      sequence.current++
      setJobs((current) => current.map((entry) => entry.id === job.id ? result.job : entry))
      const { launch } = await requestJson<{ launch: DoorayHandoffLaunch }>(`/api/integrations/dooray/response-approvals/${encodeURIComponent(job.id)}?revision=${encodeURIComponent(job.proposalRevision ?? '')}`)
      if (signal?.aborted) return null
      setError(''); setNotice('')
      return launch
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : '승인 정보를 확인하지 못했습니다.'); return null }
  }
  return { jobs, error, notice, selectedId, setSelectedId, open, setOpen, showCompleted, setShowCompleted, pendingKeys,
    settings, settingsLoading, settingsSaving, settingsError, loadSettings, saveSettings, request, retry, recoverResult, refine, complete, approve, load, requestJson }
}
export const doorayResponseStatusLabel = (job: Pick<DoorayResponseJob, 'status' | 'recoveringAfterRestart'>) =>
  job.recoveringAfterRestart ? '재시작 후 제안 복구 중' : doorayResponseStatus[job.status] ?? job.status
