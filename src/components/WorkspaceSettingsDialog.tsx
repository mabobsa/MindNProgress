import { useEffect, useRef, useState } from 'react'
import './WorkspaceSettingsDialog.css'

import { jsonRequest, loadWorkspaceContext, saveWorkspaceSetting, type WorkspaceContext, type WorkspaceChoice } from '../utils/workspaceSettings'
export function WorkspaceSettingsDialog({ mapId = '', groupId = '', machineId = '', name, editScope, initialWorkspace = '',
  onRename, onConfirm, onClose }: {
  mapId?: string; groupId?: string; machineId?: string; name: string; editScope?: 'document' | 'group'; initialWorkspace?: string
  onRename?: (name: string) => Promise<void>; onConfirm?: (choice: WorkspaceChoice) => Promise<void>; onClose: () => void
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const [title, setTitle] = useState(name)
  const [machine, setMachine] = useState(machineId)
  const [context, setContext] = useState<WorkspaceContext | null>(null)
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [scope, setScope] = useState<WorkspaceChoice['scope']>(editScope ?? 'once')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [savedNotice, setSavedNotice] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [directory, setDirectory] = useState<{ path: string; parent: string | null; entries: { name: string; path: string }[] } | null>(null)
  useEffect(() => {
    let active = true
    setContext(null); setDirectory(null); setError('')
    void loadWorkspaceContext(mapId, machine, groupId).then((value) => {
      if (!active) return
      setContext(value)
      setWorkspace(editScope ? (editScope === 'document' ? value.documentSetting.workspace : value.groupSetting.workspace) : initialWorkspace)
    }).catch((reason) => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [mapId, groupId, machine, editScope, initialWorkspace])
  useEffect(() => {
    let active = true
    // 최근 목록은 수동 선택용일 뿐 자동 기본값의 근거가 아니다.
    if (context?.machineRole === 'main') void jsonRequest<{ workspaces: string[] }>('/api/integrations/aionui/workspaces')
      .then((value) => { if (active) setHistory(value.workspaces) }).catch(() => {})
    else setHistory([])
    return () => { active = false }
  }, [context?.machineRole])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busy) onClose() }
      if (event.key === 'Tab') {
        const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])]
        const first = elements[0], last = elements.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => { window.removeEventListener('keydown', keydown, true); previous?.focus() }
  }, [busy, onClose])
  async function browse(value: string) {
    setError(''); setBusy(true)
    try { setDirectory(await jsonRequest(`/api/integrations/aionui/directories?${new URLSearchParams({ path: value })}`)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '폴더를 열지 못했습니다.') }
    finally { setBusy(false) }
  }
  async function submit() {
    if (!context || busy) return
    setBusy(true); setError('')
    try {
      const choice = { workspace: workspace.trim(), scope, context }
      if (editScope) {
        const previous = editScope === 'document' ? context.documentSetting : context.groupSetting
        if (choice.workspace !== previous.workspace) {
          const result = await saveWorkspaceSetting(choice)
          if (result) setContext({ ...context, [editScope === 'document' ? 'documentSetting' : 'groupSetting']: result.setting })
          setSavedNotice('작업공간 설정은 저장되었습니다.')
        }
        if (title.trim() !== name) await onRename?.(title.trim())
        onClose()
      } else await onConfirm?.(choice)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '저장하지 못했습니다.')
      if (!editScope) {
        try { setContext(await loadWorkspaceContext(mapId, context.machineId, groupId)) } catch { /* 원래 실패 안내를 유지한다. */ }
      }
    }
    finally { setBusy(false) }
  }
  const label = editScope === 'group' ? '그룹' : '문서'
  return <div className="workspace-settings-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="workspace-settings-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label={editScope ? `${label} 이름·작업공간 편집` : '작업공간 확인'} tabIndex={-1}>
      <header><div><strong>{editScope ? `${label} 이름·작업공간 편집` : '작업공간을 확인해 주세요'}</strong><small>{name}</small></div><button type="button" aria-label="닫기" disabled={busy} onClick={onClose}>×</button></header>
      <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <div className="workspace-settings-content">
          {!context && !error && <p role="status">작업공간 기준을 확인하고 있습니다.</p>}
          {editScope && <label>이름<input value={title} maxLength={80} required disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>}
          {editScope && context?.machines && <label>실행 머신<select value={context.machineId} disabled={busy} onChange={(event) => setMachine(event.target.value)}>{context.machines.map((item) => <option key={item.machineId} value={item.machineId}>{item.label}</option>)}</select></label>}
          {context && <>
            {!editScope && <p>{context.error || (context.source !== 'none' ? '설정된 기준과 이번 대화의 작업공간을 확인해 주세요.' : context.choices.length > 1 ? '이 문서에서 여러 작업공간이 확인되었습니다. 이번 대화에 사용할 경로를 선택해 주세요.' : '문서·그룹의 기준 작업공간이 설정되지 않았습니다. 사용할 경로를 선택해 주세요.')}</p>}
            <label>작업공간{editScope ? ' (선택 사항)' : ''}<div className="workspace-settings-path"><input value={workspace} maxLength={1000} required={!editScope} disabled={busy} onChange={(event) => setWorkspace(event.target.value)} placeholder={editScope === 'document' ? '비워 두면 그룹 설정 사용' : editScope ? '비워 두면 AI 시작 시 선택' : '작업공간의 절대 경로'} />{context.workspaceBrowseAvailable && <button type="button" disabled={busy} onClick={() => void browse(workspace)}>탐색…</button>}</div></label>
            {editScope === 'document' && <small>문서 설정이 그룹 설정보다 우선합니다. 그룹 기준: {context.groupSetting.workspace || '미설정'}</small>}
            {editScope === 'group' && <small>별도 문서 설정이 없는 소속 문서에만 적용됩니다.</small>}
            {context.remotePathUnchecked && <small>원격 머신의 경로입니다. 해당 머신에 존재하는 절대 경로를 입력하세요. 이 서버에서는 폴더 존재 여부를 검사할 수 없습니다.</small>}
            {directory && <div className="workspace-settings-folders"><div><button type="button" disabled={busy || directory.parent === null} onClick={() => void browse(directory.parent ?? '')}>상위</button><span>{directory.path || '드라이브'}</span><button type="button" disabled={busy || !directory.path} onClick={() => { setWorkspace(directory.path); setDirectory(null) }}>이 폴더 선택</button></div><nav>{directory.entries.map((entry) => <button key={entry.path} type="button" disabled={busy} onClick={() => void browse(entry.path)}>{entry.name}</button>)}</nav></div>}
            {context.choices.length > 0 && <div className="workspace-settings-choices"><small>문서·그룹의 대화에서 확인한 후보</small>{context.choices.map((choice) => <button type="button" key={choice.workspace} disabled={busy} onClick={() => setWorkspace(choice.workspace)}><span>{choice.workspace}</span><small>{choice.reasons.join(' / ')}</small></button>)}</div>}
            {history.length > 0 && <details><summary>최근 작업공간에서 선택</summary><div className="workspace-settings-choices">{history.map((item) => <button key={item} type="button" disabled={busy} onClick={() => setWorkspace(item)}>{item}</button>)}</div></details>}
            {!editScope && <fieldset disabled={busy}><legend>선택한 경로의 적용 범위</legend>{([{ value: 'once', label: '이번 대화만 사용', available: true }, { value: 'document', label: '이 문서의 작업공간으로 설정', available: Boolean(mapId) }, { value: 'group', label: `이 그룹의 작업공간으로 설정 (${context.groupName})`, available: Boolean(context.groupId) }] as const).filter((item) => item.available).map((item) => <label key={item.value}><input type="radio" name="workspace-scope" checked={scope === item.value} onChange={() => setScope(item.value)} />{item.label}</label>)}</fieldset>}
            {scope === 'group' && !editScope && <small>별도 문서 설정이 없는 소속 문서에 적용됩니다.{context.documentSetting.workspace ? ' 현재 문서에는 별도 설정이 있어 다음 시작에도 문서 설정이 우선합니다. 이번 대화만 선택한 경로를 사용합니다.' : ''}</small>}
          </>}
          {savedNotice && <p role="status">{savedNotice}</p>}
          {error && <p className="workspace-settings-error" role="alert">{error}</p>}
        </div>
        <footer><button type="button" disabled={busy} onClick={onClose}>취소</button><button type="submit" className="primary" disabled={busy || !context || (editScope ? !title.trim() : !workspace.trim())}>{busy ? '처리 중…' : editScope ? '저장' : scope === 'once' ? '선택하고 시작' : '설정하고 시작'}</button></footer>
      </form>
    </div>
  </div>
}
