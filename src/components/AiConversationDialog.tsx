import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import './AiConversationDialog.css'

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
type AionOptions = {
  connected: boolean
  protocol: string
  agents: AionAgent[]
  skills: AionSkill[]
  mcpServers: AionMcpServer[]
}

const defaultWorkspace = 'C:\\Git\\MindNProgress'

function workspaceStorageKey(documentId: string) {
  return `mindnprogress-ai-workspace:${documentId}`
}

function encodeBase64Json(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function AiConversationDialog({ documentId, documentTitle, cardId, cardTitle, onClose }: {
  documentId: string
  documentTitle: string
  cardId: string
  cardTitle: string
  onClose: () => void
}) {
  const [options, setOptions] = useState<AionOptions | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [request, setRequest] = useState('이 카드의 내용을 검토하고 다음에 수행할 작업을 제안해 주세요.')
  const [agentId, setAgentId] = useState('')
  const [modelId, setModelId] = useState('')
  const [mode, setMode] = useState('')
  const [thoughtLevel, setThoughtLevel] = useState('')
  const [workspace, setWorkspace] = useState(() => localStorage.getItem(workspaceStorageKey(documentId)) ?? defaultWorkspace)
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/integrations/aionui/options', { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as AionOptions & { error?: string }
        if (!response.ok) throw new Error(body.error ?? 'AionUi 옵션을 불러오지 못했습니다.')
        return body
      })
      .then((body) => {
        setOptions(body)
        const initialAgent = body.agents.find((agent) => agent.models.length > 0) ?? body.agents[0]
        if (initialAgent) {
          setAgentId(initialAgent.id)
          setModelId(initialAgent.defaultModelId || initialAgent.models[0]?.id || '')
          setMode(initialAgent.defaultMode || initialAgent.modes[0]?.id || '')
          setThoughtLevel(initialAgent.defaultThoughtLevel || initialAgent.thoughtLevels[0]?.id || '')
        }
        setSelectedSkillIds(new Set(body.skills
          .filter((skill) => skill.id === 'officecli' || skill.name === 'officecli')
          .map((skill) => skill.id)))
        setSelectedMcpIds(new Set(body.mcpServers.filter((server) => server.required).map((server) => server.id)))
      })
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        setError(loadError instanceof Error ? loadError.message : 'AionUi 옵션을 불러오지 못했습니다.')
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

  const selectedAgent = useMemo(() => options?.agents.find((agent) => agent.id === agentId) ?? null, [agentId, options])
  const selectedModel = selectedAgent?.models.find((model) => model.id === modelId)

  const changeAgent = (nextAgentId: string) => {
    setAgentId(nextAgentId)
    const nextAgent = options?.agents.find((agent) => agent.id === nextAgentId)
    setModelId(nextAgent?.defaultModelId || nextAgent?.models[0]?.id || '')
    setMode(nextAgent?.defaultMode || nextAgent?.modes[0]?.id || '')
    setThoughtLevel(nextAgent?.defaultThoughtLevel || nextAgent?.thoughtLevels[0]?.id || '')
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
    localStorage.setItem(workspaceStorageKey(documentId), value)
  }

  const launch = () => {
    if (!options || !selectedAgent || !modelId || !request.trim()) return
    const prompt = `# MindNProgress 작업 요청\n\n가장 먼저 MindNProgress MCP 도구 \`mindnprogress_get_context\`를 아래 ID로 한 번 호출하세요. 이 도구가 MindNProgress의 제품 개념과 작성 규칙, 최신 문서 구조, 선택 카드 정보를 함께 제공합니다. 프롬프트에는 카드 스냅샷이 포함되어 있지 않으므로 반드시 MCP 조회 결과를 기준으로 답변하고 필요한 작업을 수행해야 합니다.\n\n- documentId: \`${documentId}\`\n- cardId: \`${cardId}\`\n\nMCP 조회 후 \`selection.taskLinks.startupInspection\`을 반드시 확인하세요. \`required\`가 true이면 실제 작업을 시작하기 전에 \`targets\`의 업무 링크를 모두 조사하여 업무 제목, 본문, 댓글, 첨부파일 목록과 관련 링크를 확인하세요. 상위 업무에 기획서나 첨부파일이 있다고 가정하지 말고, 본문이나 댓글에 요구사항만 간략하게 작성되어 있을 가능성도 고려해야 합니다. 선택 카드와 최상위 카드 링크가 모두 있으면 두 업무를 모두 조사하고 같은 URL은 한 번만 조회하세요. 조사 가능한 업무 링크를 확인하기 전에 사용자에게 파일 경로나 추가 설명을 먼저 요청하지 마세요. 업무 링크가 없거나 외부 업무 시스템을 조회할 도구가 없으면 그 사실을 알리고, 확인된 MindNProgress 카드 정보만으로 가능한 작업은 계속 진행하세요.\n\nMCP 도구를 사용할 수 없거나 해당 문서 또는 카드를 찾지 못하면 임의로 추측하지 말고 그 사실을 알려주세요. 새 문서에 여러 카드로 구성된 마인드맵을 만들 때는 \`mindnprogress_create_document\`와 \`mindnprogress_save_document\`를 연속 호출하지 말고, \`mindnprogress_create_mindmap\`을 한 번만 호출하세요.\n\n# 편집자 요청\n\n${request.trim()}`
    const launchPayload = {
      agentId: selectedAgent.id,
      title: `${documentTitle}: ${cardTitle}`.replace(/\s+/g, ' ').trim().slice(0, 120),
      prompt,
      modelId,
      providerId: selectedModel?.providerId,
      mode: mode || undefined,
      thoughtLevel: thoughtLevel || undefined,
      enabledSkillIds: options.skills.filter((skill) => !skill.autoInject && selectedSkillIds.has(skill.id)).map((skill) => skill.id),
      disabledBuiltinSkillIds: options.skills.filter((skill) => skill.autoInject && !selectedSkillIds.has(skill.id)).map((skill) => skill.id),
      mcpIds: options.mcpServers.filter((server) => server.required || selectedMcpIds.has(server.id)).map((server) => server.id),
      workspace: workspace.trim() || undefined,
      autoSend: true,
    }
    const data = encodeURIComponent(encodeBase64Json({ payload: JSON.stringify(launchPayload) }))
    window.location.href = `${options.protocol}?v=1&data=${data}`
    onClose()
  }

  return (
    <div className="ai-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="ai-dialog" role="dialog" aria-modal="true" aria-label="AI 대화 시작 옵션">
        <header>
          <div><span>AionUi 연동</span><strong>AI 대화 시작</strong><small>{cardTitle}</small></div>
          <button type="button" onClick={onClose} aria-label="AI 대화 옵션 닫기">×</button>
        </header>
        {loading ? <div className="ai-dialog-message">AionUi의 새 채팅 옵션을 불러오는 중…</div> : error ? (
          <div className="ai-dialog-message error"><strong>연결할 수 없습니다.</strong><span>{error}</span><small>AionUi를 실행한 뒤 다시 시도해 주세요.</small></div>
        ) : options && (
          <div className="ai-dialog-content">
            <label className="ai-request"><span>AI에게 요청할 내용</span><textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={4} maxLength={4000} autoFocus /></label>
            <div className="ai-dialog-grid">
              <label><span>AI 종류</span><select value={agentId} onChange={(event) => changeAgent(event.target.value)}>{options.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
              <label><span>모델</span><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{selectedAgent?.models.map((model) => <option key={`${model.providerId ?? ''}-${model.id}`} value={model.id}>{model.label}</option>)}</select></label>
              {selectedAgent && selectedAgent.modes.length > 0 && <label><span>권한</span><select value={mode} onChange={(event) => setMode(event.target.value)}>{selectedAgent.modes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
              {selectedAgent && selectedAgent.thoughtLevels.length > 0 && <label><span>사고 수준</span><select value={thoughtLevel} onChange={(event) => setThoughtLevel(event.target.value)}>{selectedAgent.thoughtLevels.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
            </div>
            <label><span>작업공간</span><input value={workspace} onChange={(event) => updateWorkspace(event.target.value)} placeholder="선택사항" /></label>
            <details open>
              <summary>스킬 <b>{selectedSkillIds.size}</b></summary>
              <div className="ai-capability-list">{options.skills.map((skill) => <label key={skill.id} title={skill.description}><input type="checkbox" checked={selectedSkillIds.has(skill.id)} onChange={() => toggleSelection(setSelectedSkillIds, skill.id)} /><span><strong>{skill.name}</strong><small>{skill.description || '설명 없음'}</small></span></label>)}</div>
            </details>
            <details open>
              <summary>MCP 도구 <b>{options.mcpServers.filter((server) => server.required || selectedMcpIds.has(server.id)).length}</b></summary>
              <div className="ai-capability-list">{options.mcpServers.map((server) => <label key={server.id} title={server.description}><input type="checkbox" checked={server.required || selectedMcpIds.has(server.id)} disabled={server.required} onChange={() => toggleSelection(setSelectedMcpIds, server.id)} /><span><strong>{server.name}{server.required ? ' · 필수' : ''}</strong><small>{server.toolCount > 0 ? `${server.toolCount}개 도구` : server.description || '도구 정보 없음'}</small></span></label>)}</div>
            </details>
          </div>
        )}
        <footer><span>응답은 AionUi에서만 처리됩니다.</span><div><button type="button" onClick={onClose}>취소</button><button type="button" className="primary" onClick={launch} disabled={loading || Boolean(error) || !selectedAgent || !modelId || !request.trim()}>AionUi에서 시작</button></div></footer>
      </section>
    </div>
  )
}
