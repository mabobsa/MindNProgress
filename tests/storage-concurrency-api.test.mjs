import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { storageApi, fixture, knowledge, actor } from './helpers/storage-api-harness.mjs'

test('댓글·검토 1/10/20 동시 요청의 성공 효과와 권위 파일·새 조회가 일치한다', { timeout: 300_000 }, async (t) => {
  const api = await storageApi(t, { seed: async ({ data, ids }) => {
    const ref = fixture(ids[1])
    for (let i = 1; i < 20; i++) ref.nodes[i].data.reference = { mapId: ids[2 + i % 5], nodeId: `card-${i}` }
    await writeFile(path.join(data, `${ids[1]}.json`), JSON.stringify(ref))
    const comments = Array.from({ length: 100 }, (_, i) => ({ id: `comment-fixture-${i}`, mapId: ids[0], nodeId: `card-${i % 20}`,
      text: '검증 댓글입니다. '.repeat(100), createdAt: `2026-10-26T00:00:${String(i % 60).padStart(2, '0')}.000Z`, author: actor }))
    await writeFile(path.join(data, '_comments', `${ids[0]}.json`), JSON.stringify(comments))
  } })
  let fixtureIndex = 10
  for (const concurrency of [1, 10, 20]) for (let round = 0; round < 3; round++) {
    const id = api.ids[fixtureIndex++]
    const comments = []
    const accepted = []
    const rejected = []
    for (let start = 0; start < 20; start += concurrency) {
      const wave = Array.from({ length: concurrency }, (_, n) => start + n)
      const before = (await api.call(`/api/maps/${id}`)).body.map
      const results = await Promise.all(wave.map(async (i) => {
        const text = `댓글 보존 ${concurrency}/${round}/${i}`
        const comment = await api.call(`/api/maps/${id}/comments`, 'POST', { nodeId: `card-${i}`, text })
        assert.equal(comment.status, 201, JSON.stringify(comment) + api.output())
        comments.push(comment.body.comment)
        const replacement = `검토 보존 ${concurrency}/${round}/${i}`
        const review = await api.call(`/api/maps/${id}/shared-knowledge/reviews`, 'POST', { baseVersion: before.version,
          patches: [{ cardId: `card-${i}`, expectedSha256: createHash('sha256').update(knowledge).digest('hex'), reviewResult: 'cleaned', replacement }] })
        assert.ok([200, 409].includes(review.status), JSON.stringify(review) + api.output())
        if (review.status === 200) accepted.push({ i, replacement })
        else { assert.equal(review.body.code, 'VERSION_CONFLICT'); rejected.push(i) }
        return review
      }))
      assert.equal(results.length, concurrency)
    }
    const storedComments = await api.read(`_comments/${id}.json`)
    const queriedComments = (await api.call(`/api/maps/${id}/comments`)).body.comments
    assert.equal(storedComments.length, 20)
    assert.equal(new Set(storedComments.map((c) => c.id)).size, 20)
    for (const expected of comments) for (const actual of [storedComments, queriedComments]) {
      assert.equal(actual.find((c) => c.id === expected.id)?.text, expected.text)
    }
    for (const map of [await api.read(`${id}.json`), (await api.call(`/api/maps/${id}`)).body.map]) {
      assert.equal(map.version, 1 + accepted.length)
      for (const { i, replacement } of accepted) assert.equal(map.nodes.find((n) => n.id === `card-${i}`).data.sharedKnowledge, replacement)
      for (const i of rejected) assert.equal(map.nodes.find((n) => n.id === `card-${i}`).data.sharedKnowledge, knowledge)
    }
    t.diagnostic(JSON.stringify({ concurrency, round, comments: comments.length, reviewSuccess: accepted.length, explicitConflict: rejected.length }))
  }
})

test('파일 교체 barrier 안에서 같은 문서 작성·조회는 대기하고 다른 문서는 처리된다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const blocked = await api.barrier('_comments/map-bench-0.json', 'rename')
  const first = api.call('/api/maps/map-bench-0/comments', 'POST', { nodeId: 'card-1', text: '먼저 확정' })
  await blocked.reached
  t.diagnostic('첫 파일 교체가 barrier에 도달함')
  let secondDone = false, readDone = false
  const second = api.call('/api/maps/map-bench-0/comments', 'POST', { nodeId: 'card-2', text: '나중 확정' }).then((r) => { secondDone = true; return r })
  const read = api.call('/api/maps/map-bench-0/comments').then((r) => { readDone = true; return r })
  const independent = await api.call('/api/maps/map-bench-1/comments', 'POST', { nodeId: 'card-1', text: '독립 문서' })
  t.diagnostic('독립 문서 저장이 완료됨')
  assert.equal(independent.status, 201)
  const beforeRelease = { secondDone, readDone }
  blocked.release()
  assert.equal((await first).status, 201)
  assert.equal((await second).status, 201)
  assert.equal((await read).status, 200)
  const stored = await api.read('_comments/map-bench-0.json')
  t.diagnostic(JSON.stringify({ successResponses: 2, stored: stored.length, beforeRelease }))
  assert.deepEqual(beforeRelease, { secondDone: false, readDone: false })
  assert.deepEqual(stored.map((c) => c.text), ['먼저 확정', '나중 확정'])
})

