import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { KnowledgePolicy } from '../types/mindMap'
import {
  AI_WORKSPACE_MAX_LENGTH,
  normalizeAiWorkspaceHistory,
  rememberAiWorkspace,
  removeAiWorkspace,
} from '../utils/aiWorkspaceHistory.mjs'
import {
  availableAiRuntimeOptionId,
  getAiRuntimeSelection,
  normalizeAiRuntimeSelections,
  rememberAiRuntimeSelection,
} from '../utils/aiRuntimeSelections.mjs'
import {
  AI_EDITOR_REQUEST_MAX_LENGTH,
  aiConversationTitle,
  buildAiConversationPrompt,
  combineAiEditorRequest,
  type AiConversationPurpose,
  type DoorayApprovalLaunch,
} from '../utils/aiConversationLaunch.mjs'
import { loadAiConversationRole, type AiConversationRole } from '../utils/aiConversationRole.mjs'
import './AiConversationDialog.css'
import { WorkspaceSettingsDialog } from './WorkspaceSettingsDialog'
import { loadWorkspaceContext, saveWorkspaceSetting, type WorkspaceContext, type WorkspaceChoice } from '../utils/workspaceSettings'

type RuntimeOption = { id: string; label: string; description: string; providerId?: string }
type AionAgent = {
  id: string
  name: string
  icon: string | null
  backend: string
  status: string
  models: RuntimeOption[]
  defaultModelId: string
  modes: RuntimeOption[]
  defaultMode: string
  thoughtLevels: RuntimeOption[]
  defaultThoughtLevel: string
}
type AionSkill = { id: string; name: string; description: string; autoInject: boolean }
type AionMcpServer = { id: string; name: string; description: string; toolCount: number; required: boolean }
type AionMachine = { machineId: string; label: string; role: 'main' | 'sub'; online?: boolean | null }
type AionOptions = {
  connected: boolean
  machineId: string
  machineLabel: string
  machineRole: 'main' | 'sub'
  machines: AionMachine[]
  protocol: string
  defaultWorkspace: string
  workspaceContext?: WorkspaceContext
  workspaceChoices?: string[]
  workspaceNeedsSelection?: boolean
  workspaceBrowseAvailable: boolean
  agents: AionAgent[]
  skills: AionSkill[]
  mcpServers: AionMcpServer[]
}
const runtimeSelectionsStorageKey = 'mindnprogress-ai-runtime-selections'
const mcpSelectionsStorageKey = 'mindnprogress-ai-mcp-selections'
const legacyWorkspaceHistoryStorageKey = 'mindnprogress-ai-workspace-history-v1'
const workspaceHistoryApiPath = '/api/integrations/aionui/workspaces'
const workspaceBrowseApiPath = '/api/integrations/aionui/directories'

type WorkspaceDirectoryEntry = { name: string; path: string; git: boolean }
type WorkspaceDirectory = {
  path: string
  parent: string | null
  git?: boolean
  entries: WorkspaceDirectoryEntry[]
  truncated: boolean
}

