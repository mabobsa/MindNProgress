import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildDoorayHandoffPrompt, buildDoorayRoutingCatalog, createDoorayResponseService, parseDoorayAiResult, readDoorayResponseSource, validateDoorayRoute } from '../server/lib/doorayResponses.mjs'

const item = { key: 'comment:post1:comment1', kind: 'mention-comment', projectId: 'p1', postId: 'post1', commentId: 'comment1',
  subject: '베팅 표시 수정', excerpt: '금액 표시를 확인해 주세요.', url: 'https://nhnent.dooray.com/project/posts/post1#comment-comment1' }
const source = { item, subject: item.subject, body: '본문', selected: { id: 'comment1', body: item.excerpt }, comments: [], fingerprint: 'original' }
const maps = [{ id: 'map1', title: '홀덤 UI', version: 1, nodes: [
  { id: 'root1', data: { kind: 'root', label: '홀덤 UI', description: '' } },
  { id: 'task1', data: { kind: 'task', label: '베팅', description: '금액 표시 수정', taskUrl: item.url, aiConversations: [{ conversationId: 'old-chat', requestPreview: '베팅 표시 수정' }] } },
  { id: 'knowledge1', data: { kind: 'task', label: '기획 원문', externalLink: { projectId: 'p1', postId: 'post1' } } },
  { id: 'ref1', data: { kind: 'task', label: '참조 카드', reference: { mapId: 'else', nodeId: 'original' } } },
], edges: [{ source: 'root1', target: 'task1' }, { source: 'knowledge1', target: 'task1', data: { relation: 'knowledge' } }] }]
const route = { action: 'direct', mapId: 'map1', cardId: 'task1', conversationId: 'old-chat', requestSummary: '금액 표시 수정', reason: '동일 Dooray 업무가 연결된 카드' }
const assistant = (result) => ({ position: 'left', type: 'text', content: `\`\`\`json\n${JSON.stringify(result)}\n\`\`\`` })

test('Dooray 원문 연결과 지식 소비 카드를 우선하고 지식·Ref 카드를 담당 후보에서 제외한다', () => {
  const catalog = buildDoorayRoutingCatalog(maps, source)
  assert.equal(catalog.candidates[0].cardId, 'task1')
  assert.equal(catalog.candidates[0].directLink, true)
  assert.equal(catalog.candidates[0].knowledgeMatch, true)
  assert.deepEqual(catalog.candidates.map((card) => card.cardId).sort(), ['root1', 'task1'])
  assert.equal(catalog.documents.length, 1)
})

test('잘못된 담당 카드, 대화 연결과 총괄 경로는 실행 전에 차단한다', () => {
  assert.equal(validateDoorayRoute(route, maps).cardId, 'task1')
  for (const change of [{ cardId: 'missing' }, { cardId: 'knowledge1' }, { cardId: 'ref1' }, { conversationId: 'unrelated' }, { action: 'group' }, { action: 'coordinator' }]) {
    assert.throws(() => validateDoorayRoute({ ...route, ...change }, maps))
  }
  assert.equal(validateDoorayRoute({ ...route, action: 'coordinator', cardId: 'root1', conversationId: null }, maps).action, 'coordinator')
})

test('현재 실행 ID의 AI 결과만 읽고 사용자 텍스트나 이전 턴 결과를 채택하지 않는다', () => {
  const messages = [assistant({ requestId: 'old', proposal: '이전 결과' }), { position: 'right', type: 'text', content: JSON.stringify({ requestId: 'new', proposal: '사용자 입력' }) }]
  assert.equal(parseDoorayAiResult(messages, 'new'), null)
  messages.push(assistant({ requestId: 'new', proposal: '현재 결과' }))
  assert.equal(parseDoorayAiResult(messages, 'new').proposal, '현재 결과')
  assert.equal(parseDoorayAiResult([{ position: 'left', type: 'text', content: '손상된 JSON' }], 'new'), null)
})

