import assert from 'node:assert/strict'
import test from 'node:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { storageApi } from './helpers/storage-api-harness.mjs'
import { newStorageRequestId, storageHash } from '../server/lib/storageJournal.mjs'

const mapId = 'map-bench-0'
const route = `/api/maps/${mapId}`
const key = (id) => ({ 'Idempotency-Key': id })
const query = (api, id, headers = {}) => api.call(route, 'PATCH', undefined, { ...key(id), 'X-MNP-Result-Only': '1', ...headers })

test('commit marker 교체 뒤 오류가 전달돼도 marker를 재확인해 확정 결과로 수렴한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const marker = `_storage-transactions/request-${storageHash(id)}/commit.json`
  const barrier = await api.barrier(marker, 'rename', { fail: true, failAfter: true })
  const operation = api.call(route, 'PATCH', { title: 'marker 재확인', baseVersion: 1 }, key(id))
  await barrier.reached; barrier.release()
  const result = await operation
  assert.equal(result.body.outcome, 'committed', JSON.stringify(result))
  assert.equal((await api.read(`${mapId}.json`)).version, 2)
  await api.restart()
  assert.equal((await query(api, id)).body.transactionId, result.body.transactionId)
})

test('알림 파일과 effect applied marker 이후 강제 종료해도 재시작에서 재생성하지 않는다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  await api.crash('after-applied', { effect: true })
  await api.call(`${route}/comments`, 'POST', { nodeId: 'card-1', text: '@다른 편집자 효과 확정' }, key(id)).catch(() => null)
  await api.restart()
  const result = await query(api, id)
  assert.equal(result.body.outcome, 'committed')
  assert.deepEqual(result.body.sideEffectsPending, [])
  const notifications = await api.read('_notifications/user-second.json')
  assert.equal(notifications.filter((n) => n.commentId === result.body.comment.id).length, 1)
})

test('미완료 알림은 영속 재개하며 표시 목록에서 제거돼도 effect 기록으로 중복을 막는다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const barrier = await api.barrier('_storage-transactions/effect-', 'writeFile', { prefix: true, fail: true })
  const changing = api.call(`${route}/comments`, 'POST', { nodeId: 'card-1', text: '@다른 편집자 후속 처리 실패' }, key(id))
  await barrier.reached; barrier.release()
  const pending = await changing
  assert.equal(pending.body.outcome, 'committed', JSON.stringify(pending))
  assert.ok(pending.body.sideEffectsPending.length > 0)
  await api.restart()
  const committed = await query(api, id)
  assert.deepEqual(committed.body.sideEffectsPending, [])
  const transaction = committed.body.transactionId
  const intent = await api.read(`_storage-transactions/${transaction}/intent.json`)
  const effect = intent.effects.find((item) => item.kind === 'notification' && item.payload.user.id === 'user-second')
  assert.ok(effect)
  await api.stop()
  const ack = await api.read(`_storage-transactions/${transaction}/effects.json`)
  ack.done = ack.done.filter((value) => value !== effect.id)
  await writeFile(path.join(api.data, '_storage-transactions', transaction, 'effects.json'), JSON.stringify(ack))
  const trimmed = Array.from({ length: 200 }, (_, i) => ({ id: `later-${i}`, userId: 'user-second', type: 'mention', createdAt: new Date().toISOString() }))
  await writeFile(path.join(api.data, '_notifications/user-second.json'), JSON.stringify(trimmed))
  await api.restart()
  assert.deepEqual(await api.read('_notifications/user-second.json'), trimmed)
  assert.deepEqual((await query(api, id)).body.sideEffectsPending, [])
})

