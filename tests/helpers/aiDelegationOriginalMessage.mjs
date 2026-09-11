export function originalDelegationMessage(delegation, { id = 'original-message', createdAt = Date.parse(delegation.workspaceLease.startedAt) + 1000 } = {}) {
  const fields = { mapId: delegation.mapId, cardId: delegation.targetCardId, editorId: delegation.startedBy,
    ...Object.fromEntries(['workspaceId', 'jobId', 'leaseId', 'projectRoot', 'branch', 'baseCommit'].map((key) => [key, delegation.workspaceLease[key]])) }
  return { id, type: 'text', position: 'right', created_at: createdAt, content: { content:
    '# MindNProgress 하위 카드 위임 작업 요청\n\n'
    + Object.entries(fields).map(([key, value]) => `- ${key}: \`${value}\``).join('\n')
    + '\n# 상위 AI 지시\n\n' + delegation.pendingInstruction } }
}
