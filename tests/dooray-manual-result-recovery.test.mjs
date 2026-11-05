import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createDoorayResponseService } from '../server/lib/doorayResponses.mjs'
import { doorayManualResultRecoveryEvidence } from '../server/lib/doorayResponseIntegration.mjs'

const proposal = '회수할 제안 원문\n\n한글과 **서식**, 마지막 내용과 공백을 보존합니다.  \n'
const decision = { kind: 'proposal', reason: '실행 없이 검토 자료를 제시합니다.', questions: [], approval: null }
const route = { action: 'direct', mapId: 'map-test', cardId: 'card-test', conversationId: null,
  reason: '현재 담당 카드의 검토 범위', requestSummary: '검토 자료 확인' }

async function fixture(t, configure = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-manual-proposal-'))
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('mnp-manual-proposal-'))
    await rm(directory, { recursive: true, force: true })
  })
  const file = path.join(directory, 'user-test.json')
  const job = { id: 'response-test', userId: 'user-test', conversationPolicy: 'dedicated', status: 'failed',
    error: '모델 실행 용량 초과', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:01:00Z',
    source: { subject: '검토 자료', fingerprint: 'source-test', item: { key: 'item-test', postId: 'post-test', url: 'https://example.test/task' } },
    settings: { machineId: 'main', proposalWorkspace: path.join(directory, 'proposal-workspace') },
    operation: { id: 'response-test-route-3-0', kind: 'router', machineId: 'main', conversationId: 'proposal-chat', dispatchAttempted: true },
    router: { conversationId: 'proposal-chat', machineId: 'main', dedicated: true }, proposal: '', approval: null }
  job.operation.settings = structuredClone(job.settings)
  const conversation = { id: 'proposal-chat', runtime: { state: 'idle', task_status: 'finished', is_processing: false, pending_confirmations: 0 },
    extra: { mnpDoorayOperationId: 'response-test-route-0-0', mnpDoorayResponseId: job.id, mnpDoorayUserId: job.userId, workspace: job.settings.proposalWorkspace } }
  const dispatch = { operationId: job.operation.id, conversationId: 'proposal-chat', state: 'failed', turnId: 'original-failed-turn', errorMessage: job.error }
  const message = { id: 'final-message', conversation_id: 'proposal-chat', position: 'left', type: 'text', status: 'finish', hidden: false,
    backend_turn_id: 'manual-finished-turn', created_at: Date.parse('2026-10-01T00:03:00Z'),
    content: JSON.stringify({ requestId: job.operation.id, ...route, proposal, decision }) }
  const maps = [{ id: 'map-test', title: '검토 문서', version: 7, nodes: [{ id: 'card-test', data: { kind: 'task', label: '검토 담당' } }], edges: [] }]
  const counts = { create: 0, dispatch: 0, link: 0, getDispatch: 0, messages: 0 }
  let now = 1_000_000
  const deps = { directory, now: () => now,
    read: async pathname => { try { return JSON.parse(await readFile(pathname, 'utf8')) } catch (failure) { if (failure.code === 'ENOENT') return {}; throw failure } },
    write: async (pathname, value) => writeFile(pathname, JSON.stringify(value)),
    user: async id => ({ id }), authorize: async () => {}, loadMaps: async () => maps,
    getDispatch: async () => { counts.getDispatch++; return dispatch }, messages: async () => { counts.messages++; return [
      { id: 'original-request', conversation_id: job.operation.conversationId, position: 'right', type: 'text',
        content: job.operation.prompt, created_at: Date.parse(job.createdAt) + 1_000 }, message,
    ] },
    manualResultEvidence: async (user, operation, current, resultMessage, messages) => doorayManualResultRecoveryEvidence({
      user, operation, job: current, message: resultMessage, messages, conversation, normalizeRuntime: (_id, value) => value.runtime,
    }),
    createConversation: async () => { counts.create++; throw Error('회수 중 AI 생성 금지') },
    dispatch: async () => { counts.dispatch++; throw Error('회수 중 AI 실행 금지') },
    linkReview: async () => { counts.link++; throw Error('회수 중 카드 연결 금지') },
  }
  const context = { job, message, conversation, dispatch, maps, deps, counts, file, directory, advanceClock: milliseconds => { now += milliseconds } }
  configure(context)
  job.operation.prompt = `요청 ID: ${job.operation.id}\n승인이나 실행 없이 대응 제안만 작성하세요.`
  await deps.write(file, { jobs: [job] })
  return { ...context, service: createDoorayResponseService(deps) }
}