test('댓글 생성과 알림 읽음·생성이 경쟁해도 사용자 배열을 보존한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 21, seed: async ({ data }) => {
    await mkdir(path.join(data, '_notifications'), { recursive: true })
    await writeFile(path.join(data, '_notifications/user-editor.json'), JSON.stringify([{ id: 'existing', userId: 'user-editor', type: 'mention', readAt: null, createdAt: '2026-10-26T00:00:00Z' }]))
  } })
  const results = await Promise.all(api.ids.slice(0, 20).map((id, i) => api.call(`/api/maps/${id}/comments`, 'POST', {
    nodeId: 'card-1', text: `@김용민 알림 ${i}`,
  }, { 'X-MNP-AI-Editor-Id': 'user-second' })))
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results) + api.output())
  const notifications = await api.read('_notifications/user-editor.json')
  assert.equal(notifications.length, 21)
  // fixture 계정은 서비스의 기본 사용자 이름을 따른다.
  assert.equal(new Set(notifications.map((n) => n.id)).size, notifications.length)
  const barrier = await api.barrier('_notifications/user-editor.json', 'rename')
  const readAll = api.call('/api/notifications/read-all', 'POST', {})
  await barrier.reached
  let created = false
  const next = api.call('/api/maps/map-bench-20/comments', 'POST', { nodeId: 'card-1', text: '@김용민 읽음 처리와 동시 생성' },
    { 'X-MNP-AI-Editor-Id': 'user-second' }).then((r) => { created = true; return r })
  assert.equal((await api.call('/api/maps/map-bench-1', 'PATCH', { title: '알림 대기와 독립', baseVersion: 1 })).status, 200)
  assert.equal(created, false)
  barrier.release()
  assert.equal((await readAll).status, 200)
  assert.equal((await next).status, 201)
  const final = await api.read('_notifications/user-editor.json')
  assert.equal(final.length, 22)
  for (const item of notifications) assert.ok(final.find((n) => n.id === item.id)?.readAt)
  assert.equal(final.find((n) => n.commentId === undefined && n.id !== 'existing'), undefined)
  assert.equal(final.filter((n) => !n.readAt).length, 1)
})

test('예약 백업이 저장과 겹쳐도 최신 성공 버전의 백업을 과거 후보로 덮어쓰지 않는다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const directory = path.join(api.data, '_daily-backups/map-bench-0')
  const [file] = (await readdir(directory)).filter((name) => name.endsWith('.json'))
  assert.ok(file)
  // 이 시험 전용 루트에서만 오늘의 예약 생성 조건을 다시 만든다.
  await rm(path.join(directory, file))
  const barrier = await api.barrier(`_daily-backups/map-bench-0/${file}`, 'rename')
  await api.tick(60 * 60 * 1000)
  await barrier.reached
  let saved = false
  const mutation = api.call('/api/maps/map-bench-0', 'PATCH', { title: '예약과 경쟁한 최신 본문', baseVersion: 1 })
    .then((r) => { saved = true; return r })
  assert.equal((await api.call('/api/maps/map-bench-1', 'PATCH', { title: '백업과 독립', baseVersion: 1 })).status, 200)
  assert.equal(saved, false)
  barrier.release()
  assert.equal((await mutation).status, 200)
  const backup = await api.read(`_daily-backups/map-bench-0/${file}`)
  assert.equal(backup.map.version, 2)
  assert.equal(backup.map.title, '예약과 경쟁한 최신 본문')
  assert.equal((await api.read('map-bench-0.json')).title, backup.map.title)
})

