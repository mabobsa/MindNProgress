import { createHash } from 'node:crypto'
import { originalDelegationMessage } from './aiDelegationOriginalMessage.mjs'

export const sourceBackendTurnId = '01a11291-a2d9-7db1-b2e0-6c1df6ea7ee8'
export const sourceInstruction = '원 승인 범위의 결과를 구현하고 원문으로 보고하세요.'
export const sourceResult = '기존 담당자의 완료 원문'
export const sourceHash = value => createHash('sha256').update(value, 'utf8').digest('hex')

export function sourceCompletionFixture({ lease, result, instruction = sourceInstruction, snapshot = sourceResult } = {}) {
  lease ??= { poolId: 'pool', sharedRoot: 'C:/test/shared', workspaceId: 'worker', jobId: 'job', leaseId: 'lease',
    projectRoot: 'C:/test/worker', branch: 'mnp/job', baseBranch: 'japan-master', baseCommit: 'a'.repeat(40),
    startedAt: '2026-10-06T18:54:44.548Z', checkpointCount: 1 }
  const started = Date.parse(lease.startedAt), captured = started + 10_000, completed = captured + 1_000
  const delegation = { id: 'original:icons', mapId: 'map-test', targetCardId: 'card-test', targetConversationId: 'conversation-test',
    startedBy: 'user-admin', strategy: 'new', instructionHash: sourceHash(instruction), state: 'waiting-integration',
    childOperationId: 'original:icons', childTurnId: 'original-turn', childStatus: 'completed',
    childResultSnapshot: snapshot, childResultHash: sourceHash(snapshot), childResultTurnId: 'original-turn',
    childResultCapturedAt: new Date(captured).toISOString(), childCompletedAt: new Date(completed).toISOString(),
    workspaceLease: lease, workspaceResult: result ?? { ...Object.fromEntries(['workspaceId', 'jobId', 'leaseId', 'branch', 'baseBranch', 'baseCommit'].map(key => [key, lease[key]])),
      mapId: 'map-test', cardId: 'card-test', conversationId: 'conversation-test', status: 'waiting-integration', childStatus: 'completed',
      reasonCode: 'integration-untracked-collision', integratedCommit: null,
      headCommit: 'b'.repeat(40), integrationHeadCommit: 'c'.repeat(40), integrationBaseCommit: lease.baseCommit, integrationBranch: 'mnp/integrate/job' } }
  const origin = { conversationId: delegation.targetConversationId, mapId: delegation.mapId, cardId: delegation.targetCardId,
    startedBy: delegation.startedBy, linkedAt: new Date(started + 100).toISOString() }
  const conversation = { id: delegation.targetConversationId, status: 'finished', created_at: started + 10,
    extra: { workspace: lease.projectRoot }, runtime: { state: 'idle', is_processing: false, pending_confirmations: 0,
      has_task: false, task_status: null, turn_id: null } }
  const request = { ...originalDelegationMessage({ ...delegation, pendingInstruction: instruction }, { createdAt: started + 20 }),
    conversation_id: delegation.targetConversationId, status: 'finish' }
  // 원 전문에 포함될 수 있는 토큰은 proof나 진단에 반환하지 않는다.
  request.content.content = request.content.content.replace('\n# 상위 AI 지시', '\n- attributionToken: `fixture-secret-original-token`\n# 상위 AI 지시')
  const row = (id, type, offset, content, status = 'finish', backend = sourceBackendTurnId) => ({ id,
    conversation_id: delegation.targetConversationId, type, position: 'left', created_at: started + offset,
    status, content, ...(backend ? { backend_turn_id: backend } : {}) })
  const rows = [request, row('initial-tip', 'tips', 30, {}, 'finish', null),
    row('tool-ok', 'tool_call', 40, { status: 'completed' }),
    row('tool-error', 'tool_call', 50, { status: 'error' }, 'error'),
    row('final-result', 'text', 9_000, { content: snapshot })]
  return { delegation, origin, conversation, rows, pages: sourceCompletionPages(rows), instruction }
}

export function sourceCompletionPages(rows) {
  const chronological = [...rows].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  const pages = []
  for (let end = chronological.length; end > 0; end -= 100) {
    const start = Math.max(0, end - 100), items = chronological.slice(start, end)
    pages.push({ items, has_more_before: start > 0, has_more_after: end < chronological.length,
      oldest_cursor: `cursor-${items[0].id}`, newest_cursor: `cursor-${items.at(-1).id}` })
  }
  return pages
}