test('실패 실행 뒤 수동 이어가기의 최종 제안은 같은 기록으로 회수하고 원문·실패 이력을 보존한다', async t => {
  const { service, job, file, counts } = await fixture(t)
  const before = structuredClone(job)
  const recovered = await service.recoverResult(job.userId, job.id, job.updatedAt)
  assert.equal(recovered.status, 'proposal')
  assert.equal(recovered.proposal, proposal)
  assert.equal(recovered.proposalSource, 'router')
  assert.equal(recovered.approval, null)
  assert.equal(recovered.canRecoverResult, false)
  assert.equal(recovered.error, '')
  const stored = JSON.parse(await readFile(file, 'utf8')).jobs[0]
  assert.deepEqual(stored.source, before.source)
  assert.deepEqual(stored.operation, before.operation)
  assert.equal(stored.resultRecovery.previousError, before.error)
  assert.equal(stored.resultRecovery.previousStatus, 'failed')
  assert.equal(stored.resultRecovery.dispatchState, 'failed')
  assert.equal(stored.resultRecovery.dispatchTurnId, 'original-failed-turn')
  assert.equal(stored.resultRecovery.resultBackendTurnId, 'manual-finished-turn')
  assert.equal(stored.resultRecovery.resultMessageId, 'final-message')
  assert.equal(stored.resultRecovery.method, 'manual-continuation')
  assert.equal(stored.completedAt, undefined, '제안 도착을 사용자의 대응 완료로 처리하지 않는다')
  assert.deepEqual(await service.recoverResult(job.userId, job.id, job.updatedAt), recovered)
  assert.equal(counts.getDispatch, 1, '같은 요청 재시도는 회수 receipt를 그대로 반환한다')
  assert.deepEqual({ create: counts.create, dispatch: counts.dispatch, link: counts.link }, { create: 0, dispatch: 0, link: 0 })
})

test('담당 검토 단계도 현재 담당 경로를 검증하고 접수 단계로 되돌리지 않는다', async t => {
  const { service, job, file, counts } = await fixture(t, context => {
    context.job.operation.kind = 'review'
    context.job.operation.id = 'response-test-review-3'
    context.dispatch.operationId = context.job.operation.id
    context.job.route = structuredClone(route)
    context.job.review = { conversationId: 'proposal-chat', machineId: 'main' }
    context.message.content = JSON.stringify({ requestId: context.job.operation.id, proposal, decision })
  })
  const recovered = await service.recoverResult(job.userId, job.id, job.updatedAt)
  assert.equal(recovered.status, 'proposal')
  assert.equal(recovered.proposalSource, 'review')
  assert.equal(recovered.route.cardId, 'card-test')
  assert.equal(recovered.conversationId, 'proposal-chat')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).jobs[0].operation.kind, 'review')
  assert.equal(counts.dispatch, 0)
})

test('질문·승인 대기 제안은 구조화된 구분을 유지하지만 회수로 승인 기록을 만들지 않는다', async t => {
  for (const [nextDecision, expected] of [
    [{ kind: 'input', reason: '확인할 사실이 있습니다.', questions: ['어떤 기준을 적용하나요?'], approval: null }, 'needs-input'],
    [{ kind: 'approval', reason: '구체적인 변경안의 사용자 동의만 필요합니다.', questions: [], approval: {
      title: '검토 결과 기록', scope: ['현재 담당 카드에 확인 결과를 기록한다.'], exclusions: ['구현·하위 위임은 제외한다.'],
    } }, 'needs-approval'],
  ]) {
    const { service, job } = await fixture(t, context => { context.message.content = JSON.stringify({ requestId: context.job.operation.id, ...route, proposal, decision: nextDecision }) })
    const result = await service.recoverResult(job.userId, job.id, job.updatedAt)
    assert.equal(result.status, expected)
    assert.deepEqual(result.decision, nextDecision)
    assert.equal(result.approval, null)
  }
})

