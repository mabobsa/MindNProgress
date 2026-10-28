import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { aiConversationLinkFromAionUiConversation } from '../../src/utils/aiConversations.mjs'

export function conversationConnectionError(message, status = 409, code = 'AI_CONVERSATION_CONNECTION_BLOCKED') {
  return Object.assign(new Error(message), { status, code, conversationConnectionError: true })
}

function isoDate(value) {
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value ?? '')) ? Number(value) : NaN
  const time = Number.isFinite(numeric) ? numeric * (numeric < 1_000_000_000_000 ? 1000 : 1) : Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function identity(conversation) {
  return createHash('sha256').update(JSON.stringify([
    conversation.id, conversation.name, conversation.created_at,
    conversation.extra?.workspace, conversation.extra?.agent_id, conversation.assistant?.id,
  ])).digest('hex')
}

// 외부 조회 동안 문서 잠금을 잡지 않고, 최종 저장 시 카드와 소속을 다시 확인한다.
export function createAiConversationConnection({ readContext, machinesForUser, findBinding, call,
  isRemoving, withMutation, link, now = Date.now }) {
  const linking = new Set()
  const secret = randomBytes(32)
  const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url')
  const issue = (value) => {
    const payload = Buffer.from(JSON.stringify({ ...value, expires: now() + 10 * 60_000 })).toString('base64url')
    return `${payload}.${sign(payload)}`
  }
  const verify = (token, user, mapId, cardId) => {
    try {
      if (typeof token !== 'string' || token.length > 4096) throw Error()
      const [payload, signature, extra] = token.split('.')
      const expected = Buffer.from(sign(payload)), actual = Buffer.from(signature ?? '')
      if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Error()
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString())
      if (value.userId !== user.id || value.mapId !== mapId || value.cardId !== cardId || value.expires <= now()) throw Error()
      return value
    } catch {
      throw conversationConnectionError('조회 정보가 만료되었거나 유효하지 않습니다. 대화 ID를 다시 조회해 주세요.', 409, 'AI_CONVERSATION_PREVIEW_EXPIRED')
    }
  }
  const archiveState = async (machineId, conversationId) => {
    const state = await call(machineId, `/api/sidebar/conversation/${encodeURIComponent(conversationId)}/archive-state`, { strictJson: true, singleTarget: true })
    if (state?.conversation_id !== conversationId || typeof state.exists !== 'boolean'
      || !(state.archived_at === null || Number.isSafeInteger(state.archived_at) && state.archived_at > 0)
      || !state.exists && state.archived_at !== null) {
      throw conversationConnectionError('Aion 대화의 보관 상태를 확인할 수 없습니다.', 502, 'AIONUI_ARCHIVE_STATE_INVALID')
    }
    return state
  }
  const inspect = async (machineId, conversationId) => {
    const state = await archiveState(machineId, conversationId)
    if (!state.exists) return null
    const conversation = await call(machineId, `/api/conversations/${encodeURIComponent(conversationId)}`, { strictJson: true, singleTarget: true })
    if (conversation?.id !== conversationId) throw conversationConnectionError('조회한 Aion 대화 ID가 일치하지 않습니다.', 502)
    return { state, conversation }
  }
  const assertBinding = async (mapId, cardId, conversationId, machineId) => {
    const binding = await findBinding(conversationId, machineId, mapId, cardId)
    if (binding) throw conversationConnectionError('다른 카드 또는 머신에 연결된 대화입니다. 조회한 연결 위치를 확인해 주세요.')
  }
  return {
    isLinking: (id) => linking.has(id),
    async preview(user, mapId, cardId, conversationId) {
      if (typeof conversationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(conversationId)) {
        throw conversationConnectionError('올바른 AionUi 대화 ID를 입력해 주세요.', 400)
      }
      const context = await readContext(user, mapId, cardId)
      const machines = machinesForUser(user)
      const results = await Promise.all(machines.map(async (machine) => {
        const { machineId, label, online } = machine
        if (!online) return { warning: `${label}: 머신이 연결되어 있지 않아 조회하지 못했습니다.` }
        try {
          const info = await inspect(machineId, conversationId)
          if (!info) return {}
          const { state, conversation } = info
          const binding = await findBinding(conversationId, machineId, mapId, cardId)
          const selection = aiConversationLinkFromAionUiConversation(conversation)
          return { conversation: {
            conversationId, homeMachineId: machineId, homeMachineLabel: label,
            name: String(conversation.name ?? '').trim() || '이름 없는 대화',
            agent: selection?.agent?.label ?? null, model: selection?.model?.label ?? null,
            workspace: selection?.workspace ?? null, createdAt: isoDate(conversation.created_at),
            modifiedAt: isoDate(conversation.modified_at), archivedAt: state.archived_at,
            runtimeState: conversation.runtime?.state ?? 'unknown', binding,
            alreadyLinked: context.card.data.aiConversationId === conversationId,
            previewToken: binding ? null : issue({ userId: user.id, mapId, cardId, conversationId,
              machineId, archivedAt: state.archived_at, identity: identity(conversation) }),
          } }
        } catch {
          return { warning: `${label}: 대화 조회에 실패했습니다. Aion 연결과 보관 상태 조회 기능을 확인해 주세요.` }
        }
      }))
      return { conversations: results.flatMap((result) => result.conversation ? [result.conversation] : []),
        warnings: results.flatMap((result) => result.warning ? [result.warning] : []) }
    },
    async connect(user, mapId, cardId, previewToken) {
      const preview = verify(previewToken, user, mapId, cardId)
      const { conversationId, machineId } = preview
      if (linking.has(conversationId) || isRemoving(conversationId)) {
        throw conversationConnectionError('이 대화의 연결 또는 삭제를 처리 중입니다. 잠시 후 다시 조회해 주세요.')
      }
      linking.add(conversationId)
      try {
        await readContext(user, mapId, cardId)
        const machine = machinesForUser(user).find((item) => item.machineId === machineId)
        if (!machine) throw conversationConnectionError('대화가 속한 머신을 사용할 권한이 없습니다.', 403)
        if (!machine.online) throw conversationConnectionError('대화가 속한 머신이 연결되어 있지 않습니다.', 503)
        await assertBinding(mapId, cardId, conversationId, machineId)
        const info = await inspect(machineId, conversationId)
        if (!info) throw conversationConnectionError('Aion 대화가 더 이상 존재하지 않습니다. 다시 조회해 주세요.', 404)
        if (identity(info.conversation) !== preview.identity
          || info.state.archived_at !== null && info.state.archived_at !== preview.archivedAt) {
          throw conversationConnectionError('조회 이후 대화 정보 또는 보관 상태가 변경되었습니다. 다시 조회해 주세요.')
        }
        if (info.state.archived_at !== null) {
          try {
            await call(machineId, `/api/sidebar/conversation/${encodeURIComponent(conversationId)}/unarchive`, {
              method: 'POST', strictJson: true, noMutationRetry: true, singleTarget: true,
            })
          } catch { /* 응답 유실 시 재전송하지 않고 실제 저장 상태를 확인한다. */ }
          const confirmed = await archiveState(machineId, conversationId)
          if (!confirmed.exists || confirmed.archived_at !== null) {
            throw conversationConnectionError('보관함에서 복원된 것을 확인하지 못했습니다. 대화 연결을 저장하지 않았습니다.', 502)
          }
        }
        return await withMutation(mapId, async () => {
          const context = await readContext(user, mapId, cardId)
          if (!machinesForUser(user).some((item) => item.machineId === machineId)) {
            throw conversationConnectionError('대화가 속한 머신의 접근 권한이 변경되었습니다.', 403)
          }
          await assertBinding(mapId, cardId, conversationId, machineId)
          return link(context, info.conversation, machineId, user)
        })
      } finally { linking.delete(conversationId) }
    },
  }
}
