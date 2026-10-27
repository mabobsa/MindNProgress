export function conversationRemovalError(message, status = 409, code = 'AI_CONVERSATION_REMOVAL_BLOCKED') {
  return Object.assign(new Error(message), { status, code, conversationRemovalError: true })
}

// 연결을 삭제하기 전 Aion의 실제 보관 상태를 읽는다. 404는 구버전 API일 수도 있어 부재 증거로 쓰지 않는다.
export async function ensureConversationArchived({ call, conversationId, assertIdle }) {
  const base = `/api/sidebar/conversation/${encodeURIComponent(conversationId)}`
  const readState = async () => {
    const state = await call(`${base}/archive-state`, { strictJson: true, singleTarget: true })
    if (state?.conversation_id !== conversationId || typeof state.exists !== 'boolean'
      || !(state.archived_at === null || (Number.isSafeInteger(state.archived_at) && state.archived_at > 0))
      || (!state.exists && state.archived_at !== null)) {
      throw conversationRemovalError('Aion 대화의 보관 상태 응답을 확인할 수 없습니다. 연결을 유지합니다.', 502, 'AIONUI_ARCHIVE_STATE_INVALID')
    }
    return state
  }
  const state = await readState()
  if (!state.exists) return 'missing'
  await assertIdle()
  if (state.archived_at !== null) return 'archived'
  let archiveError
  try {
    await call(`${base}/archive`, { method: 'POST', strictJson: true, noMutationRetry: true, singleTarget: true })
  } catch (error) {
    archiveError = error
  }
  // 보관 요청의 응답이 유실되어도 재전송하지 않고 저장 상태로 확인한다.
  const confirmed = await readState()
  if (!confirmed.exists || confirmed.archived_at === null) {
    throw conversationRemovalError('Aion 보관함 이동을 확인하지 못했습니다. MnP 연결을 유지합니다. 다시 시도해 주세요.', 502, archiveError?.code ?? 'AIONUI_ARCHIVE_NOT_CONFIRMED')
  }
  return 'archived'
}

export function createAiConversationRemoval({ readContext, assertSafe, call, assertIdle, acquireMutation, unlink, withMutation }) {
  const removing = new Set()
  return {
    isRemoving: (id) => removing.has(id),
    async remove(user, mapId, cardId, conversationId) {
      if (removing.has(conversationId)) throw conversationRemovalError('이 대화의 삭제를 처리 중입니다. 잠시 후 목록을 확인해 주세요.')
      removing.add(conversationId)
      try {
        const initial = await readContext(user, mapId, cardId, conversationId)
        let archiveState = 'unlinked'
        if (initial.link) {
          await assertSafe(initial, conversationId)
          archiveState = await ensureConversationArchived({
            conversationId,
            call: (pathname, options) => call(initial.machineId, pathname, options),
            assertIdle: () => assertIdle(initial.machineId, conversationId),
          })
        }
        // 외부 호출 중에는 전역 문서 변경 잠금을 보유하지 않는다. 마지막 쓰기에서 최신 문서를 다시 읽는다.
        const commit = async () => {
          const current = await readContext(user, mapId, cardId, conversationId)
          if (current.link) {
            if (!initial.link || current.machineId !== initial.machineId
              || JSON.stringify(current.link) !== JSON.stringify(initial.link)) {
              throw conversationRemovalError('확인하는 동안 대화 연결이 변경되었습니다. 목록을 다시 확인해 주세요.')
            }
            await assertSafe(current, conversationId)
          }
          return { ...await unlink(current, conversationId, user), archiveState }
        }
        if (withMutation) return await withMutation(mapId, commit)
        const release = await acquireMutation()
        try { return await commit() } finally { release() }
      } finally { removing.delete(conversationId) }
    },
  }
}