test('담당 미지정의 최종 구성·질문 제안도 새 카드·AI 실행 없이 회수한다', async t => {
  const { service, job, counts } = await fixture(t, context => {
    context.message.content = JSON.stringify({ requestId: context.job.operation.id, action: 'clarify', proposal, decision })
  })
  const result = await service.recoverResult(job.userId, job.id, job.updatedAt)
  assert.equal(result.status, 'proposal')
  assert.equal(result.route, null)
  assert.equal(counts.create, 0)
  assert.equal(counts.dispatch, 0)
})

test('완료 메시지가 없는 실패 항목은 자동 조회 후에도 오류·원본을 유지하고 재실행하지 않는다', async t => {
  const { service, deps, job, file, counts, advanceClock } = await fixture(t)
  deps.messages = async () => { counts.messages++; return [] }
  const before = await readFile(file, 'utf8')
  await service.poll()
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal(counts.getDispatch, 1)
  await service.poll()
  assert.equal(counts.getDispatch, 1, '실패 결과 조회는 30초 간격으로 제한한다')
  advanceClock(30_000)
  await service.poll()
  assert.equal(counts.getDispatch, 2)
  assert.equal(await readFile(file, 'utf8'), before)
  await assert.rejects(service.recoverResult(job.userId, job.id, job.updatedAt), /완료 제안을 찾지 못했습니다/)
  assert.equal(counts.create, 0)
  assert.equal(counts.dispatch, 0)
})

test('수동 완료 답변은 백그라운드에서 회수하되 원래 실패 실행 자체를 completed로 바꾸지 않는다', async t => {
  const { service, file, dispatch, counts } = await fixture(t)
  await service.poll()
  const stored = JSON.parse(await readFile(file, 'utf8')).jobs[0]
  assert.equal(stored.status, 'proposal')
  assert.equal(stored.proposal, proposal)
  assert.equal(dispatch.state, 'failed')
  assert.equal(stored.resultRecovery.dispatchState, 'failed')
  assert.equal(counts.dispatch, 0)
})

test('만료된 실행 영수증은 원 지시·전용 대화·현재 요청의 최종 답변으로만 회수하고 재전송하지 않는다', async t => {
  // AionCore는 영수증이 없으면 EXTERNAL_DISPATCH_NOT_FOUND로 응답한다.
  for (const code of ['NOT_FOUND', 'EXTERNAL_DISPATCH_NOT_FOUND']) {
    const { service, job, file, counts } = await fixture(t, context => {
      context.deps.getDispatch = async () => { throw Object.assign(Error('expired'), { status: 404, code }) }
    })
    const result = await service.recoverResult(job.userId, job.id, job.updatedAt)
    assert.equal(result.proposal, proposal)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).jobs[0].resultRecovery.dispatchState, 'expired')
    assert.equal(counts.dispatch, 0)
  }
})

test('턴 ID 없는 답변은 원 지시 뒤에 사용자 입력이 없을 때만 원래 실행의 답변으로 회수한다', async t => {
  const { service, job, file, counts } = await fixture(t, context => { delete context.message.backend_turn_id })
  const result = await service.recoverResult(job.userId, job.id, job.updatedAt)
  assert.equal(result.proposal, proposal)
  const stored = JSON.parse(await readFile(file, 'utf8')).jobs[0].resultRecovery
  assert.equal(stored.resultTurnEvidence, 'single-request')
  assert.equal(stored.resultBackendTurnId, null)
  assert.equal(counts.dispatch, 0)
  const continued = await fixture(t, context => {
    delete context.message.backend_turn_id
    const readMessages = context.deps.messages
    context.deps.messages = async () => {
      const items = await readMessages()
      return [items[0], { id: 'manual-input', conversation_id: 'proposal-chat', position: 'right', type: 'text', content: '이어서 작성해 주세요.',
        created_at: Date.parse('2026-10-01T00:02:00Z') }, ...items.slice(1)]
    }
  })
  const before = await readFile(continued.file, 'utf8')
  await assert.rejects(continued.service.recoverResult(continued.job.userId, continued.job.id, continued.job.updatedAt))
  assert.equal(await readFile(continued.file, 'utf8'), before)
})

