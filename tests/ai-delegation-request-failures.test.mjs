import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createAiDelegationRequestFailures, safeDelegationFailureMessage, withDelegationTaskCompletion } from '../server/lib/aiDelegationRequestFailures.mjs'
import { aiDelegationDisplayItems, aiDelegationDisplaySections, aiDelegationStatusByCard, isVisibleAiDelegation } from '../src/utils/aiDelegationStatus.mjs'
import { groupDelegationPresentation } from '../src/utils/groupOverview.mjs'

const context = { requestId: 'request-1', delegationId: 'delegation-1', mapId: 'map-test', parentMapId: 'map-test',
  parentCardId: 'parent', targetCardId: 'child', targetHomeMachineId: 'mac', strategy: 'new', requestSignature: 'same-request', instruction: '비공개 지시 전문', taskSummary: '검수 요청' }
const failure = { status: 409, reasonCode: 'REMOTE_WORKSPACE_RUNNER_STALE', message: '원격 풀 보고가 만료됐습니다.' }

test('요청 실패는 실행과 별개로 직렬 저장하고 재시작 후에도 이유를 조회한다', async () => {
  let disk = []
  const dependencies = { filePath: 'isolated', readJson: async () => structuredClone(disk), writeJson: async (_file, records) => { disk = structuredClone(records) } }
  const ledger = await createAiDelegationRequestFailures(dependencies)
  await Promise.all([ledger.record(context, failure), ledger.record({ ...context, requestId: 'request-2' }, failure)])
  const restarted = await createAiDelegationRequestFailures(dependencies)
  const items = restarted.list({ mapId: 'map-test', delegations: new Map() })
  assert.equal(items.length, 2)
  assert.equal(items[0].status, 409)
  assert.equal(items[0].reasonCode, failure.reasonCode)
  assert.equal(items[0].message, failure.message)
  assert.equal(items[0].executionState, 'not-started')
  assert.equal(items[0].automaticRetry, false)
  assert.equal(JSON.stringify(disk).includes(context.instruction), false)
  assert.equal(items[0].requestSummary, '검수 요청')
  assert.equal(JSON.stringify(disk).includes('비공개 지시 전문'), false)
  assert.equal(isVisibleAiDelegation(items[0]), true)
  const badge = aiDelegationStatusByCard(items, 'map-test').parent
  assert.equal(badge.kind, 'request-failed')
  assert.equal(badge.activeCount, 0)
  assert.equal(badge.recoveryCount, 0)
})

test('전달 불확실 요청은 미실행으로 단정하지 않고 자동 재실행도 하지 않는다', async () => {
  const ledger = await createAiDelegationRequestFailures({ filePath: 'isolated', readJson: async () => [], writeJson: async () => {} })
  const item = await ledger.record({ ...context, dispatchStarted: true }, failure)
  assert.equal(item.executionState, 'unknown')
  assert.match(groupDelegationPresentation(item).label, /실행 여부 확인 필요/)
})

test('같은 요청의 실제 접수 이후에도 실패 이력은 남지만 현재 실패 표시는 해제한다', async () => {
  const ledger = await createAiDelegationRequestFailures({ filePath: 'isolated', readJson: async () => [], writeJson: async () => {} })
  await ledger.record(context, failure)
  const delegations = new Map([[context.delegationId, { ...context, id: context.delegationId, createdAt: '2999-01-01' }]])
  const items = ledger.list({ mapId: 'map-test', delegations })
  assert.equal(items.length, 1)
  assert.equal(items[0].resolvedByDelegationId, context.delegationId)
  assert.equal(aiDelegationDisplayItems([], items).length, 0)
  assert.equal(items[0].requestSignature, undefined)
  delegations.get(context.delegationId).requestSignature = 'different-request'
  assert.equal(ledger.list({ mapId: 'map-test', delegations })[0].resolvedByDelegationId, null)
})

function memoryLedger(initial = []) {
  let disk = structuredClone(initial)
  const dependencies = { filePath: 'isolated', readJson: async () => structuredClone(disk),
    writeJson: async (_file, records) => { disk = structuredClone(records) } }
  return { dependencies, disk: () => structuredClone(disk) }
}

