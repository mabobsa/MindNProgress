import { useCallback, useEffect, useRef, useState } from 'react'

type PendingLaunch = { statusUrl: string; useWeb: boolean; requestedAt: number }
type LaunchStatus = {
  status: 'pending' | 'completed' | 'delivery-unknown' | 'confirmation-failed'
  error?: string
  conversationId?: string
  launchUrl?: string | null
  desktopLaunchUrl?: string | null
}
const validStatusUrl = (url: unknown): url is string => typeof url === 'string'
  && /^\/api\/integrations\/aionui\/launches\/[A-Za-z0-9_-]{43}\/status$/.test(url)

function readPending(key: string): PendingLaunch | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as PendingLaunch | null
    return value && validStatusUrl(value.statusUrl) && typeof value.useWeb === 'boolean' && Number.isFinite(value.requestedAt) ? value : null
  } catch { return null }
}

// 팝업을 닫거나 새로고침해도 접수 불명확 요청을 자동으로 다시 시작하지 않는다.
export function useAiLaunchConfirmation(scope: string, onCompleted: () => void) {
  const key = `mindnprogress-ai-launch:${scope}`
  const [pending, setPending] = useState(() => readPending(key))
  const [status, setStatus] = useState<LaunchStatus | null>(null)
  const [checkError, setCheckError] = useState('')
  const [revision, setRevision] = useState(0)
  const [delayed, setDelayed] = useState(false)
  const completedRef = useRef(onCompleted)
  useEffect(() => { completedRef.current = onCompleted }, [onCompleted])
  useEffect(() => { setPending(readPending(key)); setStatus(null); setCheckError(''); setDelayed(false) }, [key])

  const begin = useCallback((statusUrl: string, useWeb: boolean) => {
    if (!validStatusUrl(statusUrl)) throw new Error('대화 생성 확인 주소가 올바르지 않습니다. MnP 서버를 업데이트해 주세요.')
    const value = { statusUrl, useWeb, requestedAt: Date.now() }
    // 안전하게 상태를 복원할 수 없으면 ticket 발급 전 중단한다.
    sessionStorage.setItem(key, JSON.stringify(value))
    setPending(value)
    setStatus(null)
    setCheckError('')
    setDelayed(false)
  }, [key])

  useEffect(() => {
    if (!pending) return
    const controller = new AbortController()
    let checking = false
    let terminal = false
    const check = async () => {
      if (checking || terminal) return
      checking = true
      setDelayed(Date.now() - pending.requestedAt >= 30_000)
      try {
        const response = await fetch(pending.statusUrl, { credentials: 'include', cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        const result = await response.json() as LaunchStatus
        if (controller.signal.aborted) return
        if (!response.ok) {
          terminal = response.status === 404 || response.status === 401 || response.status === 403
          throw new Error(result.error || '대화 생성 상태를 확인하지 못했습니다.')
        }
        setStatus(result)
        setCheckError('')
        if (result.status === 'completed' && result.conversationId) {
          terminal = true
          sessionStorage.removeItem(key)
          setPending(null)
          completedRef.current()
        }
      } catch (error) {
        if (!controller.signal.aborted) setCheckError(error instanceof Error ? error.message : '대화 생성 상태를 확인하지 못했습니다.')
      } finally { checking = false }
    }
    void check()
    const interval = window.setInterval(() => { void check() }, 2000)
    return () => { controller.abort(); window.clearInterval(interval) }
  }, [key, pending, revision])

  const reopen = () => {
    const url = pending?.useWeb ? status?.launchUrl : status?.desktopLaunchUrl
    if (!url) return
    if (pending?.useWeb) {
      const tab = window.open(url, '_blank')
      if (!tab) { setCheckError('AionUi 탭을 열지 못했습니다. 브라우저 팝업 차단을 확인해 주세요.'); return }
      tab.opener = null
    } else window.location.href = url
  }
  const reset = () => {
    if (!window.confirm('이미 대화가 생성되었을 수 있습니다. AionUi에 같은 대화가 있으면 기존 대화에서 이어가세요.\n대화 목록을 확인했고, 시작 상태를 초기화하여 새로 준비하시겠습니까?')) return false
    sessionStorage.removeItem(key)
    setPending(null)
    setStatus(null)
    setCheckError('')
    setDelayed(false)
    return true
  }
  return { pending, begin, reopen, check: () => setRevision(value => value + 1),
    reset, canReset: delayed || Boolean(checkError || status?.error),
    canReopen: Boolean(pending?.useWeb ? status?.launchUrl : status?.desktopLaunchUrl),
    error: checkError || status?.error || '' }
}