test('영수증 만료 뒤에도 턴 ID 없는 대화의 완료 답변을 자동 회수한다(본문 코드 블록 포함)', async t => {
  const nested = '## 대응안\n\n```bash\nnode app.mjs\n```\n\n끝.'
  const inputDecision = { kind: 'input', reason: '확인할 사실이 있습니다.', questions: ['어떤 기준인가요?'], approval: null }
  const { service, file, counts } = await fixture(t, c => {
    c.job.operation.kind = 'review'
    c.job.operation.id = 'response-test-review-0'
    c.job.route = structuredClone(route)
    c.job.review = { conversationId: 'proposal-chat', machineId: 'main' }
    c.job.error = '이번 요청의 AI 결과를 확인하지 못했습니다. 대화에서 답변을 확인한 후 상태를 다시 확인해 주세요.'
    c.deps.getDispatch = async () => { c.counts.getDispatch++; throw Object.assign(Error('expired'), { status: 404, code: 'EXTERNAL_DISPATCH_NOT_FOUND' }) }
    delete c.message.backend_turn_id
    c.message.content = `\`\`\`json\n${JSON.stringify({ requestId: c.job.operation.id, proposal: nested, decision: inputDecision }, null, 2)}\n\`\`\``
  })
  await service.poll()
  const stored = JSON.parse(await readFile(file, 'utf8')).jobs[0]
  assert.equal(stored.status, 'needs-input')
  assert.equal(stored.proposal, nested)
  assert.equal(stored.resultRecovery.dispatchState, 'expired')
  assert.equal(stored.resultRecovery.method, 'manual-continuation')
  assert.equal(stored.resultRecovery.resultTurnEvidence, 'single-request')
  assert.deepEqual({ create: counts.create, dispatch: counts.dispatch, link: counts.link }, { create: 0, dispatch: 0, link: 0 })
})

test('회수는 요청·대화·사용자·작업 위치·최종 메시지·현재 실행을 검증하고 거부 시 변경하지 않는다', async t => {
  const scenarios = [
    c => { c.dispatch.state = 'running' },
    c => { c.dispatch.operationId = 'different-request' },
    c => { c.dispatch.conversationId = 'different-chat' },
    c => { c.deps.authorize = async () => { throw Error('접근 불가') } },
    c => { c.deps.getDispatch = async () => { throw Object.assign(Error('expired'), { status: 404 }) } },
    c => { c.deps.getDispatch = async () => { throw Object.assign(Error('route'), { status: 404, code: 'ROUTE_NOT_FOUND' }) } },
    c => { c.message.content = JSON.stringify({ requestId: 'previous-request', ...route, proposal, decision }) },
    c => { c.message.position = 'right' }, c => { c.message.status = 'loading' }, c => { c.message.hidden = true },
    c => {
      // 원 지시 뒤에 사용자가 이어 쓴 대화에서 턴 ID 없는 답변
      delete c.message.backend_turn_id
      const readMessages = c.deps.messages
      c.deps.messages = async () => [...await readMessages(), { id: 'later-input', conversation_id: 'proposal-chat', position: 'right', type: 'text',
        content: '추가 요청', created_at: Date.parse('2026-10-01T00:04:00Z') }]
    },
    c => { c.message.conversation_id = 'different-chat' },
    c => { c.message.created_at = Date.parse('2026-09-01') },
    c => { c.deps.messages = async () => [c.message] },
    c => { const readMessages = c.deps.messages; c.deps.messages = async () => { const items = await readMessages(); items[0].content = '다른 회차의 지시'; return items } },
    c => { c.conversation.extra.mnpDoorayResponseId = 'different-response' },
    c => { c.conversation.extra.mnpDoorayUserId = 'different-user' },
    c => { c.conversation.extra.mnpDoorayOperationId = 'different-response-route-0' },
    c => { c.conversation.extra.workspace = 'different-workspace' },
    c => { c.conversation.runtime.state = 'running' }, c => { c.conversation.runtime.pending_confirmations = 1 },
    c => { c.conversation.runtime.task_status = 'running' }, c => { c.job.conversationPolicy = 'legacy' },
    c => { c.job.createdAt = 'invalid' },
    c => { c.job.userId = 'another-user' },
    c => { c.message.content = JSON.stringify({ requestId: c.job.operation.id, ...route, cardId: 'missing', proposal, decision }) },
    c => { c.message.content = JSON.stringify({ requestId: c.job.operation.id, ...route, proposal, decision: { kind: 'approval' } }) },
    c => { c.job.approval = { revision: 'approved-before' } }, c => { c.job.completedAt = '2026-10-01' },
  ]
  for (const configure of scenarios) {
    const { service, job, file, counts } = await fixture(t, configure)
    const before = await readFile(file, 'utf8')
    await assert.rejects(service.recoverResult('user-test', job.id, job.updatedAt))
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal(counts.create, 0)
    assert.equal(counts.dispatch, 0)
  }
})