test('알림 반영과 redo가 모두 실패해도 확정된 부모 문서는 조회되며 재시작 후 효과만 복구한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const notificationFile = '_notifications/user-second.json'
  const first = await api.barrier(notificationFile, 'rename', { fail: true })
  const redo = await api.barrier(notificationFile, 'rename', { fail: true })
  const body = { nodeId: 'card-1', text: '@다른 편집자 후속 효과 복구 실패 검수' }
  const saving = api.call(`${route}/comments`, 'POST', body, key(id))
  await first.reached; first.release()
  await redo.reached; redo.release()
  const committed = await saving
  assert.equal(committed.status, 201)
  assert.equal(committed.body.outcome, 'committed')
  assert.equal(committed.body.sideEffectsPending.length, 1)
  const effectId = committed.body.sideEffectsPending[0]
  const effectDirectory = `_storage-transactions/effect-${storageHash(effectId)}`
  const intent = await api.read(`${effectDirectory}/intent.json`)
  const document = await api.call(route)
  const comments = await api.call(`${route}/comments`)
  const other = await api.call(`/api/maps/${api.ids[1]}`)
  const lookup = await query(api, id)
  t.diagnostic(JSON.stringify({ phase: '효과 복구 대기', outcome: committed.body.outcome,
    documentStatus: document.status, commentsStatus: comments.status, otherStatus: other.status,
    resultStatus: lookup.status, pending: committed.body.sideEffectsPending.length,
    effectKeys: intent.keys, effectFiles: intent.files.map(({ path, key }) => ({ path, key })) }))
  assert.equal(document.status, 200, JSON.stringify(document))
  assert.equal(comments.status, 200, JSON.stringify(comments))
  assert.equal(other.status, 200)
  assert.deepEqual(intent.keys, ['notification:user-second'])
  assert.deepEqual(intent.files.map((entry) => entry.path), [notificationFile])
  assert.ok((await api.read(`${effectDirectory}/commit.json`)).intentSha256)
  await assert.rejects(readFile(path.join(api.data, effectDirectory, 'applied.json')), { code: 'ENOENT' })
  const blocked = await api.call('/api/notifications', 'GET', undefined, { 'X-MNP-AI-Editor-Id': 'user-second' })
  assert.equal(blocked.status, 503)
  assert.equal(blocked.body.code, 'RECOVERY_REQUIRED')
  assert.equal(comments.body.comments.filter((item) => item.id === committed.body.comment.id).length, 1)
  for (const result of [lookup, await api.call(`${route}/comments`, 'POST', body, key(id))]) {
    assert.equal(result.status, 201)
    assert.equal(result.body.outcome, 'committed')
    assert.equal(result.body.transactionId, committed.body.transactionId)
    assert.deepEqual(result.body.comment, committed.body.comment)
    assert.deepEqual(result.body.resources, committed.body.resources)
    assert.deepEqual(result.body.sideEffectsPending, [effectId])
  }
  assert.equal((await api.read(`_comments/${mapId}.json`)).length, 1)
  const exit = await api.restart()
  assert.equal(exit.signal, 'SIGKILL')
  assert.equal((await api.call(route)).status, 200)
  assert.equal((await api.call(`${route}/comments`)).body.comments.length, 1)
  assert.ok((await api.read(`${effectDirectory}/applied.json`)).terminalAt)
  const notifications = await api.call('/api/notifications', 'GET', undefined, { 'X-MNP-AI-Editor-Id': 'user-second' })
  assert.equal(notifications.status, 200)
  assert.equal(notifications.body.notifications.filter((item) => item.commentId === committed.body.comment.id).length, 1)
  for (const result of [await query(api, id), await api.call(`${route}/comments`, 'POST', body, key(id))]) {
    assert.equal(result.status, 201)
    assert.equal(result.body.outcome, 'committed')
    assert.equal(result.body.transactionId, committed.body.transactionId)
    assert.deepEqual(result.body.comment, committed.body.comment)
    assert.deepEqual(result.body.resources, committed.body.resources)
    assert.deepEqual(result.body.sideEffectsPending, [])
  }
  assert.equal((await api.read(`_comments/${mapId}.json`)).length, 1)
  assert.equal((await api.read(notificationFile)).filter((item) => item.commentId === committed.body.comment.id).length, 1)
  t.diagnostic(JSON.stringify({ phase: '재시작 복구 완료', documentStatus: 200, notificationStatus: 200,
    comments: 1, notifications: 1, pending: 0, transactionId: committed.body.transactionId }))
})

