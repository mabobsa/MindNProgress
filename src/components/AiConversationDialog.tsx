import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { KnowledgePolicy } from '../types/mindMap'
import { AI_WORKSPACE_MAX_LENGTH } from '../utils/aiWorkspaceHistory.mjs'
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
import { WorkspaceHistoryList } from './WorkspaceHistoryList'
import { useAiDialogSections } from './useAiDialogSections'
import { useAiWorkspaceHistory } from './useAiWorkspaceHistory'
import { useAiLaunchConfirmation } from './useAiLaunchConfirmation'
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

function readMcpSelections(fallback = new Set<string>()) {
  try {
    const value = JSON.parse(localStorage.getItem(mcpSelectionsStorageKey) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set(fallback)
  }
}

export function AiConversationDialog({ userId, documentId, documentTitle, cardId, cardTitle, purpose, groupId, knowledgeSources, initialRequest, fullInitialRequest, doorayApproval, reconstructionRequestId, cardLayoutRequestId, launchInWebUi, onClose }: {
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
  cardLayoutRequestId?: string
  launchInWebUi: boolean
  onClose: () => void
}) {
  const [options, setOptions] = useState<AionOptions | null>(null)
  const [machineId, setMachineId] = useState('')
  const [loading, setLoading] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState('')
  const [launchError, setLaunchError] = useState('')
  const launchBusy = useRef(false)
  const confirmation = useAiLaunchConfirmation(JSON.stringify([userId, documentId, cardId, purpose,
    doorayApproval?.responseId, doorayApproval?.proposalRevision, doorayApproval?.handoffId,
    reconstructionRequestId, cardLayoutRequestId]), onClose)
  const dialogSections = useAiDialogSections(userId)
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
  const [workspaceSavedScope, setWorkspaceSavedScope] = useState<'document' | 'group' | null>(null)
  const [workspacePrompt, setWorkspacePrompt] = useState(false)
  const workspaceHistoryState = useAiWorkspaceHistory(userId, options?.machineId === machineId ? machineId : '')
  const { history: workspaceHistory, remember: rememberWorkspace, remove: deleteWorkspaceHistory } = workspaceHistoryState
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

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setBrowserOpen(false)
    browserRequestRef.current += 1
    setBrowserDirectory(null)
    setWorkspacePrompt(false)
    setWorkspace('')
    setWorkspaceExplicit(false)
    setWorkspaceSavedScope(null)
    const params = new URLSearchParams()
    if (machineId) params.set('machineId', machineId)
    params.set('purpose', purpose)
    params.set('mapId', documentId)
    params.set('cardId', cardId)
    const query = params.size ? `?${params}` : ''
    fetch(`/api/integrations/aionui/options${query}`, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as AionOptions & { error?: string }
        if (controller.signal.aborted) throw controller.signal.reason
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
        setWorkspaceSavedScope(null)
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
        // 현재 머신에 없는 ID도 보존한다. 표시와 실행 대상은 해당 머신의 목록에서만 고른다.
        setSelectedMcpIds(savedMcpIds)
      })
      .catch((loadError) => {
        if (controller.signal.aborted) return
        setError(loadError instanceof Error ? loadError.message : 'AionUi 옵션을 불러오지 못했습니다.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [documentId, cardId, machineId, userId, doorayApproval, purpose])

  useEffect(() => {
    if (!options || !agentId) return
    persistRuntimeSelection(agentId, { modelId, mode, thoughtLevel })
  }, [agentId, mode, modelId, options, persistRuntimeSelection, thoughtLevel])

  const selectedAgent = useMemo(() => options?.agents.find((agent) => agent.id === agentId) ?? null, [agentId, options])
  const selectedModel = selectedAgent?.models.find((model) => model.id === modelId)
  const selectedMcpServers = options?.mcpServers.filter((server) => server.required || selectedMcpIds.has(server.id)) ?? []
  const workspaceSummary = workspace.trim() || '선택 없음'
  const mcpSummary = selectedMcpServers.map((server) => server.name).join(', ') || '선택 없음'
  const skillsSummary = options?.skills.filter((skill) => selectedSkillIds.has(skill.id)).map((skill) => skill.name).join(', ') || '선택 없음'

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
    setWorkspaceSavedScope(null)
  }

  const toggleMcpSelection = (id: string) => {
    if (loading || launching || !options || options.machineId !== machineId) return
    const server = options.mcpServers.find((item) => item.id === id)
    if (!server || server.required) return
    // 옵션 로딩·머신 전환·연결 실패는 사용자 선택 변경이 아니다. 체크 조작에서만 저장한다.
    const next = readMcpSelections(selectedMcpIds)
    if (selectedMcpIds.has(id)) next.delete(id)
    else next.add(id)
    setSelectedMcpIds(next)
    try { localStorage.setItem(mcpSelectionsStorageKey, JSON.stringify([...next])) }
    catch { /* 저장소를 사용할 수 없어도 현재 대화의 선택은 유지한다. */ }
  }

  const changeMachine = (value: string) => {
    setLoading(true)
    setWorkspace('')
    setWorkspaceExplicit(false)
    setWorkspaceSavedScope(null)
    setWorkspacePrompt(false)
    setMachineId(value)
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

  const selectWorkspace = async (choice: WorkspaceChoice) => {
    if (!options || launching) throw new Error('대화 시작 옵션을 확인한 뒤 다시 선택해 주세요.')
    let settingSaved = false
    try {
      let workspaceContext = await loadWorkspaceContext(documentId, options.machineId)
      if (choice.context.machineId !== options.machineId || choice.context.token !== workspaceContext.token) {
        throw new Error('작업공간 기준이 변경되었습니다. 경로를 다시 확인하고 선택해 주세요.')
      }
      if (choice.scope !== 'once') {
        await saveWorkspaceSetting(choice)
        settingSaved = true
        workspaceContext = await loadWorkspaceContext(documentId, options.machineId)
      }
      setOptions({ ...options, workspaceContext })
      setWorkspace(choice.workspace.trim())
      setWorkspaceExplicit(true)
      setWorkspaceSavedScope(choice.scope === 'once' ? null : choice.scope)
      setLaunchError('')
      setWorkspacePrompt(false)
    } catch (reason) {
      throw new Error(`${settingSaved ? '작업공간 기준은 저장되었지만 선택한 경로를 화면에 반영하지 못했습니다. ' : ''}${reason instanceof Error ? reason.message : '작업공간을 선택하지 못했습니다.'}`)
    }
  }

  const launch = async () => {
    if (!options || !selectedAgent || !modelId || !role || loading || error || launching || launchBusy.current || confirmation.pending) return
    if (!workspace.trim() || (!workspaceExplicit && (!options.workspaceContext || options.workspaceContext.needsSelection))) {
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
    launchBusy.current = true
    setLaunching(true)
    setLaunchError('')
    try {
      const workspaceContext = await loadWorkspaceContext(documentId, options.machineId)
      if (options.workspaceContext?.token !== workspaceContext.token) {
        setOptions({ ...options, workspaceContext }); setWorkspace(workspaceContext.workspace); setWorkspaceExplicit(false)
        setWorkspaceSavedScope(null)
        throw new Error('문서·그룹의 작업공간 기준이 변경되었습니다. 갱신된 경로를 확인한 뒤 다시 시작해 주세요.')
      }
      const launchWorkspace = workspace.trim()
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
          cardLayoutRequestId,
          mode: mode || undefined,
          thoughtLevel: thoughtLevel || undefined,
          enabledSkillIds,
          disabledBuiltinSkillIds,
          mcpIds,
          workspace: launchWorkspace,
          workspaceToken: workspaceContext.token,
          workspaceConfirmed: workspaceExplicit,
          requestPreview: userRequest.trim() || automaticRequest,
        }),
      })
      const attribution = await attributionResponse.json().catch(() => ({})) as { attributionToken?: string; completionUrl?: string; statusUrl?: string; editorId?: string; workspace?: string; error?: string; approvalRequest?: string }
      if (!attributionResponse.ok || !attribution.attributionToken || !attribution.completionUrl || !attribution.editorId) {
        throw new Error(attribution.error ?? 'AI 작성자 정보를 준비하지 못했습니다.')
      }
      if (doorayApproval && !attribution.approvalRequest) throw new Error('서버에서 승인 전문을 확인하지 못했습니다. 대화를 시작하지 않았습니다.')
      if (!attribution.statusUrl) throw new Error('서버가 대화 생성 확인을 지원하지 않습니다. MnP 서버를 업데이트해 주세요. 대화를 시작하지 않았습니다.')
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
      confirmation.begin(attribution.statusUrl, useWebLaunch)
      const launchResponse = await fetch('/api/integrations/aionui/external-conversation-launches', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(launchPayload),
        signal: AbortSignal.timeout(30_000),
      })
      const launchResult = await launchResponse.json().catch(() => ({})) as { launchUrl?: string; desktopLaunchUrl?: string; error?: string }
      const launchUrl = useWebLaunch ? launchResult.launchUrl : launchResult.desktopLaunchUrl
      if (!launchResponse.ok || !launchUrl) {
        throw new Error(launchResult.error ?? 'AionUi 대화 시작 정보를 확인하지 못했습니다. 상태 확인 후 기존 시작 정보를 사용해 주세요.')
      }
      if (useWebLaunch) {
        if (!launchTab || launchTab.closed) {
          launchTab = null
          throw new Error('준비 중이던 AionUi 탭이 닫혔습니다. 아래에서 같은 시작 정보를 다시 열어 주세요.')
        }
        launchTab.location.href = launchUrl
        launchTab.focus()
        launchTab = null
      } else {
        window.location.href = launchUrl
      }
      void rememberWorkspace(attribution.workspace ?? launchWorkspace)
      setWorkspacePrompt(false)
    } catch (launchFailure) {
      if (launchTab && !launchTab.closed) launchTab.close()
      const message = launchFailure instanceof Error ? launchFailure.message : 'AI 대화를 시작하지 못했습니다.'
      setLaunchError(message)
    } finally {
      launchBusy.current = false
      setLaunching(false)
    }
  }

  return (<>
    <div className="ai-dialog-backdrop" onPointerDown={(event) => { if (!launching && event.target === event.currentTarget) onClose() }}>
      <section className="ai-dialog" role="dialog" aria-modal="true" aria-label="AI 대화 시작 옵션">
        <header>
          <div><span>AionUi 연동</span><strong>AI 대화 시작</strong><small>{cardTitle}</small></div>
          <button type="button" onClick={onClose} disabled={launching} aria-label="AI 대화 옵션 닫기">×</button>
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
                <select value={options.machineId} disabled={launching} onChange={(event) => changeMachine(event.target.value)}>
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
          <fieldset className="ai-dialog-options" disabled={launching || Boolean(confirmation.pending)} aria-label="대화 실행 옵션">
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
                <select value={options.machineId} disabled={launching} onChange={(event) => changeMachine(event.target.value)}>
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
            <details className="ai-workspace-section" open={dialogSections.sections.workspace}>
              <summary onClick={(event) => { event.preventDefault(); dialogSections.toggle('workspace') }}>
                <span className="ai-section-label">작업공간</span>
                {!dialogSections.sections.workspace && <span className="ai-section-selection" title={workspaceSummary}>{workspaceSummary}</span>}
              </summary>
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
              <small>{workspaceSavedScope ? `${workspaceSavedScope === 'document' ? '문서' : '그룹'} 작업공간 기준에 저장한 경로 · 이번 대화에서 사용합니다.` : workspaceExplicit ? '이번 대화에서 선택한 경로 · 문서/그룹 기준은 변경하지 않습니다.' : options.workspaceContext?.source === 'document' ? '문서 작업공간 기준' : options.workspaceContext?.source === 'group' ? `${options.workspaceContext.groupName} 그룹 작업공간 기준` : '기준 미설정 · AionUi에서 시작을 누르면 선택할 수 있습니다.'}</small>
              {options.workspaceContext?.error && <small role="alert">{options.workspaceContext.error}</small>}
              {workspaceHistoryState.error && <small role="status">{workspaceHistoryState.error}</small>}
              <button type="button" className="ai-workspace-browse ai-workspace-settings-button" disabled={launching} onClick={() => setWorkspacePrompt(true)}>작업공간 확인·설정…</button>
              {doorayApproval && Boolean(options.workspaceChoices?.length) && <WorkspaceHistoryList heading="문서·등록 작업공간" workspaces={options.workspaceChoices ?? []} workspace={workspace} onSelect={updateWorkspace} disabled={launching} />}
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
              </div>
            </details>
            <details className="ai-mcp-section" open={dialogSections.sections.mcp}>
              <summary onClick={(event) => { event.preventDefault(); dialogSections.toggle('mcp') }}>
                <span className="ai-section-label">MCP 도구</span><b>{selectedMcpServers.length}</b>
                {!dialogSections.sections.mcp && <span className="ai-section-selection" title={mcpSummary}>{mcpSummary}</span>}
              </summary>
              <div className="ai-capability-list ai-mcp-capability-list" aria-label="사용할 MCP 도구 선택">
                {options.mcpServers.map((server) => (
                  <label key={server.id} title={server.description}>
                    <input type="checkbox" checked={server.required || selectedMcpIds.has(server.id)} disabled={server.required || launching} onChange={() => toggleMcpSelection(server.id)} />
                    <span>
                      <strong>{server.name}{server.required ? ' · 필수' : ''}</strong>
                      <small>{server.toolCount > 0 ? `${server.toolCount}개 도구` : server.description || '도구 정보 없음'}</small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
            <details className="ai-skills-section" open={dialogSections.sections.skills}>
              <summary onClick={(event) => { event.preventDefault(); dialogSections.toggle('skills') }}>
                <span className="ai-section-label">스킬</span><b>{selectedSkillIds.size}</b>
                {!dialogSections.sections.skills && <span className="ai-section-selection" title={skillsSummary}>{skillsSummary}</span>}
              </summary>
              <div className="ai-capability-list">{options.skills.map((skill) => <label key={skill.id} title={skill.description}><input type="checkbox" checked={selectedSkillIds.has(skill.id)} onChange={() => toggleSelection(setSelectedSkillIds, skill.id)} /><span><strong>{skill.name}</strong><small>{skill.description || '설명 없음'}</small></span></label>)}</div>
            </details>
            {dialogSections.error && <div className="ai-section-preferences-error" role="alert"><span>{dialogSections.error}</span><button type="button" onClick={dialogSections.retry}>다시 시도</button></div>}
          </fieldset>
          </div>
        )}
        {(launchError || confirmation.error) && <div className="ai-launch-error" role="alert">{confirmation.error || launchError}</div>}
        {confirmation.pending && <div className="ai-launch-confirmation" role="status">
          <strong>대화 생성 확인 중…</strong>
          <span>AionUi에서 실제 대화가 생성·연결되면 자동으로 닫힙니다. 지연되면 AionUi 실행·로그인 상태와 대화 목록을 확인하세요. 새 대화를 자동으로 재요청하지 않습니다.</span>
          <div><button type="button" onClick={confirmation.check}>상태 다시 확인</button>{confirmation.canReopen && <button type="button" onClick={confirmation.reopen} disabled={launching}>같은 시작 정보로 AionUi 다시 열기</button>}{confirmation.canReset && <button type="button" disabled={launching} onClick={() => { if (confirmation.reset()) setLaunchError('') }}>대화 목록 확인 후 새로 준비</button>}</div>
        </div>}
        <footer><span>응답은 {options?.machineLabel ?? '선택한 머신'}의 AionUi에서만 처리됩니다.</span><div><button type="button" onClick={onClose} disabled={launching}>{confirmation.pending ? '닫기' : '취소'}</button><button type="button" className="primary" onClick={() => { void launch() }} disabled={roleLoading || Boolean(roleError) || loading || launching || Boolean(confirmation.pending) || Boolean(error) || !selectedAgent || !modelId}>{launching ? '준비 중…' : confirmation.pending ? '대화 생성 확인 중…' : 'AionUi에서 시작'}</button></div></footer>
      </section>
    </div>
    {workspacePrompt && <WorkspaceSettingsDialog key={`${userId}:${options?.machineId}`} userId={userId} mapId={documentId} machineId={options?.machineId} name={documentTitle || cardTitle} initialWorkspace={workspace} workspaceHistory={workspaceHistory} onRemoveWorkspaceHistory={deleteWorkspaceHistory} onConfirm={selectWorkspace} onClose={() => setWorkspacePrompt(false)} />}
    </>
  )
}
