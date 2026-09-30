function normalizedMessageType(value) {
  return String(value ?? '').trim().toLowerCase()
}

function normalizedPosition(value) {
  return String(value ?? '').trim().toLowerCase()
}

function isToolEvent(type) {
  return type === 'tool_call'
    || type === 'acp_tool_call'
    || type === 'tool_result'
    || type === 'acp_tool_result'
    || type === 'tool_group'
}

export function summarizeAiConversationMessages(items, {
  historyComplete = false,
  pageCount = 1,
} = {}) {
  const messages = Array.isArray(items) ? items : []
  const seenIds = new Set()
  const backendTurnIds = new Set()
  let eventCount = 0
  let textMessageCount = 0
  let userMessageCount = 0
  let assistantMessageCount = 0
  let toolCallCount = 0

  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue
    const id = String(message.id ?? message.msg_id ?? '').trim()
    if (id && seenIds.has(id)) continue
    if (id) seenIds.add(id)
    eventCount += 1

    const backendTurnId = String(message.backend_turn_id ?? message.backendTurnId ?? '').trim()
    if (backendTurnId) backendTurnIds.add(backendTurnId)

    const type = normalizedMessageType(message.type)
    if (isToolEvent(type)) {
      toolCallCount += 1
      continue
    }
    if (type !== 'text') continue
    textMessageCount += 1
    const position = normalizedPosition(message.position)
    if (position === 'right' || position === 'user') userMessageCount += 1
    else if (position === 'left' || position === 'assistant') assistantMessageCount += 1
  }

  // AionCore는 한 실행 턴에 생성된 텍스트·도구 이벤트에 같은 backend_turn_id를
  // 기록한다. 과거 행에는 이 값이 없을 수 있으므로 사용자 메시지 수를 하한으로
  // 사용하되 두 값을 더해 같은 턴을 중복 계산하지 않는다.
  const conversationTurnCount = Math.max(backendTurnIds.size, userMessageCount)
  return {
    conversationTurnCount,
    conversationTurnCountExact: historyComplete,
    // 기존 응답 소비자를 위한 호환 별칭이다. 더 이상 저장 이벤트 개수를 뜻하지 않는다.
    messageCount: conversationTurnCount,
    messageCountExact: historyComplete,
    eventCount,
    eventCountExact: historyComplete,
    textMessageCount,
    userMessageCount,
    assistantMessageCount,
    toolCallCount,
    otherEventCount: Math.max(0, eventCount - textMessageCount - toolCallCount),
    backendTurnCount: backendTurnIds.size,
    historyComplete,
    pageCount: Math.max(0, Number(pageCount) || 0),
  }
}