test('실패한 오래된 일일 backup 후속 처리는 더 최신 버전을 덮지 않는다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 }), id = newStorageRequestId()
  const barrier = await api.barrier('_storage-transactions/effect-', 'writeFile', { prefix: true, fail: true })
  const changing = api.call(route, 'PATCH', { title: '버전 2', baseVersion: 1 }, key(id))
  await barrier.reached; barrier.release()
  const pending = await changing
  assert.ok(pending.body.sideEffectsPending.length)
  assert.equal((await api.call(route, 'PATCH', { title: '버전 3', baseVersion: 2 }, key(newStorageRequestId()))).status, 200)
  await api.restart()
  const files = (await readdir(path.join(api.data, '_daily-backups', mapId))).filter((file) => file.endsWith('.json'))
  const backup = await api.read(`_daily-backups/${mapId}/${files.at(-1)}`)
  assert.equal(backup.map.version, 3)
  assert.equal(backup.map.title, '버전 3')
  assert.deepEqual((await query(api, id)).body.sideEffectsPending, [])
})

test('인증 토큰 갱신은 같은 귀속의 결과를 유지하고 다른 귀속은 노출하지 않는다', { timeout: 30_000 }, async (t) => {
  const tokens = ['fixture-token-first', 'fixture-token-renewed', 'fixture-token-other']
  const api = await storageApi(t, { documents: 3, seed: async ({ data }) => {
    const entries = tokens.map((token, i) => ({ tokenHash: storageHash(token), authorName: 'Fixture AI(fixture)',
      startedBy: 'user-editor', mapId, cardId: i === 2 ? 'card-2' : 'card-1', conversationId: 'fixture-conversation',
      createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 }))
    await writeFile(path.join(data, '_ai-attributions.json'), JSON.stringify(entries))
  } })
  const id = newStorageRequestId()
  const first = await api.call(route, 'PATCH', { title: '토큰 갱신', baseVersion: 1 }, { ...key(id), 'X-MNP-AI-Attribution': tokens[0] })
  assert.equal(first.status, 200, JSON.stringify(first))
  const renewed = await query(api, id, { 'X-MNP-AI-Attribution': tokens[1] })
  assert.equal(renewed.status, 200, JSON.stringify(renewed))
  assert.equal(renewed.body.transactionId, first.body.transactionId)
  assert.equal((await query(api, id, { 'X-MNP-AI-Attribution': tokens[2] })).status, 404)
})

test('동일 ID 20회·순차 재전송은 문서·revision·알림·댓글·toggle을 한 번만 반영한다', { timeout: 60_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const id = newStorageRequestId(), body = { title: '한 번 저장', baseVersion: 1 }
  const replies = await Promise.all(Array.from({ length: 20 }, () => api.call(route, 'PATCH', body, key(id))))
  assert.ok(replies.every((r) => [200, 202].includes(r.status)), JSON.stringify(replies))
  const committed = await query(api, id)
  assert.equal(committed.body.outcome, 'committed', JSON.stringify(committed) + api.output())
  assert.equal(committed.body.map.version, 2)
  for (let i = 0; i < 3; i++) {
    const replay = await api.call(route, 'PATCH', body, key(id))
    assert.deepEqual(replay.body.map, committed.body.map)
    assert.equal(replay.body.transactionId, committed.body.transactionId)
  }
  assert.equal((await api.read(`${mapId}.json`)).version, 2)
  assert.equal((await readdir(path.join(api.data, '_history', mapId))).filter((p) => p.endsWith('.json')).length, 1)
  assert.equal((await api.read(`_daily-backups/${mapId}/${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())}.json`)).map.version, 2)
  const commentId = newStorageRequestId()
  const commentBody = { nodeId: 'card-1', summary: '[진행] @다른 편집자 중복 없는 알림', detail: '동일 논리 요청' }
  const comments = await Promise.all(Array.from({ length: 20 }, () => api.call(`${route}/comments`, 'POST', commentBody, key(commentId))))
  assert.ok(comments.every((r) => [201, 202].includes(r.status)), JSON.stringify(comments))
  const saved = await query(api, commentId)
  assert.equal(saved.status, 201, JSON.stringify(saved) + api.output())
  const comment = saved.body.comment
  assert.equal((await api.read(`_comments/${mapId}.json`)).length, 1)
  const beforeNotifications = await api.read('_notifications/user-second.json')
  assert.equal(beforeNotifications.filter((n) => n.commentId === comment.id).length, 1)
  const reactionId = newStorageRequestId()
  const reactionBody = { emoji: '👍', expectedReacted: false }
  await Promise.all(Array.from({ length: 20 }, () => api.call(`${route}/comments/${comment.id}/reactions`, 'POST', reactionBody, key(reactionId))))
  const reacted = await query(api, reactionId)
  assert.equal(reacted.body.outcome, 'committed', JSON.stringify(reacted))
  assert.deepEqual((await api.read(`_comments/${mapId}.json`))[0].reactions['👍'], ['user-editor'])
  await api.restart()
  const recovered = await api.call(`${route}/comments`, 'POST', commentBody, key(commentId))
  assert.equal(recovered.body.comment.id, comment.id)
  assert.deepEqual(await api.read('_notifications/user-second.json'), beforeNotifications)
  assert.deepEqual((await api.read(`_comments/${mapId}.json`))[0].reactions['👍'], ['user-editor'])
})

