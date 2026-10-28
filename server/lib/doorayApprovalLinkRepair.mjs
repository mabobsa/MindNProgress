import { createHash } from 'node:crypto'
import { aiConversationLinksFromData } from '../../src/utils/aiConversations.mjs'
import { assertDoorayApproval, buildDoorayApprovalRequest } from './doorayResponseDecision.mjs'

const fail = () => Object.assign(new Error('기존 승인·생성 요청·귀속·카드·대화의 대응을 확인하지 못해 복구하지 않았습니다.'), { status: 409 })
const sha = value => createHash('sha256').update(value).digest('hex')
const normalizedPath = value => String(value ?? '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()

// 새 승인을 만들지 않는다. 이미 생성·연결된 대화의 원본 요청과 토큰 귀속까지 입증된 누락만 복구한다.
export function verifiedDoorayApprovalLink({ userId, job, revision, conversationId, map, origin, attributions, conversation, messages, mainMachineId }) {
  const card = map?.nodes.find(node => node.id === job?.route?.cardId)
  const link = card && aiConversationLinksFromData(card.data).find(value => value.conversationId === conversationId)
  if (!job || job.userId !== userId || job.approval?.approvedBy?.id !== userId || !map || map.trashedAt || map.archivedAt
    || job.route?.mapId !== map.id || !link || link.startedBy?.id !== userId || conversation?.id !== conversationId
    || origin?.conversationId !== conversationId || origin.startedBy !== userId || origin.mapId !== map.id || origin.cardId !== card.id
    || origin.homeMachineId !== link.homeMachineId || !link.homeMachineId
    || !link.workspace || normalizedPath(link.workspace) !== normalizedPath(conversation.extra?.workspace)
    || normalizedPath(origin.workspace) !== normalizedPath(link.workspace)
    || job.approval.conversation && job.approval.conversation.conversationId !== conversationId) throw fail()
  const approvedAt = Date.parse(job.approval.approvedAt), createdAt = typeof conversation.created_at === 'number' ? conversation.created_at : Date.parse(conversation.created_at), linkedAt = Date.parse(link.linkedAt)
  if (![approvedAt, createdAt, linkedAt].every(Number.isFinite) || createdAt < approvedAt || linkedAt < createdAt
    || Date.parse(link.startedAt) !== createdAt || job.completedAt && (!Number.isFinite(Date.parse(job.completedAt)) || linkedAt > Date.parse(job.completedAt))) throw fail()
  const connection = { conversationId, mapId: map.id, cardId: card.id, homeMachineId: link.homeMachineId,
    homeMachineRole: link.homeMachineId === mainMachineId ? 'main' : 'sub', linkedAt: link.linkedAt }
  // 실제 저장값은 그대로 두고 기존 검증기로 승인 상태·revision·scope를 확인한다.
  const candidate = { ...job, approval: { ...job.approval, conversation: connection } }
  assertDoorayApproval(candidate, revision, { execution: true, conversationId })
  const expected = buildDoorayApprovalRequest(candidate, { execution: true, conversationId }).replaceAll('\r\n', '\n')
  const request = messages.find(message => {
    if (message.position !== 'right' || message.type !== 'text' || message.conversation_id !== conversationId || typeof message.content !== 'string') return false
    const text = message.content.replaceAll('\r\n', '\n')
    const token = text.match(/^- attributionToken: [`]?([A-Za-z0-9_-]{43})[`]?\s*$/m)?.[1]
    const attribution = token && attributions.find(value => value.tokenHash === sha(token) && value.startedBy === userId
      && value.conversationId === conversationId && value.mapId === map.id && value.cardId === card.id
      && value.homeMachineId === link.homeMachineId && normalizedPath(value.selection?.workspace) === normalizedPath(link.workspace))
    return Boolean(attribution && text.includes(expected))
  })
  if (!request) throw fail()
  return { connection, evidence: { requestMessageId: request.id, requestSha256: sha(request.content), conversationCreatedAt: conversation.created_at } }
}