test('선택 댓글을 페이지에서 찾아 원문을 확보하고 삭제된 댓글은 발췌로 대체하지 않는다', async () => {
  let pages = 0
  const options = { acquire: async () => {}, fetchImpl: async (url) => {
    const logs = url.includes('/logs?')
    if (logs) pages++
    const result = !logs ? { subject: item.subject, body: { content: '업무 원문' } }
      : url.includes('page=0') ? Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, type: 'comment', body: { content: '이전 댓글' } }))
        : [{ id: 'comment1', type: 'comment', body: { content: '전체 멘션 원문' } }]
    return new Response(JSON.stringify({ header: { isSuccessful: true }, result }), { status: 200 })
  } }
  const config = { apiKey: 'test-only', baseUrl: 'http://example.test' }
  const result = await readDoorayResponseSource(item, config, options)
  assert.equal(result.selected.body, '전체 멘션 원문')
  assert.equal(pages, 2)
  assert.equal(result.commentsComplete, true)
  await assert.rejects(readDoorayResponseSource({ ...item, commentId: 'deleted' }, config, options), /원문을 찾지/)
})

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dooray-responses-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const operations = new Map()
  const counts = { create: 0, dispatch: 0, link: 0 }
  const deps = { directory,
    read: async (file) => { try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return {}; throw e } },
    write: async (file, value) => {
      await writeFile(`${file}.tmp`, JSON.stringify(value))
      for (let attempt = 0; ; attempt++) {
        try { await rename(`${file}.tmp`, file); return } catch (failure) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(failure.code) || attempt >= 20) throw failure
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
    },
    loadSource: async (nextItem) => ({ ...source, item: nextItem, fingerprint: nextItem.key }),
    resolveSettings: async () => ({ machineId: 'main', agentId: 'test-ai', modelId: 'test-model' }),
    loadMaps: async () => maps, user: async (id) => ({ id, name: '검증 사용자' }),
    conversationExists: async () => true,
    prepareConversation: async () => ({ mcpServers: [] }),
    createConversation: async () => ({ id: `new-chat-${++counts.create}` }),
    prepareReview: async (_user, _selected, settings, reusable) => ({ conversationId: reusable?.conversationId ?? null, settings, context: {} }),
    archiveConversation: async () => {},
    linkReview: async () => { counts.link++ },
    dispatch: async (op) => { counts.dispatch++; operations.set(op.id, op); return { conversationId: op.conversationId, state: 'running' } },
    getDispatch: async (op) => {
      if (!operations.has(op.id)) throw Object.assign(new Error('not found'), { status: 404 })
      return { conversationId: op.conversationId, state: 'completed' }
    },
    messages: async (op) => [assistant({ requestId: op.id, ...(op.kind === 'router' ? route : { proposal: '변경 범위와 검증 조건 제안' }) })],
    ...overrides,
  }
  return { deps, counts, operations, service: createDoorayResponseService(deps) }
}
async function until(service, userId, expected, max = 50) {
  for (let i = 0; i < max; i++) {
    await service.poll()
    const jobs = await service.list(userId)
    if (jobs.length && jobs.every((job) => job.status === expected)) return jobs
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(`상태가 ${expected}에 도달하지 않음: ${JSON.stringify(await service.list(userId))}`)
}

test('중복 클릭은 한 요청으로 접수하고 전용 대화에서 제안을 회수하며 계정별로 격리한다', async (t) => {
  const { service, counts } = await fixture(t)
  const [first, second] = await Promise.all([service.start({ id: 'user1' }, item), service.start({ id: 'user1' }, item)])
  assert.equal(first.job.id, second.job.id)
  assert.deepEqual([first.repeated, second.repeated].sort(), [false, true])
  const [job] = await until(service, 'user1', 'proposal')
  assert.equal(job.proposal, '변경 범위와 검증 조건 제안')
  assert.equal(job.conversationId, 'new-chat-2')
  assert.equal(counts.create, 2)
  assert.equal(counts.dispatch, 2)
  assert.equal(counts.link, 1)
  assert.deepEqual(await service.list('user2'), [])
  await assert.rejects(service.retry('user2', job.id), /찾을 수/)
})

test('서버 재시작 후 기존 실행을 조회하고 새 AI 실행을 중복 생성하지 않는다', async (t) => {
  const { service, deps, counts } = await fixture(t)
  await service.start({ id: 'user1' }, item)
  for (let i = 0; i < 50 && counts.dispatch === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const restarted = createDoorayResponseService(deps)
  const [job] = await until(restarted, 'user1', 'proposal')
  assert.equal(job.route.cardId, 'task1')
  assert.equal(counts.create, 2)
  assert.equal(counts.dispatch, 2)
})

test('AI 전송 응답 유실은 같은 실행 ID로 상태를 확인하여 회수한다', async (t) => {
  const { service, deps, counts, operations } = await fixture(t)
  const original = deps.dispatch
  deps.dispatch = async (op) => {
    const result = await original(op)
    if (op.kind === 'router') throw new Error('응답 유실')
    return result
  }
  await service.start({ id: 'user1' }, item)
  const [failed] = await until(service, 'user1', 'failed')
  assert.equal(failed.canRetry, true)
  assert.equal(operations.size, 1)
  await service.retry('user1', failed.id)
  await until(service, 'user1', 'proposal')
  assert.equal(counts.dispatch, 2)
})

test('담당 탐색이 모호하면 사용자에게 질문하고 담당 AI를 실행하지 않는다', async (t) => {
  const { service, counts } = await fixture(t, { messages: async (op) => [assistant({ requestId: op.id, action: 'clarify', proposal: '어느 프로젝트의 표시 정책인지 확인이 필요합니다.' })] })
  await service.start({ id: 'user1' }, item)
  const [job] = await until(service, 'user1', 'needs-input')
  assert.match(job.proposal, /프로젝트/)
  assert.equal(counts.dispatch, 1)
  assert.equal(counts.link, 0)
})

test('담당 대화가 사용 중이면 기다리고 사용 가능해진 뒤 동일 요청을 전달한다', async (t) => {
  let busy = true
  const { service, counts } = await fixture(t, { prepareReview: async (_user, _route, settings) => busy ? { waiting: true, reason: '실행 중' } : { conversationId: null, settings, context: {} } })
  await service.start({ id: 'user1' }, item)
  await until(service, 'user1', 'waiting-target')
  assert.equal(counts.dispatch, 1)
  busy = false
  await until(service, 'user1', 'proposal')
  assert.equal(counts.dispatch, 2)
})

test('같은 담당 카드에 대한 여러 참조는 담당 AI 검토를 직렬로 전달한다', async (t) => {
  const { service, deps, operations } = await fixture(t)
  let firstReviewId = null
  let finishFirst = false
  deps.getDispatch = async (op) => {
    if (!operations.has(op.id)) throw Object.assign(new Error('not found'), { status: 404 })
    if (op.kind === 'review' && op.id === firstReviewId && !finishFirst) return { conversationId: op.conversationId, state: 'running' }
    return { conversationId: op.conversationId, state: 'completed' }
  }
  const original = deps.dispatch
  deps.dispatch = async (op) => { if (op.kind === 'review') firstReviewId ??= op.id; return original(op) }
  await Promise.all([service.start({ id: 'user1' }, item), service.start({ id: 'user1' }, { ...item, key: 'comment:post1:comment2' })])
  const deadline = Date.now() + 5000
  let jobs = []
  do {
    await service.poll()
    jobs = await service.list('user1')
    if (firstReviewId && jobs.some((job) => job.status === 'waiting-target')) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  assert.ok(jobs.some((job) => job.status === 'waiting-target'), '두 번째 요청이 앞선 담당 AI 검토를 기다려야 한다')
  assert.equal([...operations.values()].filter((op) => op.kind === 'review').length, 1)
  finishFirst = true
  await until(service, 'user1', 'proposal')
  assert.equal([...operations.values()].filter((op) => op.kind === 'review').length, 2)
})

test('같은 담당의 추가 정보 재제안은 전용 접수·검토 대화를 재사용하고 실행 ID만 바꾼다', async (t) => {
  const { service, counts, operations } = await fixture(t)
  await service.start({ id: 'user1' }, item)
  const [first] = await until(service, 'user1', 'proposal')
  await assert.rejects(service.refine('user2', first.id, '관련 정보'), /찾을 수/)
  await service.refine('user1', first.id, '표시 정책을 담당하는 카드에서 소수점 처리도 확인해 주세요.')
  const [second] = await until(service, 'user1', 'proposal')
  assert.equal(second.id, first.id)
  assert.equal(counts.create, 2)
  assert.equal(second.conversationId, first.conversationId)
  assert.equal(operations.size, 4)
  assert.ok([...operations.values()].some((op) => op.prompt.includes('소수점 처리')))
})

test('변경된 멘션 내용은 기존 확인 상태와 독립된 후속 요청으로 접수한다', async (t) => {
  const { service, deps } = await fixture(t)
  const first = await service.start({ id: 'user1' }, item)
  await until(service, 'user1', 'proposal')
  deps.loadSource = async () => ({ ...source, fingerprint: 'edited-comment' })
  const second = await service.start({ id: 'user1' }, item)
  assert.notEqual(second.job.id, first.job.id)
  await until(service, 'user1', 'proposal')
})

test('예전 단일 대화 연결도 기존 담당 대화 후보에 포함한다', () => {
  const legacyMaps = structuredClone(maps)
  const card = legacyMaps[0].nodes.find((node) => node.id === 'task1')
  delete card.data.aiConversations
  card.data.aiConversationId = 'legacy-chat'
  const candidate = buildDoorayRoutingCatalog(legacyMaps, source).candidates.find((entry) => entry.cardId === 'task1')
  assert.equal(candidate.conversations[0].conversationId, 'legacy-chat')
})

test('한글 원문이 AI 전송 바이트 상한을 넘으면 대화를 만들기 전에 알린다', async (t) => {
  const { service, counts } = await fixture(t, { loadSource: async () => ({ ...source, body: '가'.repeat(90_000) }) })
  await service.start({ id: 'user1' }, item)
  const [job] = await until(service, 'user1', 'failed')
  assert.match(job.error, /범위를 넘었/)
  assert.equal(counts.create, 0)
  assert.equal(counts.dispatch, 0)
})

for (const stage of ['routing', 'reviewing', 'proposal', 'failed', 'needs-input']) {
  test(`${stage} 대화를 삭제하면 제안 시작 전으로 초기화하고 명시적인 재요청만 새로 실행한다`, async (t) => {
    const deleted = new Set()
    const { service, deps, counts } = await fixture(t, {
      conversationExists: async (_user, conversation) => !deleted.has(conversation.conversationId),
    })
    const getDispatch = deps.getDispatch
    deps.getDispatch = async (op) => {
      if ((stage === 'routing' && op.kind === 'router') || (stage === 'reviewing' && op.kind === 'review')) return { conversationId: op.conversationId, state: 'running' }
      if (stage === 'failed') return { conversationId: op.conversationId, state: 'waiting_resume' }
      return getDispatch(op)
    }
    if (stage === 'needs-input') deps.messages = async (op) => [assistant({ requestId: op.id, action: 'clarify', proposal: '담당 카드를 알려 주세요.' })]
    const first = await service.start({ id: 'user1' }, item)
    let job
    for (let i = 0; i < 100; i++) {
      await service.poll()
      ;[job] = await service.list('user1')
      if (job?.status === stage && job.conversationId && counts.dispatch >= (stage === 'reviewing' ? 2 : 1)) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(job.status, stage)
    assert.ok(job.conversationId)
    deleted.add(job.conversationId)
    // 완료·중지 상태도 재접속/서버 재시작 뒤 조회만으로 정리된다.
    const restarted = createDoorayResponseService(deps)
    await restarted.poll()
    assert.deepEqual(await restarted.list('user1'), [])
    const previousCounts = { ...counts }
    await restarted.poll()
    assert.deepEqual(counts, previousCounts, '삭제를 감지해도 AI를 자동으로 재생성하지 않는다')
    assert.deepEqual((await deps.read(path.join(deps.directory, 'user1.json'))).jobs, [])
    deps.getDispatch = getDispatch
    deps.messages = async (op) => [assistant({ requestId: op.id, ...(op.kind === 'router' ? { ...route, conversationId: null } : { proposal: '새 제안' }) })]
    const [second, duplicate] = await Promise.all([restarted.start({ id: 'user1' }, item), restarted.start({ id: 'user1' }, item)])
    assert.notEqual(second.job.id, first.job.id)
    assert.equal(duplicate.job.id, second.job.id)
    await until(restarted, 'user1', 'proposal')
  })
}

test('기존 제안을 다시 누르기 직전에 삭제한 접수 대화도 중복 기록으로 반환하지 않는다', async (t) => {
  const { service, deps, counts } = await fixture(t)
  const first = await service.start({ id: 'user1' }, item)
  await until(service, 'user1', 'proposal')
  deps.conversationExists = async (_user, conversation) => conversation.conversationId !== 'new-chat-1'
  const second = await service.start({ id: 'user1' }, item)
  assert.equal(second.repeated, false)
  assert.notEqual(second.job.id, first.job.id)
  await until(service, 'user1', 'proposal')
  assert.equal(counts.create, 4)
})

test('연결·권한 오류는 삭제로 초기화하지 않고 삭제된 다른 계정의 요청을 건드리지 않는다', async (t) => {
  const { service, deps } = await fixture(t)
  await service.start({ id: 'user1' }, item)
  await until(service, 'user1', 'proposal')
  await service.start({ id: 'user2' }, item)
  await until(service, 'user2', 'proposal')
  for (const status of [403, 502, 504]) {
    deps.conversationExists = async () => { throw Object.assign(new Error('연결 확인 실패'), { status }) }
    assert.equal((await createDoorayResponseService(deps).list('user1'))[0].status, 'proposal')
  }
  deps.conversationExists = async (user) => user.id !== 'user1'
  const restarted = createDoorayResponseService(deps)
  assert.deepEqual(await restarted.list('user1'), [])
  assert.equal((await restarted.list('user2')).length, 1)
})

test('대화 존재 확인 직후 삭제되어 메시지 조회가 실패해도 실패 기록 대신 초기화한다', async (t) => {
  let deleted = false
  const { service, deps } = await fixture(t, { conversationExists: async () => !deleted })
  deps.messages = async () => { deleted = true; throw Object.assign(new Error('삭제됨'), { status: 404 }) }
  await service.start({ id: 'user1' }, item)
  for (let i = 0; i < 100 && (await service.list('user1')).length; i++) {
    await service.poll()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(deleted, true)
  assert.deepEqual(await service.list('user1'), [])
})

test('MCP 적용 대기가 끝나야 지시를 보내고 추가 정보 재검토마다 다시 확인한다', async (t) => {
  const { service, deps, counts } = await fixture(t)
  const prepared = []
  let wait = true
  deps.prepareConversation = async (_user, op) => {
    prepared.push(op.id)
    if (wait) { wait = false; assert.equal(counts.dispatch, 0); return { waiting: true, reason: 'MCP 적용 대기' } }
    return { mcpServers: [{ id: 'required', label: '검증 MCP' }] }
  }
  const dispatch = deps.dispatch
  deps.dispatch = async (op) => {
    assert.equal(op.mcpPrepared, true)
    assert.equal(op.settings.mcpServers[0].id, 'required')
    return dispatch(op)
  }
  await service.start({ id: 'user1' }, item)
  const [job] = await until(service, 'user1', 'proposal')
  assert.equal(prepared.length, 3)
  await service.refine('user1', job.id, '추가 자료를 MCP로 조회해 주세요.')
  await until(service, 'user1', 'proposal')
  assert.equal(prepared.length, 5)
  assert.equal(new Set(prepared).size, 4)
})

test('이미 전송한 실행의 상태 회수 중에는 MCP를 변경해 대화를 중지하지 않는다', async (t) => {
  const { service, deps } = await fixture(t)
  const dispatch = deps.dispatch
  deps.dispatch = async (op) => { await dispatch(op); throw new Error('전송 응답 유실') }
  await service.start({ id: 'user1' }, item)
  const [failed] = await until(service, 'user1', 'failed')
  deps.prepareConversation = async (_user, op) => {
    assert.equal(op.kind, 'review', '기존 router 실행은 상태만 회수해야 한다')
    return { mcpServers: [] }
  }
  deps.dispatch = dispatch
  await service.retry('user1', failed.id)
  await until(service, 'user1', 'proposal')
})

test('완료는 계정별로 저장하고 모든 전용 대화를 보관하며 삭제·재시작 후에도 제안을 보존한다', async (t) => {
  const archived = []
  const { service, deps, counts } = await fixture(t, { archiveConversation: async (user, reference, jobId) => {
    assert.equal(user.id, 'user1')
    assert.ok(reference.operationId.startsWith(jobId))
    archived.push(reference.conversationId)
  } })
  await service.start({ id: 'user1' }, item)
  const [proposal] = await until(service, 'user1', 'proposal')
  await assert.rejects(service.complete('user2', proposal.id), /찾을 수/)
  const completed = await service.complete('user1', proposal.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.proposal, proposal.proposal)
  assert.equal(completed.archiveStatus, 'done')
  assert.ok(completed.completedAt)
  assert.deepEqual(archived.sort(), ['new-chat-1', 'new-chat-2'])
  deps.conversationExists = async () => { throw new Error('완료 기록은 대화의 존재에 의존하지 않아야 한다') }
  const restarted = createDoorayResponseService(deps)
  assert.deepEqual(await restarted.list('user1'), [completed])
  await restarted.poll()
  const repeated = await restarted.start({ id: 'user1' }, item)
  assert.equal(repeated.job.status, 'completed')
  assert.equal(repeated.job.id, completed.id)
  assert.equal(counts.create, 2)
  await assert.rejects(restarted.refine('user1', completed.id, '다시 검토'), /완료된 대응/)
  await assert.rejects(restarted.retry('user1', completed.id), /상태를 다시 확인/)
})

test('보관 실패는 완료를 유지하고 다시 시도해도 완료 시각과 AI 실행 횟수를 바꾸지 않는다', async (t) => {
  let blocked = true
  const { service, counts } = await fixture(t, { archiveConversation: async () => { if (blocked) throw new Error('아직 실행 중') } })
  await service.start({ id: 'user1' }, item)
  const [proposal] = await until(service, 'user1', 'proposal')
  const completed = await service.complete('user1', proposal.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.archiveStatus, 'warning')
  assert.match(completed.archiveError, /실행 중/)
  blocked = false
  const retried = await service.complete('user1', proposal.id)
  assert.equal(retried.completedAt, completed.completedAt)
  assert.equal(retried.archiveStatus, 'done')
  assert.equal(retried.archiveError, '')
  assert.equal(counts.dispatch, 2)
})

test('실행 중 완료는 거부하고 완료·재제안 동시 요청에서도 새 실행을 보관하지 않는다', async (t) => {
  const { service, deps } = await fixture(t)
  const original = deps.getDispatch
  deps.getDispatch = async (op) => ({ conversationId: op.conversationId, state: 'running' })
  const result = await service.start({ id: 'user1' }, item)
  await until(service, 'user1', 'routing')
  await assert.rejects(service.complete('user1', result.job.id), /확인 중|검토가 끝난/)
  deps.getDispatch = original
  await until(service, 'user1', 'proposal')
  let release
  const archiving = new Promise((resolve) => { release = resolve })
  deps.archiveConversation = async () => archiving
  const completion = service.complete('user1', result.job.id)
  await until(service, 'user1', 'completed')
  await assert.rejects(service.refine('user1', result.job.id, '동시 재제안'), /완료된 대응/)
  await assert.rejects(service.complete('user1', result.job.id), /확인 중/)
  release()
  await completion
})

test('담당이 변경되면 새 검토 대화를 만들고 완료 시 이전 담당의 전용 대화도 함께 보관한다', async (t) => {
  let selected = route
  const archived = []
  const { service, counts } = await fixture(t, {
    messages: async (op) => [assistant({ requestId: op.id, ...(op.kind === 'router' ? selected : { proposal: '새 담당 제안' }) })],
    archiveConversation: async (_user, reference) => archived.push(reference.conversationId),
  })
  await service.start({ id: 'user1' }, item)
  const [first] = await until(service, 'user1', 'proposal')
  selected = { ...route, cardId: 'root1', conversationId: null }
  await service.refine('user1', first.id, '루트에서 조정해 주세요.')
  const [second] = await until(service, 'user1', 'proposal')
  assert.notEqual(second.conversationId, first.conversationId)
  assert.equal(counts.create, 3)
  await service.complete('user1', first.id)
  assert.deepEqual(archived.sort(), ['new-chat-1', 'new-chat-2', 'new-chat-3'])
})

test('예전 완료 내역은 새 요청의 100개 보관 상한에 의해 사라지지 않는다', async (t) => {
  const { service, deps } = await fixture(t)
  await service.start({ id: 'user1' }, item)
  const [first] = await until(service, 'user1', 'proposal')
  await service.complete('user1', first.id)
  const file = path.join(deps.directory, 'user1.json')
  const stored = await deps.read(file)
  stored.jobs = [...Array.from({ length: 100 }, (_, index) => ({ ...stored.jobs[0], id: `history-${index}` })), ...stored.jobs]
  await deps.write(file, stored)
  deps.loadSource = async () => ({ ...source, fingerprint: 'new-source' })
  const next = await service.start({ id: 'user1' }, item)
  assert.equal((await service.list('user1')).filter((job) => job.completedAt).length, 101)
  for (let i = 0; i < 100; i++) {
    await service.poll()
    if ((await service.list('user1')).find((job) => job.id === next.job.id)?.status === 'proposal') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal((await service.list('user1')).find((job) => job.id === next.job.id)?.status, 'proposal')
})

test('담당 카드 전달은 제안과 본문·코멘트 URL을 보존하고 독립적인 재제안만 요청한다', () => {
  const job = { id: 'job-1', userId: 'user1', status: 'proposal', source, route, proposal: '가'.repeat(6000) + '\n제안 마지막 문장' }
  const prompt = buildDoorayHandoffPrompt(job)
  assert.ok(prompt.includes(job.proposal))
  assert.ok(prompt.includes(item.url))
  assert.ok(prompt.includes(item.url.split('#')[0]))
  assert.match(prompt, /독립적으로 판단/)
  assert.match(prompt, /실행 지시가 아닙니다/)
  assert.match(prompt, /별도 승인을 기다리세요/)
  assert.match(prompt, /JSON 형식은 사용하지 말고/)
  for (const change of [{ status: 'needs-input' }, { completedAt: 'done' }, { route: null }, { proposal: '' }, { proposal: '가'.repeat(90_000) }]) {
    assert.throws(() => buildDoorayHandoffPrompt({ ...job, ...change }))
  }
})

test('담당 전달은 계정·대화·실행 상태를 검사하고 응답 유실 재시도에도 같은 실행을 회수한다', async (t) => {
  const { service, deps, counts } = await fixture(t)
  let idle = true
  deps.handoffTarget = async () => ({ route, conversations: [{ conversationId: 'old-chat', machineId: 'main', homeMachineRole: 'main', available: true, idle }] })
  await service.start({ id: 'user1' }, item)
  const [job] = await until(service, 'user1', 'proposal')
  await assert.rejects(service.handoffOptions('user2', job.id), /찾을 수/)
  await assert.rejects(service.handoff('user1', job.id, 'foreign-chat'), /확인할 수/)
  idle = false
  await assert.rejects(service.handoff('user1', job.id, 'old-chat'), /실행 중/)
  idle = true
  const dispatch = deps.dispatch
  deps.dispatch = async (op) => { await dispatch(op); throw new Error('전송 응답 유실') }
  await assert.rejects(service.handoff('user1', job.id, 'old-chat'), /응답 유실/)
  const sent = await service.handoff('user1', job.id, 'old-chat')
  assert.equal(sent.conversationId, 'old-chat')
  assert.ok(sent.sentAt)
  await service.handoff('user1', job.id, 'old-chat')
  assert.equal(counts.dispatch, 3)
  assert.equal((await service.list('user1'))[0].status, 'proposal', '전달 접수는 대응 완료를 뜻하지 않는다')
  await service.complete('user1', job.id)
  await assert.rejects(service.handoff('user1', job.id, 'old-chat'), /제안 도착/)
})