test('다른 내용·scope·권한은 거부하고 결과 조회·확정 충돌은 변경을 시작하지 않는다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const unknown = await query(api, newStorageRequestId())
  assert.equal(unknown.status, 404); assert.equal(unknown.body.outcome, 'unknown')
  const id = newStorageRequestId(), body = { title: '확정', baseVersion: 1 }
  assert.equal((await api.call(route, 'PATCH', body, key(id))).status, 200)
  assert.equal((await api.call(route, 'PATCH', { ...body, title: '다른 내용' }, key(id))).body.code, 'REQUEST_ID_REUSED')
  assert.equal((await query(api, id, { 'X-MNP-AI-Editor-Id': 'user-second' })).body.code, 'REQUEST_NOT_FOUND')
  assert.equal((await query(api, id, { 'X-MNP-AI-Conversation-Id': 'another' })).body.code, 'REQUEST_NOT_FOUND')
  const rejectedId = newStorageRequestId()
  const rejected = await api.call(route, 'PATCH', { title: '충돌', baseVersion: 1 }, key(rejectedId))
  assert.equal(rejected.status, 409, JSON.stringify(rejected))
  assert.equal((await api.call(route, 'PATCH', { title: '충돌', baseVersion: 2 }, key(rejectedId))).body.code, 'REQUEST_ID_REUSED')
  await api.restart()
  assert.equal((await query(api, rejectedId)).status, 409)
  await api.stop()
  const userFile = path.join(api.data, '_users.json'), users = await api.read('_users.json')
  users.find((u) => u.id === 'user-editor').role = 'viewer'
  await writeFile(userFile, JSON.stringify(users))
  await api.restart()
  const denied = await query(api, id)
  assert.equal(denied.status, 403); assert.equal(denied.body.map, undefined)
})

for (const phase of ['before-intent', 'after-intent', 'before-commit', 'after-commit', 'before-file', 'after-file',
  'before-applied', 'after-applied', 'before-response', 'after-response']) {
  test(`강제 종료 ${phase}: 재시작 뒤 동일 ID 결과·파일·버전 대조`, { timeout: 30_000 }, async (t) => {
    const api = await storageApi(t, { documents: 3 })
    const id = newStorageRequestId(), body = { title: `종료 지점 ${phase}`, baseVersion: 1 }
    await api.crash(phase, phase.includes('response') ? { requestId: id } : {})
    await api.call(route, 'PATCH', body, key(id)).catch(() => null)
    const exit = await api.restart()
    assert.ok(exit.code !== 0 || exit.signal, JSON.stringify(exit))
    const status = await query(api, id)
    if (['before-intent', 'after-intent', 'before-commit'].includes(phase)) {
      assert.equal(status.body.outcome, 'unknown', JSON.stringify(status))
      assert.equal((await api.read(`${mapId}.json`)).version, 1)
    } else assert.equal(status.body.outcome, 'committed', JSON.stringify(status) + api.output())
    const retried = await api.call(route, 'PATCH', body, key(id))
    assert.equal(retried.body.outcome, 'committed', JSON.stringify(retried) + api.output())
    assert.equal(retried.body.map.version, 2)
    const bytes = await readFile(path.join(api.data, `${mapId}.json`))
    assert.equal(retried.body.resources.find((r) => r.path === `${mapId}.json`).sha256, storageHash(bytes))
    assert.equal((await readdir(path.join(api.data, '_history', mapId))).filter((p) => p.endsWith('.json')).length, 1)
    assert.deepEqual(retried.body.sideEffectsPending, [])
  })
}
