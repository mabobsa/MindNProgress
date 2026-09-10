import { useCallback, useEffect, useRef, useState } from 'react'
import { getAiRuntimeSelection, normalizeAiRuntimeSelections } from '../utils/aiRuntimeSelections.mjs'

type ResponseSettings = { agentId?: string; modelId?: string; mode?: string; thoughtLevel?: string; machineId?: string }
type Option = { id: string; label: string }
type Agent = { id: string; name: string; models: Option[]; modes: Option[]; thoughtLevels: Option[]; defaultModelId: string; defaultMode: string; defaultThoughtLevel: string }
export type Options = { machineId: string; machines: { machineId: string; label: string }[]; agents: Agent[] }
export type DoorayResponseJob = {
  id: string; itemKey: string; postId: string; subject: string; sourceUrl: string; status: string; proposal: string; error: string
  createdAt: string; updatedAt: string; conversationId: string | null; homeMachineRole: 'main' | 'sub'; canRetry: boolean
  route: { action: string; mapId: string; cardId: string; documentTitle: string; cardTitle: string; reason: string; requestSummary: string } | null
}
export const doorayResponseStatus: Record<string, string> = {
  routing: '담당 탐색 중', reviewing: '담당 AI 검토 중', 'waiting-target': '담당 AI 대기 중',
  proposal: '제안 도착', 'needs-input': '추가 정보 필요', failed: '확인 필요',
}
const active = new Set(['routing', 'reviewing', 'waiting-target'])
const base = '/api/integrations/dooray/mentions/responses'

function initialSettings(userId: string): ResponseSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(`mindnprogress-dooray-response-ai:${userId}`) ?? 'null')
    if (stored && typeof stored === 'object') return stored
    const recent = normalizeAiRuntimeSelections(JSON.parse(localStorage.getItem('mindnprogress-ai-runtime-selections') ?? '{}'))
    return { agentId: recent.lastAgentId || undefined, ...getAiRuntimeSelection(recent, recent.lastAgentId) }
  } catch { return {} }
}

export function useDoorayResponses(clientId: string, userId: string) {
  const [jobs, setJobs] = useState<DoorayResponseJob[]>([])
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [open, setOpen] = useState(false)
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const [settings, setSettings] = useState<ResponseSettings>(() => initialSettings(userId))
  const controllerRef = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const pending = useRef(new Set<string>())
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
  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current = controller
    void load()
    return () => { controller.abort(); if (controllerRef.current === controller) controllerRef.current = null }
  }, [load])
  const needsRefresh = jobs.some((job) => active.has(job.status) || job.conversationId)
  useEffect(() => {
    if (!needsRefresh) return
    const timer = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(timer)
  }, [needsRefresh, load])
  const saveSettings = useCallback((next: ResponseSettings) => {
    setSettings(next)
    try { localStorage.setItem(`mindnprogress-dooray-response-ai:${userId}`, JSON.stringify(next)) } catch { /* 현재 창의 선택은 유지한다. */ }
  }, [userId])
  const request = async (itemKey: string) => {
    if (pending.current.has(itemKey)) return
    pending.current.add(itemKey)
    setPendingKeys(new Set(pending.current))
    setOpen(true)
    setError('')
    const signal = controllerRef.current?.signal
    try {
      const { job } = await requestJson<{ job: DoorayResponseJob }>(base, { method: 'POST', body: JSON.stringify({ itemKey, settings }) })
      if (signal?.aborted) return
      sequence.current++
      setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)])
      setSelectedId(job.id)
    } catch (failure) {
      if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'AI 대응 요청에 실패했습니다.')
    } finally {
      pending.current.delete(itemKey)
      if (!signal?.aborted) setPendingKeys(new Set(pending.current))
    }
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
      return true
    } catch (failure) { setError(failure instanceof Error ? failure.message : '추가 정보 전달에 실패했습니다.'); return false }
  }
  return { jobs, error, selectedId, setSelectedId, open, setOpen, pendingKeys, settings, saveSettings, request, retry, refine, load, requestJson }
}
