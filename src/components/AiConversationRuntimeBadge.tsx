import type { AiConversationRuntime, AiDelegationCardStatus } from '../types/mindMap'
import './AiConversationRuntimeBadge.css'

function AiConversationTypingDots() {
  return (
    <span className="ai-conversation-runtime-typing" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

export function AiConversationActivityIndicator({ activeCount, label }: { activeCount: number; label?: string }) {
  if (activeCount <= 0) return null
  const indicatorLabel = label ?? `AI 작업 중인 카드 ${activeCount}개`
  return (
    <span className="ai-conversation-activity-indicator" title={indicatorLabel} aria-label={indicatorLabel}>
      <AiConversationTypingDots />
    </span>
  )
}

export function AiConversationRuntimeBadge({ runtime }: { runtime?: AiConversationRuntime }) {
  if (!runtime || runtime.state === 'idle' || runtime.state === 'unknown') return null

  const waitingForConfirmation = runtime.state === 'waiting-confirmation'
  const label = waitingForConfirmation ? 'AI 승인 대기' : 'AI 작업 중'
  const title = waitingForConfirmation
    ? `AionUi에서 ${runtime.pendingConfirmations}개의 승인을 기다리고 있습니다.`
    : 'AionUi가 이 카드에 연결된 대화에서 작업하고 있습니다.'

  return (
    <span className={`ai-conversation-runtime-badge ${runtime.state}`} title={title} aria-label={label}>
      {waitingForConfirmation ? (
        <span className="ai-conversation-runtime-dot" aria-hidden="true" />
      ) : (
        <AiConversationTypingDots />
      )}
      <span>{label}</span>
    </span>
  )
}

export function AiDelegationStatusBadge({ status }: { status?: AiDelegationCardStatus }) {
  if (!status) return null
  const recoveryRequired = status.recoveryCount > 0 || status.reportCount > 0
  const label = recoveryRequired ? 'AI 위임 복구 필요' : 'AI 위임 중'
  return (
    <strong
      className={`ai-delegation-status-badge ${recoveryRequired ? 'recovery-required' : 'active'}`}
      title={status.title}
      aria-label={`${label}. ${status.title}`}
    >
      {label}
    </strong>
  )
}