test('시작 후 귀속 보정과 댓글 추가가 교차해도 보정된 작성자와 새 댓글·알림을 보존한다', { timeout: 30_000 }, async (t) => {
  let arrived, release
  const entered = new Promise((resolve) => { arrived = resolve })
  const external = new Promise((resolve) => { release = resolve })
  const unknown = { id: 'system-aionui-ai', name: 'AI(모델 미지정)', role: 'editor' }
  const api = await storageApi(t, { documents: 3, mockAion: async (url) => {
    if (url === '/api/conversations/fixture-conversation') {
      arrived(); await external
      return { id: 'fixture-conversation', created_at: '2026-10-26T00:00:00Z', extra: { agent_id: 'fixture-agent', current_model_id: 'fixture-model' } }
    }
    if (url === '/api/agents/management') return [{ id: 'fixture-agent', name: 'Fixture AI', installed: true, enabled: true,
      available_models: { current_model_id: 'fixture-model', available_models: [{ value: 'fixture-model', name: 'Fixture Model' }] } }]
    return []
  }, seed: async ({ data, ids }) => {
    const map = fixture(ids[0]); map.nodes[1].data.aiConversationId = 'fixture-conversation'
    await writeFile(path.join(data, `${map.id}.json`), JSON.stringify(map))
    await writeFile(path.join(data, '_comments', `${map.id}.json`), JSON.stringify([{ id: 'comment-repair', mapId: map.id, nodeId: 'card-1',
      text: '보정할 댓글', createdAt: '2026-10-27T00:00:00Z', author: unknown }]))
    await mkdir(path.join(data, '_notifications'), { recursive: true })
    await writeFile(path.join(data, '_notifications/user-editor.json'), JSON.stringify([{ id: 'notification-repair', userId: 'user-editor',
      type: 'comment', commentId: 'comment-repair', mapId: map.id, nodeId: 'card-1', actor: unknown, createdAt: '2026-10-27T00:00:00Z' }]))
  } })
  await entered
  const barrier = await api.barrier('_comments/map-bench-0.json', 'rename')
  release()
  await barrier.reached
  let created = false
  const comment = api.call('/api/maps/map-bench-0/comments', 'POST', { nodeId: 'card-1', text: '귀속 보정과 경쟁한 댓글' })
    .then((r) => { created = true; return r })
  assert.equal((await api.call('/api/maps/map-bench-1', 'PATCH', { title: '귀속 보정과 독립', baseVersion: 1 })).status, 200)
  assert.equal(created, false)
  barrier.release()
  const added = await comment
  assert.equal(added.status, 201)
  const comments = await api.read('_comments/map-bench-0.json')
  assert.equal(comments.length, 2)
  assert.equal(comments.find((c) => c.id === added.body.comment.id)?.text, '귀속 보정과 경쟁한 댓글')
  const repaired = comments.find((c) => c.id === 'comment-repair')
  assert.equal(repaired.author.name, 'Fixture AI(Fixture Model)')
  assert.equal((await api.read('_notifications/user-editor.json')).find((n) => n.id === 'notification-repair').actor.name, repaired.author.name)
})

test('SSE와 댓글 성공 응답은 파일 확정 이후에만 전달한다', { timeout: 30_000 }, async (t) => {
  const api = await storageApi(t, { documents: 3 })
  const abort = new AbortController()
  const response = await fetch(`${api.base}/api/events?mapId=map-bench-0&clientId=storage-test`, { headers: api.headers, signal: abort.signal })
  assert.equal(response.status, 200)
  let connected, changed
  const ready = new Promise((resolve) => { connected = resolve })
  const committed = new Promise((resolve) => { changed = resolve })
  const events = []
  const consume = (async () => {
    let buffer = ''
    const decoder = new TextDecoder()
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          const data = block.split('\n').find((line) => line.startsWith('data: '))
          if (!data) continue
          const event = JSON.parse(data.slice(6)); events.push(event)
          if (event.type === 'connected') connected()
          if (event.type === 'comment-changed') changed(event)
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error }
  })()
  try {
    await ready
    const barrier = await api.barrier('_comments/map-bench-0.json', 'rename')
    let succeeded = false
    const comment = api.call('/api/maps/map-bench-0/comments', 'POST', { nodeId: 'card-1', text: 'SSE 확정 순서' })
      .then((r) => { succeeded = true; return r })
    await barrier.reached
    assert.equal((await api.call('/api/maps/map-bench-1', 'PATCH', { title: 'SSE 중 독립', baseVersion: 1 })).status, 200)
    assert.equal(succeeded, false)
    assert.equal(events.filter((e) => e.type === 'comment-changed').length, 0)
    barrier.release()
    const saved = await comment
    assert.equal(saved.status, 201)
    const event = await committed
    assert.ok(event.eventId, '확정 이벤트는 재조회에 사용할 안정 ID가 있다')
    assert.equal(event.comment.id, saved.body.comment.id)
    assert.equal((await api.read('_comments/map-bench-0.json'))[0].id, event.comment.id)
  } finally { abort.abort(); await consume }
})
