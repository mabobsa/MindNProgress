import { useEffect, useState } from 'react'
import './AdminEditorPanel.css'

type EditorAccount = {
  id: string
  name: string
  email: string
  role: 'editor'
  active: boolean
  createdAt: string | null
  updatedAt: string | null
  lastLoginAt: string | null
}

async function adminRequest<T>(pathname: string, init?: RequestInit) {
  const response = await fetch(pathname, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? '요청을 처리하지 못했습니다.')
  return body
}

function accountDate(value: string | null) {
  return value ? new Date(value).toLocaleString('ko-KR') : '기록 없음'
}

export function AdminEditorPanel({ onClose }: { onClose: () => void }) {
  const [editors, setEditors] = useState<EditorAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState({ name: '', email: '' })
  const [credentialNotice, setCredentialNotice] = useState<{ title: string; password: string } | null>(null)

  useEffect(() => {
    let active = true
    void adminRequest<{ editors: EditorAccount[] }>('/api/admin/editors')
      .then((result) => { if (active) setEditors(result.editors) })
      .catch((requestError) => { if (active) setError(requestError instanceof Error ? requestError.message : '편집자 계정을 불러오지 못했습니다.') })
      .finally(() => { if (active) setLoading(false) })
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => { active = false; window.removeEventListener('keydown', closeOnEscape) }
  }, [onClose])

  const createEditor = async () => {
    if (!name.trim() || !email.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const result = await adminRequest<{ editor: EditorAccount; temporaryPassword: string | null }>('/api/admin/editors', {
        method: 'POST',
        body: JSON.stringify({ name, email, password }),
      })
      setEditors((current) => [...current, result.editor])
      setName('')
      setEmail('')
      setPassword('')
      if (result.temporaryPassword) setCredentialNotice({ title: `${result.editor.name} 임시 비밀번호`, password: result.temporaryPassword })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '편집자 계정을 생성하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  const updateEditor = async (editorId: string, patch: { name?: string; email?: string; active?: boolean }) => {
    setError('')
    try {
      const result = await adminRequest<{ editor: EditorAccount }>(`/api/admin/editors/${encodeURIComponent(editorId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })
      setEditors((current) => current.map((editor) => editor.id === editorId ? result.editor : editor))
      setEditingId(null)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '편집자 계정을 변경하지 못했습니다.')
    }
  }

  const resetPassword = async (editor: EditorAccount) => {
    if (!window.confirm(`${editor.name} 계정의 기존 로그인 세션을 종료하고 비밀번호를 초기화할까요?`)) return
    setError('')
    try {
      const result = await adminRequest<{ editor: EditorAccount; temporaryPassword: string }>(`/api/admin/editors/${encodeURIComponent(editor.id)}/reset-password`, { method: 'POST' })
      setEditors((current) => current.map((candidate) => candidate.id === editor.id ? result.editor : candidate))
      setCredentialNotice({ title: `${editor.name} 새 임시 비밀번호`, password: result.temporaryPassword })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '비밀번호를 초기화하지 못했습니다.')
    }
  }

  const deleteEditor = async (editor: EditorAccount) => {
    if (!window.confirm(`${editor.name} 편집자 계정을 삭제할까요? 이 계정은 즉시 로그아웃됩니다.`)) return
    setError('')
    try {
      await adminRequest(`/api/admin/editors/${encodeURIComponent(editor.id)}`, { method: 'DELETE' })
      setEditors((current) => current.filter((candidate) => candidate.id !== editor.id))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '편집자 계정을 삭제하지 못했습니다.')
    }
  }

  const activeCount = editors.filter((editor) => editor.active).length

  return (
    <div className="admin-account-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="admin-account-panel" role="dialog" aria-modal="true" aria-label="편집자 계정 관리">
        <header className="admin-account-header">
          <div><span>Administration</span><h2>편집자 계정 관리</h2><p>워크스페이스를 편집할 사용자를 생성하고 접근 권한을 관리합니다.</p></div>
          <button onClick={onClose} aria-label="계정 관리 닫기">×</button>
        </header>

        <div className="admin-account-body">
          <div className="admin-account-metrics">
            <article><span>전체 편집자</span><strong>{editors.length}</strong></article>
            <article><span>활성 계정</span><strong>{activeCount}</strong></article>
            <article><span>정지 계정</span><strong>{editors.length - activeCount}</strong></article>
          </div>

          <section className="editor-create-card">
            <div className="admin-section-heading"><div><span>새 편집자</span><strong>계정 추가</strong></div><small>비밀번호를 비우면 안전한 임시 비밀번호를 생성합니다.</small></div>
            <form onSubmit={(event) => { event.preventDefault(); void createEditor() }}>
              <label><span>이름</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="홍길동" maxLength={60} required /></label>
              <label><span>이메일</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="editor@company.com" maxLength={160} required /></label>
              <label><span>초기 비밀번호</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="자동 생성" minLength={8} /></label>
              <button type="submit" disabled={submitting || !name.trim() || !email.trim()}>{submitting ? '생성 중…' : '편집자 추가'}</button>
            </form>
          </section>

          {credentialNotice && (
            <div className="credential-notice" role="status">
              <span><strong>{credentialNotice.title}</strong><code>{credentialNotice.password}</code><small>이 화면을 닫으면 다시 확인할 수 없습니다.</small></span>
              <button onClick={() => { void navigator.clipboard.writeText(credentialNotice.password) }}>복사</button>
              <button className="notice-close" onClick={() => setCredentialNotice(null)} aria-label="임시 비밀번호 알림 닫기">×</button>
            </div>
          )}

          {error && <div className="admin-account-error" role="alert">{error}</div>}

          <section className="editor-list-card">
            <div className="admin-section-heading"><div><span>Editor Accounts</span><strong>등록된 편집자</strong></div><small>{activeCount}개 계정이 로그인할 수 있습니다.</small></div>
            {loading && <div className="editor-list-message">계정을 불러오는 중…</div>}
            {!loading && editors.map((editor) => (
              <article className={`editor-account-row ${editor.active ? '' : 'inactive'}`} key={editor.id}>
                <span className="editor-account-avatar">{editor.name.replace(/\s/g, '').slice(0, 2)}</span>
                {editingId === editor.id ? (
                  <form className="editor-inline-edit" onSubmit={(event) => { event.preventDefault(); void updateEditor(editor.id, editDraft) }}>
                    <input value={editDraft.name} onChange={(event) => setEditDraft((current) => ({ ...current, name: event.target.value }))} aria-label="편집자 이름" maxLength={60} />
                    <input type="email" value={editDraft.email} onChange={(event) => setEditDraft((current) => ({ ...current, email: event.target.value }))} aria-label="편집자 이메일" maxLength={160} />
                    <button type="submit">저장</button><button type="button" onClick={() => setEditingId(null)}>취소</button>
                  </form>
                ) : (
                  <div className="editor-account-info">
                    <span><strong>{editor.name}</strong><i className={editor.active ? 'active' : ''}>{editor.active ? '활성' : '정지'}</i></span>
                    <small>{editor.email}</small>
                    <time>최근 로그인 {accountDate(editor.lastLoginAt)} · 생성 {accountDate(editor.createdAt)}</time>
                  </div>
                )}
                {editingId !== editor.id && (
                  <div className="editor-account-actions">
                    <button onClick={() => { setEditingId(editor.id); setEditDraft({ name: editor.name, email: editor.email }) }}>수정</button>
                    <button onClick={() => { void updateEditor(editor.id, { active: !editor.active }) }}>{editor.active ? '정지' : '활성화'}</button>
                    <button onClick={() => { void resetPassword(editor) }}>비밀번호 초기화</button>
                    <button className="danger" onClick={() => { void deleteEditor(editor) }}>삭제</button>
                  </div>
                )}
              </article>
            ))}
            {!loading && editors.length === 0 && <div className="editor-list-message">등록된 편집자 계정이 없습니다.</div>}
          </section>
        </div>
      </section>
    </div>
  )
}