test('완료된 실행의 답변을 해석하지 못한 실패는 턴 ID 없는 대화에서도 재실행 없이 회수한다', async t => {
  const unread = '이번 요청의 AI 결과를 확인하지 못했습니다. 대화에서 답변을 확인한 후 상태를 다시 확인해 주세요.'
  const nested = '## 대응안\n\n```bash\nnode app.mjs\n```\n\n끝.'
  const inputDecision = { kind: 'input', reason: '확인할 사실이 있습니다.', questions: ['어떤 기준인가요?'], approval: null }
  const configure = c => {
    c.job.operation.kind = 'review'
    c.job.operation.id = 'response-test-review-0'
    c.job.route = structuredClone(route)
    c.job.review = { conversationId: 'proposal-chat', machineId: 'main' }
    c.job.error = unread
    Object.assign(c.dispatch, { operationId: c.job.operation.id, state: 'completed', turnId: 'completed-turn', errorMessage: undefined })
    delete c.message.backend_turn_id
    c.message.content = `\`\`\`json\n${JSON.stringify({ requestId: c.job.operation.id, proposal: nested, decision: inputDecision }, null, 2)}\n\`\`\``
  }
  for (const run of [
    ({ service, job }) => service.recoverResult(job.userId, job.id, job.updatedAt),
    ({ service, job }) => service.retry(job.userId, job.id),
    ({ service }) => service.poll(),
  ]) {
    const context = await fixture(t, configure)
    await run(context)
    const stored = JSON.parse(await readFile(context.file, 'utf8')).jobs[0]
    assert.equal(stored.status, 'needs-input')
    assert.equal(stored.proposal, nested)
    assert.equal(stored.error, '')
    assert.equal(stored.resultRecovery.method, 'completed-dispatch')
    assert.equal(stored.resultRecovery.previousError, unread)
    assert.equal(stored.resultRecovery.dispatchTurnId, 'completed-turn')
    assert.deepEqual({ create: context.counts.create, dispatch: context.counts.dispatch, link: context.counts.link }, { create: 0, dispatch: 0, link: 0 })
  }
  // 실행이 완료되지 않았거나 다른 실패 사유면 수동 이어가기 검증을 적용해, 사용자가 이어 쓴 대화의 턴 ID 없는 답변을 회수하지 않는다.
  const continued = c => {
    const readMessages = c.deps.messages
    c.deps.messages = async () => [...await readMessages(), { id: 'later-input', conversation_id: 'proposal-chat', position: 'right', type: 'text',
      content: '추가 요청', created_at: Date.parse('2026-10-01T00:04:00Z') }]
  }
  for (const change of [c => { c.dispatch.state = 'failed' }, c => { c.job.error = '모델 실행 용량 초과' }]) {
    const { service, job, file, counts } = await fixture(t, c => { configure(c); change(c); continued(c) })
    const before = await readFile(file, 'utf8')
    await assert.rejects(service.recoverResult(job.userId, job.id, job.updatedAt))
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal(counts.dispatch, 0)
  }
})

test('회수 조회 중 후속 회차가 생기면 완료 제안을 이전 회차에 저장하지 않는다', async t => {
  const { service, deps, job, file, counts } = await fixture(t)
  const messages = deps.messages
  deps.messages = async operation => {
    await deps.write(file, { jobs: [{ ...job, operation: { ...job.operation, id: 'response-test-route-4-0' }, updatedAt: '2026-10-01T00:05:00Z' }] })
    return messages(operation)
  }
  await assert.rejects(service.recoverResult(job.userId, job.id, job.updatedAt), /변경되어/)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).jobs[0].operation.id, 'response-test-route-4-0')
  assert.equal(counts.dispatch, 0)
})
