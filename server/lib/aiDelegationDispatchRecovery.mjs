import { createHash } from 'node:crypto'
import { sameExecutionWorkspace } from './doorayExecutionWorkspace.mjs'

const fail = () => Object.assign(new Error('원본 실행 기록이 만료됐고 대화의 최초 위임 전문·시작 카드·작업공간을 확증하지 못했습니다.'), { status: 409, code: 'AI_DELEGATION_ORIGINAL_MESSAGE_UNCONFIRMED' })

function verifyOriginalMessage(delegation, origin, conversation, message, completedObservation) {
  const lease = delegation.workspaceLease
  const content = typeof message?.content === 'string' ? message.content : message?.content?.content
  if (!lease || delegation.strategy !== 'new' || !origin || origin.conversationId !== conversation?.id
    || origin.mapId !== delegation.mapId || origin.cardId !== delegation.targetCardId
    || origin.startedBy !== delegation.startedBy || message?.type !== 'text' || message.position !== 'right'
    || !message.id || typeof content !== 'string') throw fail()
  const createdAt = Number(conversation.created_at)
  const messageCreatedAt = Number(message.created_at)
  const startedAt = Date.parse(lease.startedAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(messageCreatedAt) || !Number.isFinite(startedAt)
    || createdAt < startedAt - 1000 || createdAt > startedAt + 300_000
    || messageCreatedAt < createdAt || messageCreatedAt > createdAt + 300_000) throw fail()
  const text = content.replace(/\r\n?/g, '\n')
  const marker = '\n# 상위 AI 지시\n\n'
  const split = text.indexOf(marker)
  if (!text.startsWith('# MindNProgress 하위 카드 위임 작업 요청\n') || split < 0 || text.indexOf(marker, split + 1) >= 0) throw fail()
  const instruction = text.slice(split + marker.length).trim()
  const instructionHash = createHash('sha256').update(instruction).digest('hex')
  const pending = delegation.pendingInstruction
  const instructionEvidence = completedObservation && (pending === undefined || pending === null)
    ? 'durable-instruction-hash' : 'pending-instruction-exact'
  if (!delegation.instructionHash || instructionHash !== delegation.instructionHash
    || (instructionEvidence === 'pending-instruction-exact' && instruction !== pending?.trim())) throw fail()
  const header = text.slice(0, split).split('\n')
  const field = (key) => {
    const prefix = `- ${key}: \``
    const lines = header.filter((line) => line.startsWith(prefix) && line.endsWith('`'))
    if (lines.length !== 1) throw fail()
    return lines[0].slice(prefix.length, -1)
  }
  for (const [key, value] of Object.entries({ mapId: delegation.mapId, cardId: delegation.targetCardId, editorId: delegation.startedBy })) {
    if (field(key) !== value) throw fail()
  }
  const workspaceLease = Object.fromEntries(['workspaceId', 'jobId', 'leaseId', 'projectRoot', 'branch', 'baseCommit'].map((key) => [key, field(key)]))
  for (const [key, value] of Object.entries(workspaceLease)) {
    if (!lease[key] || (key === 'projectRoot' ? !sameExecutionWorkspace(value, lease[key]) : value !== lease[key])) throw fail()
  }
  if (!sameExecutionWorkspace(conversation.extra?.workspace, lease.projectRoot)) throw fail()
  return { conversationId: conversation.id, workspaceLease,
    recoveryProof: { kind: completedObservation ? 'completed-original-message-after-operation-expiry' : 'original-message-after-operation-expiry',
      ...(completedObservation ? { instructionEvidence } : {}), messageId: message.id, instructionHash,
      conversationCreatedAt: createdAt, originLinkedAt: origin.linkedAt } }
}

export function verifyAiDelegationOriginalMessage(delegation, origin, conversation, message) {
  return verifyOriginalMessage(delegation, origin, conversation, message, false)
}

// 정상 dispatch는 pendingInstruction을 소거한다. 완료 관측 경로에서만 내구 hash로
// 원 지시를 대사하며, 기존 누락 대화 복구의 pending exact 계약은 유지한다.
export function verifyAiDelegationCompletedOriginalMessage(delegation, origin, conversation, message) {
  if (delegation.childStatus !== 'completed' || !Number.isFinite(Date.parse(delegation.childCompletedAt))) throw fail()
  return verifyOriginalMessage(delegation, origin, conversation, message, true)
}