async function requestWorkspaceDirectory(directoryPath: string) {
  const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : ''
  const response = await fetch(`${workspaceBrowseApiPath}${query}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(10_000),
  })
  const result = await response.json().catch(() => ({})) as Partial<WorkspaceDirectory> & { error?: string }
  if (!response.ok) throw new Error(result.error ?? '폴더 목록을 불러오지 못했습니다.')
  return {
    path: String(result.path ?? ''),
    parent: typeof result.parent === 'string' ? result.parent : null,
    git: result.git === true,
    entries: Array.isArray(result.entries) ? result.entries : [],
    truncated: result.truncated === true,
  } satisfies WorkspaceDirectory
}

function workspaceHistoryStorageKey(userId: string, machineId = '') {
  return `mindnprogress-ai-workspace-history-v2:${userId}${machineId ? `:${machineId}` : ''}`
}

function readRuntimeSelections() {
  try {
    return normalizeAiRuntimeSelections(JSON.parse(localStorage.getItem(runtimeSelectionsStorageKey) ?? '{}'))
  } catch {
    return normalizeAiRuntimeSelections({})
  }
}

function storeRuntimeSelections(value: ReturnType<typeof normalizeAiRuntimeSelections>) {
  try {
    localStorage.setItem(runtimeSelectionsStorageKey, JSON.stringify(value))
  } catch {
    // 브라우저 저장소를 사용할 수 없어도 현재 대화 옵션은 계속 사용합니다.
  }
}

function readMcpSelections() {
  try {
    const value = JSON.parse(localStorage.getItem(mcpSelectionsStorageKey) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

function readWorkspaceHistory(userId: string, machineId = '') {
  try {
    const stored = localStorage.getItem(workspaceHistoryStorageKey(userId, machineId))
      ?? (machineId ? null : localStorage.getItem(legacyWorkspaceHistoryStorageKey))
      ?? '[]'
    return normalizeAiWorkspaceHistory(JSON.parse(stored))
  } catch {
    return []
  }
}

function readLegacyWorkspaceHistory() {
  try {
    return normalizeAiWorkspaceHistory(JSON.parse(localStorage.getItem(legacyWorkspaceHistoryStorageKey) ?? '[]'))
  } catch {
    return []
  }
}

function storeWorkspaceHistory(userId: string, history: string[], machineId = '') {
  try {
    localStorage.setItem(workspaceHistoryStorageKey(userId, machineId), JSON.stringify(history))
  } catch {
    // 브라우저 저장소를 사용할 수 없어도 현재 대화는 시작할 수 있습니다.
  }
}

function clearLegacyWorkspaceHistory() {
  try {
    localStorage.removeItem(legacyWorkspaceHistoryStorageKey)
  } catch {
    // 사용자별 서버 이력이 저장되었으므로 기존 공용 캐시 정리는 생략해도 됩니다.
  }
}

async function requestWorkspaceHistory(method: 'GET' | 'POST' | 'DELETE', body?: object) {
  const response = await fetch(workspaceHistoryApiPath, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    keepalive: true,
    signal: AbortSignal.timeout(5_000),
  })
  const result = await response.json().catch(() => ({})) as { workspaces?: unknown; error?: string }
  if (!response.ok) throw new Error(result.error ?? '최근 작업공간을 동기화하지 못했습니다.')
  return normalizeAiWorkspaceHistory(result.workspaces)
}

function encodeBase64Json(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function AiConversationDialog({ userId, documentId, documentTitle, cardId, cardTitle, purpose, groupId, knowledgeSources, initialRequest, fullInitialRequest, doorayApproval, reconstructionRequestId, launchInWebUi, onClose }: {
  userId: string
  documentId: string
  documentTitle: string
  cardId: string
  cardTitle: string
  purpose: AiConversationPurpose
  groupId?: string
  knowledgeSources: { id: string; label: string; policy: KnowledgePolicy }[]
  initialRequest?: string
  fullInitialRequest?: boolean
  doorayApproval?: DoorayApprovalLaunch
  reconstructionRequestId?: string
  launchInWebUi: boolean
  onClose: () => void
}) {
  const [options, setOptions] = useState<AionOptions | null>(null)
  const [machineId, setMachineId] = useState('')
  const [loading, setLoading] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState('')
  const [launchError, setLaunchError] = useState('')
  const roleInput = useMemo(() => ({ mapId: documentId, cardId, purpose, groupId, initialRequest, fullInitialRequest }), [documentId, cardId, purpose, groupId, initialRequest, fullInitialRequest])
  const [roleResult, setRoleResult] = useState<{ input: typeof roleInput; role?: AiConversationRole; error?: string } | null>(null)
  const role = roleResult?.input === roleInput ? roleResult.role : undefined
  const roleError = roleResult?.input === roleInput ? roleResult.error : undefined
  const roleLoading = !role && !roleError
  const automaticRequest = role?.automaticRequest ?? ''
  const [userRequest, setUserRequest] = useState('')
  const [agentId, setAgentId] = useState('')
  const [modelId, setModelId] = useState('')
  const [mode, setMode] = useState('')
  const [thoughtLevel, setThoughtLevel] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [workspaceExplicit, setWorkspaceExplicit] = useState(false)
  const [workspacePrompt, setWorkspacePrompt] = useState(false)
  const [workspaceHistory, setWorkspaceHistory] = useState(() => readWorkspaceHistory(userId))
  const workspaceHistoryRef = useRef(workspaceHistory)
  const workspaceHistoryMutationRef = useRef(0)
  const workspaceHistoryRequestRef = useRef<Promise<void>>(Promise.resolve())
  const runtimeSelectionsRef = useRef(readRuntimeSelections())
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserDirectory, setBrowserDirectory] = useState<WorkspaceDirectory | null>(null)
  const [browserLoading, setBrowserLoading] = useState(false)
  const [browserError, setBrowserError] = useState('')
  const browserRequestRef = useRef(0)
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const controller = new AbortController()
    void loadAiConversationRole(roleInput, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then((value) => { if (!controller.signal.aborted) setRoleResult({ input: roleInput, role: value }) })
      .catch((reason) => {
        if (!controller.signal.aborted) setRoleResult({ input: roleInput, error: reason instanceof Error ? reason.message : '대화 역할을 확인하지 못했습니다.' })
      })
    return () => controller.abort()
  }, [roleInput])

  const persistRuntimeSelection = useCallback((nextAgentId: string, selection: { modelId: string; mode: string; thoughtLevel: string }) => {
    const next = rememberAiRuntimeSelection(runtimeSelectionsRef.current, nextAgentId, selection)
    runtimeSelectionsRef.current = next
    storeRuntimeSelections(next)
  }, [])

  const applyWorkspaceHistory = useCallback((history: string[]) => {
    workspaceHistoryRef.current = history
    storeWorkspaceHistory(userId, history, machineId)
    setWorkspaceHistory(history)
  }, [machineId, userId])

  const enqueueWorkspaceHistoryRequest = useCallback((requestAction: () => Promise<string[]>) => {
    const operation = workspaceHistoryRequestRef.current.then(requestAction, requestAction)
    workspaceHistoryRequestRef.current = operation.then(() => undefined, () => undefined)
    return operation
  }, [])

  useEffect(() => {
    if (!options) return
    if (options.machineRole === 'sub') {
      applyWorkspaceHistory(readWorkspaceHistory(userId, options.machineId))
      return
    }
    let active = true
    const legacyHistory = readLegacyWorkspaceHistory()
    const mutationVersion = workspaceHistoryMutationRef.current
    const operation = enqueueWorkspaceHistoryRequest(async () => {
      const serverHistory = await requestWorkspaceHistory('GET')
      if (legacyHistory.length === 0) return serverHistory
      return requestWorkspaceHistory('POST', { migration: true, workspaces: legacyHistory })
    })
    void operation.then((history) => {
      clearLegacyWorkspaceHistory()
      if (active && workspaceHistoryMutationRef.current === mutationVersion) applyWorkspaceHistory(history)
    }).catch(() => {
      // 서버가 일시적으로 응답하지 않으면 사용자별 브라우저 캐시를 계속 사용합니다.
    })
    return () => { active = false }
  }, [applyWorkspaceHistory, enqueueWorkspaceHistoryRequest, options, userId])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setBrowserOpen(false)
    const params = new URLSearchParams()
    if (machineId) params.set('machineId', machineId)
    params.set('purpose', purpose)
    params.set('mapId', documentId)
    params.set('cardId', cardId)
    const query = params.size ? `?${params}` : ''
    fetch(`/api/integrations/aionui/options${query}`, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as AionOptions & { error?: string }
        if (!response.ok) {
          if (body.machineId && Array.isArray(body.machines)) {
            setOptions(body)
            if (body.machineId !== machineId) setMachineId(body.machineId)
          }
          throw new Error(body.error ?? 'AionUi 옵션을 불러오지 못했습니다.')
        }
        return body
      })
      .then((body) => {
        if (controller.signal.aborted) return
        setOptions(body)
        if (body.machineId !== machineId) setMachineId(body.machineId)
        setWorkspace(body.workspaceContext?.workspace ?? '')
        setWorkspaceExplicit(false)
        const savedSelections = runtimeSelectionsRef.current
        const savedMcpIds = readMcpSelections()
        const initialAgent = body.agents.find((agent) => agent.id === savedSelections.lastAgentId && agent.models.length > 0)
          ?? body.agents.find((agent) => agent.models.length > 0)
          ?? body.agents[0]
        if (initialAgent) {
          const savedAgentSelection = getAiRuntimeSelection(savedSelections, initialAgent.id)
          setAgentId(initialAgent.id)
          setModelId(availableAiRuntimeOptionId(initialAgent.models, savedAgentSelection.modelId, initialAgent.defaultModelId))
          setMode(availableAiRuntimeOptionId(initialAgent.modes, savedAgentSelection.mode, initialAgent.defaultMode))
          setThoughtLevel(availableAiRuntimeOptionId(initialAgent.thoughtLevels, savedAgentSelection.thoughtLevel, initialAgent.defaultThoughtLevel))
        }
        setSelectedSkillIds(new Set())
        setSelectedMcpIds(new Set(body.mcpServers.filter((server) => server.required || savedMcpIds.has(server.id)).map((server) => server.id)))
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        setError(loadError instanceof Error ? loadError.message : 'AionUi 옵션을 불러오지 못했습니다.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [documentId, cardId, machineId, userId, doorayApproval, purpose])

  useEffect(() => {
    if (!options || !agentId) return
    persistRuntimeSelection(agentId, { modelId, mode, thoughtLevel })
  }, [agentId, mode, modelId, options, persistRuntimeSelection, thoughtLevel])

  useEffect(() => {
    if (!options) return
    const selectedIds = options.mcpServers
      .filter((server) => !server.required && selectedMcpIds.has(server.id))
      .map((server) => server.id)
    localStorage.setItem(mcpSelectionsStorageKey, JSON.stringify(selectedIds))
  }, [options, selectedMcpIds])

  const selectedAgent = useMemo(() => options?.agents.find((agent) => agent.id === agentId) ?? null, [agentId, options])
  const selectedModel = selectedAgent?.models.find((model) => model.id === modelId)

  const changeAgent = (nextAgentId: string) => {
    persistRuntimeSelection(agentId, { modelId, mode, thoughtLevel })
    setAgentId(nextAgentId)
    const nextAgent = options?.agents.find((agent) => agent.id === nextAgentId)
    const savedAgentSelection = getAiRuntimeSelection(runtimeSelectionsRef.current, nextAgentId)
    setModelId(nextAgent ? availableAiRuntimeOptionId(nextAgent.models, savedAgentSelection.modelId, nextAgent.defaultModelId) : '')
    setMode(nextAgent ? availableAiRuntimeOptionId(nextAgent.modes, savedAgentSelection.mode, nextAgent.defaultMode) : '')
    setThoughtLevel(nextAgent ? availableAiRuntimeOptionId(nextAgent.thoughtLevels, savedAgentSelection.thoughtLevel, nextAgent.defaultThoughtLevel) : '')
  }

  const toggleSelection = (setter: Dispatch<SetStateAction<Set<string>>>, id: string) => {
    setter((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const updateWorkspace = (value: string) => {
    setWorkspace(value)
    setWorkspaceExplicit(true)
  }

  const openWorkspaceBrowser = useCallback((directoryPath: string) => {
    setBrowserOpen(true)
    setBrowserError('')
    setBrowserLoading(true)
    const requestVersion = ++browserRequestRef.current
    void requestWorkspaceDirectory(directoryPath)
      .then((directory) => {
        if (browserRequestRef.current === requestVersion) setBrowserDirectory(directory)
      })
      .catch((requestError) => {
        if (browserRequestRef.current !== requestVersion) return
        setBrowserError(requestError instanceof Error ? requestError.message : '폴더 목록을 불러오지 못했습니다.')
        // 입력한 경로가 없을 수도 있으므로 드라이브 목록으로 물러날 수 있게 현재 위치는 비운다.
        setBrowserDirectory(null)
      })
      .finally(() => {
        if (browserRequestRef.current === requestVersion) setBrowserLoading(false)
      })
  }, [])

  const rememberWorkspace = async (value: string) => {
    const normalizedWorkspace = value.trim()
    if (!normalizedWorkspace) return
    const next = rememberAiWorkspace(workspaceHistoryRef.current, normalizedWorkspace)
    const mutationVersion = ++workspaceHistoryMutationRef.current
    applyWorkspaceHistory(next)
    try {
      if (options?.machineRole === 'sub') return
      const history = await enqueueWorkspaceHistoryRequest(() => requestWorkspaceHistory('POST', { workspace: normalizedWorkspace }))
      if (workspaceHistoryMutationRef.current === mutationVersion) applyWorkspaceHistory(history)
    } catch {
      // 대화 시작은 서버 이력 저장 실패로 막지 않고 브라우저 캐시로 보완합니다.
    }
  }

  const deleteWorkspaceHistory = async (value: string) => {
    const previous = workspaceHistoryRef.current
    const next = removeAiWorkspace(workspaceHistoryRef.current, value)
    const mutationVersion = ++workspaceHistoryMutationRef.current
    applyWorkspaceHistory(next)
    try {
      if (options?.machineRole === 'sub') return
      const history = await enqueueWorkspaceHistoryRequest(() => requestWorkspaceHistory('DELETE', { workspace: value }))
      if (workspaceHistoryMutationRef.current === mutationVersion) applyWorkspaceHistory(history)
    } catch {
      if (workspaceHistoryMutationRef.current === mutationVersion) applyWorkspaceHistory(previous)
    }
  }

  const launch = async (choice?: WorkspaceChoice) => {
    if (!options || !selectedAgent || !modelId || !role || loading || error || launching) return
    if (!choice && (!workspace.trim() || (!workspaceExplicit && (!options.workspaceContext || options.workspaceContext.needsSelection)))) {
      setWorkspacePrompt(true)
      return
    }
    const request = combineAiEditorRequest(automaticRequest, userRequest, role.fullInitialRequest)
    if (!request) return
    const useWebLaunch = launchInWebUi || options.machineRole === 'sub'
    let launchTab: Window | null = null
    if (useWebLaunch) {
      launchTab = window.open('about:blank', '_blank')
      if (!launchTab) {
        setLaunchError('AionUi 대화 탭을 열지 못했습니다. 브라우저의 팝업 차단을 해제한 뒤 다시 시도해 주세요.')
        return
      }
      try {
        launchTab.document.title = 'AionUi 대화 준비 중'
        launchTab.document.body.textContent = 'AionUi 대화를 준비하는 중…'
        launchTab.document.body.style.cssText = 'margin:0;display:grid;place-items:center;min-height:100vh;font:14px system-ui;color:#666;background:#f7f7f8'
        launchTab.opener = null
      } catch {
        // 빈 탭 상태 안내를 만들 수 없어도 ticket 발급과 이동은 계속합니다.
      }
    }
    setLaunching(true)
    setLaunchError('')
    let settingSaved = false
    try {
      let workspaceContext = await loadWorkspaceContext(documentId, options.machineId)
      if (choice && choice.context.token !== workspaceContext.token) throw new Error('작업공간 기준이 변경되었습니다. 선택 창을 닫고 다시 확인해 주세요.')
      if (!choice && options.workspaceContext?.token !== workspaceContext.token) {
        setOptions({ ...options, workspaceContext }); setWorkspace(workspaceContext.workspace); setWorkspaceExplicit(false)
        throw new Error('문서·그룹의 작업공간 기준이 변경되었습니다. 갱신된 경로를 확인한 뒤 다시 시작해 주세요.')
      }
      if (choice && choice.scope !== 'once') {
        await saveWorkspaceSetting(choice)
        settingSaved = true
        workspaceContext = await loadWorkspaceContext(documentId, options.machineId)
        setOptions({ ...options, workspaceContext })
      }
      const launchWorkspace = choice?.workspace ?? workspace.trim()
      const latestRole = await loadAiConversationRole(roleInput, { signal: AbortSignal.timeout(10_000) })
      if (latestRole.purpose !== role.purpose || latestRole.groupId !== role.groupId || latestRole.automaticRequest !== role.automaticRequest) {
        setRoleResult({ input: roleInput, role: latestRole })
        throw new Error('문서의 그룹 역할이 변경되었습니다. 갱신된 자동 적용 내용을 확인한 뒤 다시 시작해 주세요. AI 대화는 시작하지 않았습니다.')
      }
      const enabledSkillIds = options.skills.filter((skill) => !skill.autoInject && selectedSkillIds.has(skill.id)).map((skill) => skill.id)
      const disabledBuiltinSkillIds = options.skills.filter((skill) => skill.autoInject && !selectedSkillIds.has(skill.id)).map((skill) => skill.id)
      const mcpIds = options.mcpServers.filter((server) => server.required || selectedMcpIds.has(server.id)).map((server) => server.id)
      const attributionResponse = await fetch('/api/integrations/aionui/attributions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: selectedAgent.id,
          modelId,
          providerId: selectedModel?.providerId,
          mapId: documentId,
          cardId,
          machineId: options.machineId,
          purpose: role.purpose,
          doorayApproval,
          reconstructionRequestId,
          mode: mode || undefined,
          thoughtLevel: thoughtLevel || undefined,
          enabledSkillIds,
          disabledBuiltinSkillIds,
          mcpIds,
          workspace: launchWorkspace,
          workspaceToken: workspaceContext.token,
          workspaceConfirmed: Boolean(choice) || workspaceExplicit,
          requestPreview: userRequest.trim() || automaticRequest,
        }),
      })
      const attribution = await attributionResponse.json().catch(() => ({})) as { attributionToken?: string; completionUrl?: string; editorId?: string; workspace?: string; error?: string; approvalRequest?: string }
      if (!attributionResponse.ok || !attribution.attributionToken || !attribution.completionUrl || !attribution.editorId) {
        throw new Error(attribution.error ?? 'AI 작성자 정보를 준비하지 못했습니다.')
      }
      if (doorayApproval && !attribution.approvalRequest) throw new Error('서버에서 승인 전문을 확인하지 못했습니다. 대화를 시작하지 않았습니다.')
      const prompt = buildAiConversationPrompt({
        purpose: role.purpose, doorayApproval,
        mapId: documentId,
        cardId,
        editorId: attribution.editorId,
        attributionToken: attribution.attributionToken,
        request: doorayApproval ? combineAiEditorRequest(attribution.approvalRequest, userRequest, true) : request,
      })
      const launchPayload = {
        agentId: selectedAgent.id,
        completionUrl: attribution.completionUrl,
        title: aiConversationTitle({ purpose: role.purpose, documentTitle, cardTitle }),
        prompt,
        modelId,
        providerId: selectedModel?.providerId,
        mode: mode || undefined,
        thoughtLevel: thoughtLevel || undefined,
        enabledSkillIds,
        disabledBuiltinSkillIds,
        mcpIds,
        workspace: attribution.workspace ?? launchWorkspace,
        autoSend: true,
      }
      if (useWebLaunch) {
        const launchResponse = await fetch('/api/integrations/aionui/external-conversation-launches', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(launchPayload),
        })
        const launchResult = await launchResponse.json().catch(() => ({})) as { launchUrl?: string; error?: string }
        if (!launchResponse.ok || !launchResult.launchUrl) {
          throw new Error(launchResult.error ?? 'AionUi WebUI 대화 시작 정보를 발급하지 못했습니다.')
        }
        if (!launchTab || launchTab.closed) {
          launchTab = null
          throw new Error('준비 중이던 AionUi 탭이 닫혔습니다. 다시 시도해 주세요.')
        }
        launchTab.location.href = launchResult.launchUrl
        launchTab.focus()
        launchTab = null
      } else {
        const data = encodeURIComponent(encodeBase64Json({ payload: JSON.stringify(launchPayload) }))
        window.location.href = `${options.protocol}?v=1&data=${data}`
      }
      void rememberWorkspace(attribution.workspace ?? launchWorkspace)
      setWorkspacePrompt(false)
      onClose()
    } catch (launchFailure) {
      if (launchTab && !launchTab.closed) launchTab.close()
      const message = `${settingSaved ? '작업공간 기준은 저장되었지만 대화 시작은 완료되지 않았습니다. ' : ''}${launchFailure instanceof Error ? launchFailure.message : 'AI 대화를 시작하지 못했습니다.'}`
      setLaunchError(message)
      if (choice) throw new Error(message)
    } finally {
      setLaunching(false)
    }
  }

  return (<>
    <div className="ai-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="ai-dialog" role="dialog" aria-modal="true" aria-label="AI 대화 시작 옵션">
        <header>
          <div><span>AionUi 연동</span><strong>AI 대화 시작</strong><small>{cardTitle}</small></div>
          <button type="button" onClick={onClose} aria-label="AI 대화 옵션 닫기">×</button>
        </header>
        {doorayApproval && <p className="ai-dialog-message">{documentId && cardId ? `시작 카드: ${documentTitle} → ${cardTitle}` : '담당 카드 미지정: 승인된 문서 구성만 진행하며, 하위 작업은 생성된 문서의 상위 카드 대화로 인계해야 합니다.'}<br />승인한 제안을 새 대화에 전달합니다. 사용할 작업공간을 확인하세요. 취소하면 대화를 시작하지 않습니다.</p>}
        {roleLoading ? <div className="ai-dialog-message" role="status">문서의 대화 역할과 자동 적용 내용을 확인하는 중…</div> : roleError ? (
          <div className="ai-dialog-message error" role="alert"><strong>대화 역할을 확인할 수 없습니다.</strong><span>{roleError}</span><small>일반 카드용 요청으로 대신 시작하지 않았습니다. 팝업을 닫고 다시 열어 주세요.</small></div>
        ) : loading ? <div className="ai-dialog-message">AionUi의 새 채팅 옵션을 불러오는 중…</div> : error ? (
          <div className="ai-dialog-message error">
            <strong>연결할 수 없습니다.</strong><span>{error}</span><small>AionUi를 실행하거나 다른 실행 머신을 선택해 주세요.</small>
            {options && options.machines.length > 1 && (
              <label>
                <span>실행 머신</span>
                <select value={options.machineId} onChange={(event) => setMachineId(event.target.value)}>
                  {options.machines.map((machine) => (
                    <option key={machine.machineId} value={machine.machineId}>
                      {machine.label}{machine.role === 'main' ? ' · 메인' : machine.online === false ? ' · Runner 끊김' : ' · 서브'}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : options && (
          <div className="ai-dialog-content">
            {knowledgeSources.length > 0 && (
              <div className="ai-knowledge-notice">
                <strong>선행 지식 {knowledgeSources.length}개를 먼저 사용합니다.</strong>
                <span>{knowledgeSources.map((source) => `${source.label} · ${source.policy === 'reuse-first' ? '주요 지식' : '부족할 때 확인'}`).join(' / ')}</span>
                <small>최상위 업무와 원본 자료는 선행 지식만으로 부족할 때만 선택적으로 확인합니다.</small>
              </div>
            )}
            <div className="ai-knowledge-notice ai-machine-notice">
              <label className="ai-machine-select">
                <span>실행 머신</span>
                <select value={options.machineId} onChange={(event) => setMachineId(event.target.value)}>
                  {options.machines.map((machine) => (
                    <option key={machine.machineId} value={machine.machineId}>
                      {machine.label}{machine.role === 'main' ? ' · 메인' : machine.online === false ? ' · Runner 끊김' : ' · 서브'}
                    </option>
                  ))}
                </select>
              </label>
              <span>이 대화와 이후 조회·재개는 {options.machineLabel}에 고정됩니다.</span>
              {options.machineRole === 'sub' && <small>서브 머신 대화 창은 해당 장비에서 이 화면을 열었을 때 로컬 AionUi로 연결됩니다.</small>}
            </div>
            <label className="ai-request ai-user-request">
              <span>추가 정보 또는 요청</span>
              <textarea
                value={userRequest}
                onChange={(event) => setUserRequest(event.target.value)}
                rows={4}
                maxLength={AI_EDITOR_REQUEST_MAX_LENGTH}
                placeholder="추가 정보, 정정 사항 또는 요청할 작업을 입력하세요."
                autoFocus
              />
              <small>비워 두면 아래 자동 적용 내용만 전달됩니다.</small>
            </label>
            <label className="ai-request ai-auto-request">
              <span>자동 적용 내용</span>
              <textarea value={automaticRequest} rows={7} readOnly aria-readonly="true" />
              <small>MindNProgress가 대화 목적에 맞춰 자동으로 전달하며 편집할 수 없습니다.</small>
            </label>
            <div className="ai-dialog-grid">
              <label><span>AI 종류</span><select value={agentId} onChange={(event) => changeAgent(event.target.value)}>{options.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
              <label><span>모델</span><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{selectedAgent?.models.map((model) => <option key={`${model.providerId ?? ''}-${model.id}`} value={model.id}>{model.label}</option>)}</select></label>
              {selectedAgent && selectedAgent.modes.length > 0 && <label><span>권한</span><select value={mode} onChange={(event) => setMode(event.target.value)}>{selectedAgent.modes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
              {selectedAgent && selectedAgent.thoughtLevels.length > 0 && <label><span>사고 수준</span><select value={thoughtLevel} onChange={(event) => setThoughtLevel(event.target.value)}>{selectedAgent.thoughtLevels.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
            </div>
            <div className="ai-workspace-field">
              <label className="ai-workspace-input">
                <span>작업공간</span>
                <div className="ai-workspace-input-row">
                  <input value={workspace} onChange={(event) => updateWorkspace(event.target.value)} placeholder={doorayApproval ? '업무 작업공간 필수' : '선택사항'} maxLength={AI_WORKSPACE_MAX_LENGTH} />
                  <button
                    type="button"
                    className="ai-workspace-browse"
                    disabled={!options.workspaceBrowseAvailable}
                    title={options.workspaceBrowseAvailable ? '서버 머신의 폴더 탐색' : '이 실행 머신의 경로를 직접 입력해 주세요.'}
                    onClick={() => {
                      if (browserOpen) {
                        setBrowserOpen(false)
                        return
                      }
                      openWorkspaceBrowser(workspace.trim())
                    }}
                    aria-expanded={browserOpen}
                  >
                    {browserOpen ? '닫기' : '탐색…'}
                  </button>
                </div>
              </label>
              <small>{workspaceExplicit ? '이번 대화에서 선택한 경로 · 문서/그룹 기준은 변경하지 않습니다.' : options.workspaceContext?.source === 'document' ? '문서 작업공간 기준' : options.workspaceContext?.source === 'group' ? `${options.workspaceContext.groupName} 그룹 작업공간 기준` : '기준 미설정 · AionUi에서 시작을 누르면 선택할 수 있습니다.'}</small>
              {options.workspaceContext?.error && <small role="alert">{options.workspaceContext.error}</small>}
              <button type="button" className="ai-workspace-browse" disabled={launching} onClick={() => setWorkspacePrompt(true)}>작업공간 확인·설정…</button>
              {doorayApproval && Boolean(options.workspaceChoices?.length) && <div className="ai-workspace-history">
                <div className="ai-workspace-history-heading"><span>문서·등록 작업공간</span></div>
                <div className="ai-workspace-history-list">{options.workspaceChoices?.map((item) => <div className={`ai-workspace-history-item ${workspace.trim() === item ? 'selected' : ''}`} key={item}>
                  <button type="button" className="ai-workspace-history-select" title={item} onClick={() => updateWorkspace(item)}><span>{item}</span></button>
                </div>)}</div>
              </div>}
              {browserOpen && (
                <div className="ai-workspace-browser">
                  <div className="ai-workspace-browser-bar">
                    <button
                      type="button"
                      className="ai-workspace-browser-up"
                      onClick={() => openWorkspaceBrowser(browserDirectory?.parent ?? '')}
                      disabled={browserLoading || browserDirectory?.parent === null}
                      title="상위 폴더"
                    >
                      ↑
                    </button>
                    <span className="ai-workspace-browser-path" title={browserDirectory?.path || '드라이브 목록'}>
                      {browserDirectory?.path || '드라이브 목록'}
                    </span>
                    {browserDirectory?.git && <span className="ai-workspace-browser-git">Git</span>}
                  </div>
                  {browserError && <p className="ai-workspace-browser-error" role="alert">{browserError}</p>}
                  <div className="ai-workspace-browser-list" role="list">
                    {browserLoading && <p className="ai-workspace-browser-empty">불러오는 중…</p>}
                    {!browserLoading && !browserError && browserDirectory?.entries.length === 0 && (
                      <p className="ai-workspace-browser-empty">하위 폴더가 없습니다.</p>
                    )}
                    {!browserLoading && browserDirectory?.entries.map((entry) => (
                      <button
                        type="button"
                        role="listitem"
                        key={entry.path}
                        className={`ai-workspace-browser-entry ${workspace.trim() === entry.path ? 'selected' : ''}`}
                        onClick={() => openWorkspaceBrowser(entry.path)}
                        onDoubleClick={() => updateWorkspace(entry.path)}
                        title={entry.path}
                      >
                        <span>{entry.name}</span>
                        {entry.git && <b>Git</b>}
                      </button>
                    ))}
                  </div>
                  {browserDirectory?.truncated && (
                    <p className="ai-workspace-browser-empty">폴더가 많아 일부만 표시했습니다. 경로를 직접 입력해 주세요.</p>
                  )}
                  <div className="ai-workspace-browser-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        updateWorkspace(browserDirectory?.path ?? '')
                        setBrowserOpen(false)
                      }}
                      disabled={!browserDirectory?.path}
                    >
                      이 폴더 사용
                    </button>
                  </div>
                </div>
              )}
              {workspaceHistory.length > 0 && (
                <div className="ai-workspace-history">
                  <div className="ai-workspace-history-heading"><span>최근 작업공간</span><small>{workspaceHistory.length}개</small></div>
                  <div className="ai-workspace-history-list" role="list" aria-label="최근 작업공간">
                    {workspaceHistory.map((item) => (
                      <div className={`ai-workspace-history-item ${workspace.trim() === item ? 'selected' : ''}`} role="listitem" key={item}>
                        <button type="button" className="ai-workspace-history-select" onClick={() => updateWorkspace(item)} title={item}>
                          <span>{item}</span>
                        </button>
                        <button type="button" className="ai-workspace-history-remove" onClick={() => { void deleteWorkspaceHistory(item) }} aria-label={`${item} 이력 삭제`} title="이력에서 삭제">×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <details open>
              <summary>MCP 도구 <b>{options.mcpServers.filter((server) => server.required || selectedMcpIds.has(server.id)).length}</b></summary>
              <div className="ai-capability-list ai-mcp-capability-list" aria-label="사용할 MCP 도구 선택">
                {options.mcpServers.map((server) => (
                  <label key={server.id} title={server.description}>
                    <input type="checkbox" checked={server.required || selectedMcpIds.has(server.id)} disabled={server.required} onChange={() => toggleSelection(setSelectedMcpIds, server.id)} />
                    <span>
                      <strong>{server.name}{server.required ? ' · 필수' : ''}</strong>
                      <small>{server.toolCount > 0 ? `${server.toolCount}개 도구` : server.description || '도구 정보 없음'}</small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
            <details open>
              <summary>스킬 <b>{selectedSkillIds.size}</b></summary>
              <div className="ai-capability-list">{options.skills.map((skill) => <label key={skill.id} title={skill.description}><input type="checkbox" checked={selectedSkillIds.has(skill.id)} onChange={() => toggleSelection(setSelectedSkillIds, skill.id)} /><span><strong>{skill.name}</strong><small>{skill.description || '설명 없음'}</small></span></label>)}</div>
            </details>
            {launchError && <div className="ai-launch-error" role="alert">{launchError}</div>}
          </div>
        )}
        <footer><span>응답은 {options?.machineLabel ?? '선택한 머신'}의 AionUi에서만 처리됩니다.</span><div><button type="button" onClick={onClose}>취소</button><button type="button" className="primary" onClick={() => { void launch() }} disabled={roleLoading || Boolean(roleError) || loading || launching || Boolean(error) || !selectedAgent || !modelId}>{launching ? '준비 중…' : 'AionUi에서 시작'}</button></div></footer>
      </section>
    </div>
    {workspacePrompt && <WorkspaceSettingsDialog mapId={documentId} machineId={options?.machineId} name={documentTitle || cardTitle} initialWorkspace={workspace} onConfirm={launch} onClose={() => setWorkspacePrompt(false)} />}
    </>
  )
}