test('완료 상세 삭제 전에 재접수 근거를 보존해 재시작 후 실패 경고가 되살아나지 않는다', async () => {
  const memory = memoryLedger()
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  await ledger.record(context, failure)
  const delegations = new Map([[context.delegationId, { ...context, id: context.delegationId, createdAt: '2999-01-01' }]])
  await ledger.preserveResolutionsBeforeCleanup(new Set([context.delegationId]), delegations)
  delegations.clear()
  const restarted = await createAiDelegationRequestFailures(memory.dependencies)
  const records = restarted.list({ mapId: 'map-test', delegations })
  assert.equal(records[0].resolvedByDelegationId, context.delegationId)
  assert.equal(aiDelegationDisplayItems([], records).length, 0)
  assert.equal(records[0].reasonCode, failure.reasonCode)
})

test('문서 영구 삭제는 대상·상위 문서에 속한 실패 기록을 지우고 다른 기록은 재시작 뒤에도 보존한다', async () => {
  const memory = memoryLedger()
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  await ledger.record({ ...context, requestId: 'target', mapId: 'map-delete', parentMapId: 'map-keep' }, failure)
  await ledger.record({ ...context, requestId: 'parent', mapId: 'map-keep', parentMapId: 'map-delete' }, failure)
  await ledger.record({ ...context, requestId: 'keep', mapId: 'map-keep', parentMapId: 'map-other' }, failure)
  const retained = ledger.get('keep')

  assert.equal(await ledger.purgeMaps(new Set(['map-delete'])), 2)
  assert.deepEqual(memory.disk(), [retained])
  const restarted = await createAiDelegationRequestFailures(memory.dependencies)
  assert.deepEqual(restarted.list({ mapId: 'map-delete', delegations: new Map() }), [])
  assert.deepEqual(restarted.get('keep'), retained)
})

test('삭제할 실패 기록이 없거나 같은 삭제를 반복해도 늦은 대상·상위 문서 실패 기록을 다시 만들지 않는다', async () => {
  const memory = memoryLedger()
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  assert.equal(await ledger.purgeMaps(['map-delete', 'map-delete']), 0)
  assert.equal(await ledger.purgeMaps([]), 0)
  assert.equal(await ledger.purgeMaps(['map-delete']), 0)
  assert.equal(await ledger.record({ ...context, mapId: 'map-delete' }, failure), null)
  assert.equal(await ledger.record({ ...context, parentMapId: 'map-delete' }, failure), null)
  assert.deepEqual(memory.disk(), [])
  const retained = await ledger.record({ ...context, requestId: 'keep' }, failure)
  assert.equal(retained.id, 'keep')
  assert.equal(memory.disk().length, 1)
})

test('진행 중 저장·영구 삭제·늦은 실패 기록을 같은 큐에서 처리해 삭제된 기록이 되살아나지 않는다', async () => {
  const memory = memoryLedger()
  const writeJson = memory.dependencies.writeJson
  let releaseWrite
  let markWriting
  const writing = new Promise(resolve => { markWriting = resolve })
  const blocked = new Promise(resolve => { releaseWrite = resolve })
  let writes = 0
  memory.dependencies.writeJson = async (file, records) => {
    if (++writes === 1) { markWriting(); await blocked }
    return writeJson(file, records)
  }
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  const beforeDelete = ledger.record({ ...context, requestId: 'before', mapId: 'map-delete' }, failure)
  await writing
  const deletion = ledger.purgeMaps(['map-delete'])
  const late = ledger.record({ ...context, requestId: 'late', parentMapId: 'map-delete' }, failure)
  const unrelated = ledger.record({ ...context, requestId: 'keep' }, failure)
  releaseWrite()
  await beforeDelete
  assert.equal(await deletion, 1)
  assert.equal(await late, null)
  await unrelated
  assert.deepEqual(memory.disk(), [ledger.get('keep')])
  assert.equal(ledger.get('before'), null)
  assert.equal(writes, 3)
})

test('영구 삭제 저장이 실패하면 기존 기록을 유지하고 같은 큐에서 다시 삭제할 수 있다', async () => {
  const memory = memoryLedger()
  const writeJson = memory.dependencies.writeJson
  let failNextWrite = false
  memory.dependencies.writeJson = async (file, records) => {
    if (failNextWrite) { failNextWrite = false; throw new Error('삭제 저장 실패') }
    return writeJson(file, records)
  }
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  await ledger.record({ ...context, requestId: 'delete', mapId: 'map-delete' }, failure)
  await ledger.record({ ...context, requestId: 'keep' }, failure)
  const before = memory.disk()
  failNextWrite = true

  await assert.rejects(ledger.purgeMaps(['map-delete']), /삭제 저장 실패/)
  assert.deepEqual(memory.disk(), before)
  assert.deepEqual(ledger.get('delete'), before[0])
  assert.equal((await ledger.record({ ...context, requestId: 'before-retry', mapId: 'map-delete' }, failure)).id, 'before-retry')
  assert.equal(await ledger.purgeMaps(['map-delete']), 2)
  assert.deepEqual(memory.disk(), [before[1]])
  assert.equal(await ledger.record({ ...context, mapId: 'map-delete' }, failure), null)
})

test('미접수 요청 종료는 원 오류를 보존하고 재시작·재확인·반복 요청에도 경고를 다시 만들지 않는다', async () => {
  const memory = memoryLedger()
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  const failed = await ledger.record(context, failure)
  const original = memory.disk()[0]
  const command = { mapId: context.mapId, failureId: failed.id, expectedUpdatedAt: failed.updatedAt,
    reason: 'no-longer-needed', note: '분기 대화를 삭제해 더 이상 진행하지 않습니다.', confirmNotExecuted: true, actorId: 'editor' }
  const executions = new Map()
  const result = await ledger.close(command, executions)
  assert.equal(result.repeated, false)
  assert.equal(result.requestFailure.retryVerification.state, 'closed')
  assert.equal(result.requestFailure.resolvedByDelegationId, null)
  assert.equal(result.requestFailure.retryReference, undefined)
  assert.equal(result.requestFailure.state, 'request-failed')
  assert.equal(result.requestFailure.requestClosure.actorId, 'editor')
  assert.equal(isVisibleAiDelegation(result.requestFailure), false)
  assert.deepEqual(aiDelegationDisplayItems([], [result.requestFailure]), [])
  assert.deepEqual(aiDelegationStatusByCard([result.requestFailure], context.mapId), {})
  assert.deepEqual({ ...memory.disk()[0], updatedAt: original.updatedAt, requestClosure: undefined }, { ...original, requestClosure: undefined })
  const saved = memory.disk()
  assert.equal((await ledger.close({ ...command, actorId: 'another-editor' }, executions)).repeated, true)
  assert.deepEqual(memory.disk(), saved)
  await assert.rejects(ledger.close({ ...command, note: '다른 종료 사유' }, executions), { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_CLOSED' })
  await assert.rejects(ledger.resolve(command, executions), { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_CLOSED' })
  assert.throws(() => ledger.validateRetry(context, failed.id, executions), { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_CLOSED' })
  const restarted = await createAiDelegationRequestFailures(memory.dependencies)
  // 이후 별도 요청이 접수돼도 사용자 종료를 정상 재접수로 바꾸지 않는다.
  executions.set(context.delegationId, { ...context, id: context.delegationId, createdAt: '2999-01-01' })
  const checked = await restarted.recheck(command, executions)
  assert.equal(checked.requestFailure.retryVerification.state, 'closed')
  assert.equal(checked.requestFailure.resolvedByDelegationId, null)
  assert.deepEqual(memory.disk(), saved)
})

test('미접수 종료는 권한·확인·최신 상태·미실행을 검사하고 실제 재접수를 숨기지 않는다', async () => {
  const ledger = await createAiDelegationRequestFailures(memoryLedger().dependencies)
  const failed = await ledger.record(context, failure)
  const command = { mapId: context.mapId, failureId: failed.id, expectedUpdatedAt: failed.updatedAt,
    reason: 'cancelled', note: '사용자 요청 취소', confirmNotExecuted: true, actorId: 'editor' }
  for (const patch of [{ actorId: '' }, { confirmNotExecuted: false }, { reason: 'arbitrary' }, { note: ' ' }, { note: 'x'.repeat(1001) }, { expectedUpdatedAt: 'stale' }, { mapId: 'other' }]) {
    await assert.rejects(ledger.close({ ...command, ...patch }, new Map()))
  }
  const unknown = await ledger.record({ ...context, requestId: 'unknown', dispatchStarted: true }, failure)
  await assert.rejects(ledger.close({ ...command, failureId: unknown.id, expectedUpdatedAt: unknown.updatedAt }, new Map()), { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_EXECUTION_UNCERTAIN' })
  const executions = new Map([[context.delegationId, { ...context, id: context.delegationId, createdAt: '2999-01-01' }]])
  await assert.rejects(ledger.close(command, executions), { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_ALREADY_RESOLVED' })
  assert.equal(ledger.get(failed.id).requestClosure, undefined)
})

test('재접수 해제와 사용자 종료가 경합하면 먼저 확정된 감사 기록만 유지한다', async () => {
  const ledger = await createAiDelegationRequestFailures(memoryLedger().dependencies)
  const failed = await ledger.record(context, failure)
  const common = { mapId: context.mapId, failureId: failed.id, expectedUpdatedAt: failed.updatedAt, actorId: 'editor' }
  const executions = new Map([['later', { ...context, id: 'later', requestSignature: 'different', createdAt: '2999-01-01' }]])
  const results = await Promise.allSettled([
    ledger.close({ ...common, reason: 'cancelled', note: '사용자 취소 결정', confirmNotExecuted: true }, executions),
    ledger.resolve({ ...common, replacementDelegationId: 'later', confirmSameWork: true, note: '재접수 확인' }, executions),
  ])
  assert.deepEqual(results.map(item => item.status), ['fulfilled', 'rejected'])
  assert.equal(ledger.get(failed.id).resolution, undefined)
  assert.ok(ledger.get(failed.id).requestClosure)
})

test('버전 충돌 뒤 키·서명이 바뀌어도 동일 지시·상위·머신의 정상 재접수는 표시를 해제한다', async () => {
  const memory = memoryLedger()
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  const original = await ledger.record({ ...context, parentConversationId: 'parent-conversation' }, {
    ...failure, reasonCode: 'AI_DELEGATION_VERSION_CONFLICT',
  })
  const accepted = { ...context, id: 'revision-2', requestSignature: 'changed-revision',
    parentConversationId: 'parent-conversation', strategy: original.strategy,
    instructionHash: createHash('sha256').update(context.instruction).digest('hex'),
    state: 'running', createdAt: '2999-01-01' }
  const originals = structuredClone(accepted)
  const delegations = new Map([[accepted.id, accepted]])
  const item = ledger.list({ mapId: context.mapId, delegations })[0]
  assert.equal(item.resolvedByDelegationId, accepted.id)
  assert.equal(aiDelegationStatusByCard([item], context.mapId)[context.parentCardId], undefined)
  assert.equal(item.instructionHash, undefined)
  assert.equal(item.requestSignature, undefined)
  assert.deepEqual(accepted, originals)
  const restarted = await createAiDelegationRequestFailures(memory.dependencies)
  assert.equal(restarted.list({ mapId: context.mapId, delegations })[0].resolvedByDelegationId, accepted.id)
  for (const delta of [{ instructionHash: 'different-work' }, { parentConversationId: 'another-parent' },
    { targetHomeMachineId: 'another-machine' }, { targetCardId: 'another-card' }, { strategy: 'resume' },
    { createdAt: '2000-01-01' }]) {
    delegations.set(accepted.id, { ...accepted, ...delta })
    assert.equal(ledger.list({ mapId: context.mapId, delegations })[0].resolvedByDelegationId, null)
  }
})

test('실행 불확실·다른 오류·근거 없는 레거시는 새 키의 접수로 자동 해제하지 않는다', async () => {
  for (const mode of ['unknown', 'other-error', 'legacy']) {
    const memory = memoryLedger()
    const ledger = await createAiDelegationRequestFailures(memory.dependencies)
    await ledger.record({ ...context, parentConversationId: mode === 'legacy' ? undefined : 'parent',
      dispatchStarted: mode === 'unknown' }, { ...failure,
      reasonCode: mode === 'other-error' ? failure.reasonCode : 'AI_DELEGATION_VERSION_CONFLICT' })
    const accepted = { ...context, id: 'new-key', requestSignature: 'new-signature', parentConversationId: 'parent',
      instructionHash: createHash('sha256').update(context.instruction).digest('hex'), createdAt: '2999-01-01' }
    assert.equal(ledger.list({ mapId: context.mapId, delegations: new Map([[accepted.id, accepted]]) })[0].resolvedByDelegationId, null)
  }
})

test('레거시 실패는 명시 확인으로 진행 중 재접수에 연결하고 원 오류·실행을 보존한다', async () => {
  const memory = memoryLedger()
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  const record = await ledger.record(context, failure)
  const accepted = { ...context, id: 'new-key', requestSignature: 'new-signature', state: 'running', createdAt: '2999-01-01' }
  const before = structuredClone(accepted)
  const delegations = new Map([[accepted.id, accepted]])
  const body = { mapId: context.mapId, failureId: record.id, replacementDelegationId: accepted.id,
    expectedUpdatedAt: record.updatedAt, confirmSameWork: true, note: '승인된 동일 업무 재접수 확인', actorId: 'editor' }
  for (const patch of [{ expectedUpdatedAt: 'stale' }, { confirmSameWork: false },
    { replacementDelegationId: 'missing' }, { mapId: 'other-map' }]) {
    await assert.rejects(ledger.resolve({ ...body, ...patch }, delegations))
  }
  for (const patch of [{ targetCardId: 'another-card' }, { targetHomeMachineId: 'another-machine' },
    { parentCardId: 'another-parent' }, { mapId: 'another-map' }, { parentMapId: 'another-parent-map' },
    { createdAt: '2000-01-01' }, { requestSignature: null }]) {
    delegations.set(accepted.id, { ...accepted, ...patch })
    await assert.rejects(ledger.resolve(body, delegations), { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_REPLACEMENT_INVALID' })
  }
  delegations.set(accepted.id, accepted)
  const result = await ledger.resolve(body, delegations)
  assert.equal(result.repeated, false)
  assert.equal(result.requestFailure.resolvedByDelegationId, accepted.id)
  assert.equal(result.requestFailure.state, 'request-failed')
  assert.equal(result.requestFailure.message, failure.message)
  assert.equal(result.requestFailure.resolution.actorId, 'editor')
  assert.deepEqual(delegations.get(accepted.id), before)
  assert.equal((await ledger.resolve(body, delegations)).repeated, true)
  await assert.rejects(ledger.resolve({ ...body, replacementDelegationId: 'another' }, delegations),
    { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_ALREADY_RESOLVED' })
  const restarted = await createAiDelegationRequestFailures(memory.dependencies)
  assert.equal(restarted.list({ mapId: context.mapId, delegations })[0].resolvedByDelegationId, accepted.id)
  assert.equal(memory.disk().length, 1)
})

test('실행 여부가 불확실한 실패는 사용자 확인이 있어도 해제하지 않는다', async () => {
  const ledger = await createAiDelegationRequestFailures(memoryLedger().dependencies)
  const record = await ledger.record({ ...context, dispatchStarted: true }, failure)
  const accepted = { ...context, id: 'new-key', createdAt: '2999-01-01' }
  await assert.rejects(ledger.resolve({ mapId: context.mapId, failureId: record.id, expectedUpdatedAt: record.updatedAt,
    replacementDelegationId: accepted.id, confirmSameWork: true, note: '재접수 확인', actorId: 'editor' },
  new Map([[accepted.id, accepted]])), { reasonCode: 'AI_DELEGATION_REQUEST_FAILURE_EXECUTION_UNCERTAIN' })
})

test('실행 완료와 카드 업무 미완료는 분리하고 기존 완료 상태·원문은 바꾸지 않는다', () => {
  const delegation = { id: 'completed', state: 'completed', mapId: 'map-test', parentCardId: 'parent', targetCardId: 'child', result: '조사 완료, 기록 미완료', workCompleted: true }
  const map = { nodes: [{ id: 'child', data: { isWork: true, status: 'planned', progress: 0 } }] }
  const originals = structuredClone({ delegation, map })
  const item = withDelegationTaskCompletion(delegation, map)
  assert.equal(item.state, 'completed')
  assert.equal(item.workCompleted, true)
  assert.equal(item.taskCompletion.state, 'incomplete')
  assert.equal(isVisibleAiDelegation(item), false, '과거 완료 기록 자체는 현재 현황으로 표시하지 않는다')
  const attention = aiDelegationDisplaySections([item]).currentItems[0]
  assert.equal(isVisibleAiDelegation(attention), true)
  const badge = aiDelegationStatusByCard([item], 'map-test').parent
  assert.equal(badge.kind, 'attention')
  assert.equal(badge.activeCount, 0)
  assert.equal(badge.recoveryCount, 0)
  assert.equal(groupDelegationPresentation(attention).tone, 'warning')
  assert.deepEqual({ delegation, map }, originals)
  map.nodes[0].data = { isWork: true, status: 'done', progress: 100 }
  assert.equal(isVisibleAiDelegation(withDelegationTaskCompletion(delegation, map)), false)
})

test('실패 메시지에서 토큰과 지시 전문을 제외한다', () => {
  const text = safeDelegationFailureMessage(`Bearer example-secret; password=private ${context.instruction}`, context.instruction)
  assert.doesNotMatch(text, /example-secret|password=private|비공개 지시 전문/)
})

test('재접수 참조는 원 지시·귀속·실행 여부를 검증하며 중복 접수를 거부한다', async () => {
  const ledger = await createAiDelegationRequestFailures(memoryLedger().dependencies)
  const original = { ...context, parentConversationId: 'parent-conversation', requestedConversationId: 'child-conversation', strategy: 'resume' }
  const failed = await ledger.record(original, failure)
  assert.equal(failed.retryReference.requestId, failed.id)
  const next = { ...original, delegationId: 'retry', requestSignature: 'new-revision' }
  assert.equal(ledger.validateRetry(next, failed.id, new Map()), failed.id)
  for (const patch of [{ instruction: '다른 업무' }, { parentConversationId: 'other' }, { requestedConversationId: 'other' },
    { targetHomeMachineId: 'other' }, { targetCardId: 'other' }, { parentCardId: 'other' }, { parentMapId: 'other' }, { strategy: 'new' }]) {
    assert.throws(() => ledger.validateRetry({ ...next, ...patch }, failed.id, new Map()), { reasonCode: 'AI_DELEGATION_RETRY_REFERENCE_INVALID' })
  }
  const accepted = { ...next, id: 'retry', createdAt: '2999-01-01', targetConversationId: 'child-conversation',
    instructionHash: createHash('sha256').update(next.instruction).digest('hex'), retryOfRequestId: failed.id, state: 'running' }
  const delegations = new Map([[accepted.id, accepted]])
  assert.equal(ledger.list({mapId: context.mapId, delegations})[0].retryVerification.method, 'retry-reference')
  assert.throws(() => ledger.validateRetry({ ...next, delegationId: 'another-retry' }, failed.id, delegations), { reasonCode: 'AI_DELEGATION_RETRY_ALREADY_ACCEPTED' })
  assert.equal(ledger.validateRetry(next, failed.id, delegations), failed.id)
})

test('재접수 확인은 근거 없는 후보를 고르지 않고 확인된 접수만 감사 이력으로 남긴다', async () => {
  const memory = memoryLedger()
  const ledger = await createAiDelegationRequestFailures(memory.dependencies)
  const original = { ...context, parentConversationId: 'parent-conversation' }
  const failed = await ledger.record(original, { ...failure, reasonCode: 'AI_DELEGATION_ALREADY_ACTIVE' })
  const query = { mapId: context.mapId, failureId: failed.id, expectedUpdatedAt: failed.updatedAt, actorId: 'editor' }
  const delegations = new Map()
  assert.equal((await ledger.recheck(query, delegations)).requestFailure.retryVerification.state, 'not-found')
  const candidate = { ...original, id: 'later', state: 'running', createdAt: '2999-01-01', instructionHash: 'different' }
  delegations.set(candidate.id, candidate)
  assert.equal((await ledger.recheck(query, delegations)).requestFailure.retryVerification.state, 'unverified')
  assert.equal(memory.disk()[0].resolution, undefined)
  candidate.instructionHash = createHash('sha256').update(original.instruction).digest('hex')
  const before = structuredClone(candidate)
  const result = await ledger.recheck(query, delegations)
  assert.equal(result.requestFailure.retryVerification.state, 'confirmed')
  assert.equal(result.requestFailure.retryVerification.replacement.state, 'running')
  assert.equal(result.requestFailure.resolution.method, 'same-instruction')
  assert.deepEqual(candidate, before)
  assert.equal((await ledger.recheck(query, delegations)).requestFailure.resolvedByDelegationId, candidate.id)
  const restarted = await createAiDelegationRequestFailures(memory.dependencies)
  assert.equal(restarted.list({mapId: context.mapId, delegations})[0].resolvedByDelegationId, candidate.id)
})

test('연속 접수 실패의 참조 체인은 원 요청까지 해제하고 실행 불확실 체인은 허용하지 않는다', async () => {
  const ledger = await createAiDelegationRequestFailures(memoryLedger().dependencies)
  const original = { ...context, parentConversationId: 'parent-conversation' }
  const first = await ledger.record(original, failure)
  const second = await ledger.record({ ...original, requestId: 'request-2', retryOfRequestId: first.id }, failure)
  const accepted = { ...original, id: 'retry', requestSignature: 'new-signature', state: 'waiting-workspace', createdAt: '2999-01-01',
    instructionHash: createHash('sha256').update(original.instruction).digest('hex'), retryOfRequestId: second.id }
  assert.ok(ledger.list({mapId: context.mapId, delegations: new Map([[accepted.id, accepted]])}).every(item => item.resolvedByDelegationId === accepted.id))
  const unknown = await ledger.record({ ...original, requestId: 'request-unknown', dispatchStarted: true }, failure)
  assert.equal(unknown.retryReference, undefined)
  assert.throws(() => ledger.validateRetry(original, unknown.id, new Map()), { reasonCode: 'AI_DELEGATION_RETRY_REFERENCE_INVALID' })
})

test('위임 규칙이 이어가기를 새 대화로 바꾼 재접수도 같은 업무로 확인하고, 근거 없는 후보는 여전히 고르지 않는다', async () => {
  // 2026-11-09 운영 사례: resume 요청이 문서 버전 충돌로 실패한 뒤 같은 지시로 재접수됐고, 서버가 위임 규칙 모델과 다른 대화라 새 대화로 바꿨다.
  const ledger = await createAiDelegationRequestFailures(memoryLedger().dependencies)
  const original = { ...context, parentConversationId: 'parent-conversation', requestedConversationId: 'old-conversation', strategy: 'resume' }
  const versionConflict = { status: 409, reasonCode: 'AI_DELEGATION_VERSION_CONFLICT', message: '문서가 변경되었습니다.' }
  const failed = await ledger.record(original, versionConflict)
  const instructionHash = createHash('sha256').update(original.instruction).digest('hex')
  // 접수 때는 전환 전 요청으로 재접수 참조를 검증한다.
  assert.equal(ledger.validateRetry({ ...original, delegationId: 'retry', requestSignature: 'rev52' }, failed.id, new Map()), failed.id)
  const converted = { ...original, id: 'retry', requestSignature: 'rev52', state: 'completed', createdAt: '2999-01-01', instructionHash,
    strategy: 'new', targetConversationId: 'new-conversation' }
  const verify = (delegation) => ledger.list({ mapId: context.mapId, delegations: new Map([[delegation.id, delegation]]) })[0].retryVerification

  // 재접수 참조가 있으면 전환 기록이 없는 이전 기록(운영 rev52)도 확인한다.
  assert.deepEqual([verify({ ...converted, retryOfRequestId: failed.id }).state, verify({ ...converted, retryOfRequestId: failed.id }).method], ['confirmed', 'retry-reference'])
  // 참조 없이 다시 접수한 경우는 전환 기록의 원래 대화로 비교한다.
  const recorded = { ...converted, aiPolicyResumeConversion: { conversationId: 'old-conversation', currentModelId: 'opus', expectedModelId: 'gpt-6.1-sol' } }
  assert.deepEqual([verify(recorded).state, verify(recorded).method], ['confirmed', 'same-instruction'])
  // 전환 기록도 참조도 없으면 다른 업무일 수 있으므로 확인하지 않는다.
  assert.equal(verify(converted).state, 'unverified')
  assert.equal(verify({ ...recorded, aiPolicyResumeConversion: { conversationId: 'other-conversation' } }).state, 'unverified')
  // 참조가 있어도 지시·상위 대화가 다르면 확인하지 않는다.
  assert.equal(verify({ ...converted, retryOfRequestId: failed.id, instructionHash: 'different' }).state, 'unverified')
  assert.equal(verify({ ...converted, retryOfRequestId: failed.id, parentConversationId: 'other' }).state, 'unverified')
})
