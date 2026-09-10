import assert from 'node:assert/strict'
import test from 'node:test'

import { DoorayTaskError } from '../server/lib/doorayTasks.mjs'
import {
  collectDoorayMentions,
  createDoorayRateLimiter,
  doorayMentionExcerpt,
  doorayMentionItemKey,
  doorayTaskWebUrl,
  extractDoorayMentionMemberIds,
  listDoorayMentionProjects,
  mentionsDoorayMember,
  mergeDoorayMentionAcks,
  normalizeDoorayMentionRange,
  normalizeDoorayWebHostname,
  plainDoorayText,
  pruneDoorayMentionAcks,
  pruneDoorayMentionCache,
  sortDoorayMentionItems,
} from '../server/lib/doorayMentions.mjs'

const meId = '1561544322715661170'
const config = { apiKey: 'test-key', baseUrl: 'https://api.dooray.com' }
const markdownMention = `[@김용민](dooray://1387695619080878080/members/${meId} "me")`
const otherMarkdownMention = '[@천기환](dooray://1387695619080878080/members/1879230132705173550 "member")'
const htmlMention = `<a class="mention-member role-member" data-dooray-href="dooray://1387695619080878080/members/${meId}" data-id="${meId}" title="me">@김용민</a>`

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function successPayload(result) {
  return { header: { isSuccessful: true, resultCode: 0, resultMessage: '' }, result }
}

test('마크다운과 HTML 두 형식의 멘션에서 구성원 ID를 뽑는다', () => {
  assert.deepEqual(extractDoorayMentionMemberIds(markdownMention), [meId])
  assert.deepEqual(extractDoorayMentionMemberIds(htmlMention), [meId])
  assert.deepEqual(
    extractDoorayMentionMemberIds(`${otherMarkdownMention} 님 ${markdownMention} 확인 부탁드립니다`),
    ['1879230132705173550', meId],
  )
  assert.deepEqual(extractDoorayMentionMemberIds('멘션이 없는 본문'), [])
})

test('멘션 판정은 본문에 섞인 같은 숫자에 반응하지 않는다', () => {
  assert.equal(mentionsDoorayMember(markdownMention, meId), true)
  assert.equal(mentionsDoorayMember(htmlMention, meId), true)
  assert.equal(mentionsDoorayMember(otherMarkdownMention, meId), false)
  // 멘션 마크업이 아니라 그냥 숫자만 적힌 경우는 참조로 보지 않는다.
  assert.equal(mentionsDoorayMember(`구성원 번호는 ${meId} 입니다`, meId), false)
  assert.equal(mentionsDoorayMember(markdownMention, ''), false)
})

test('발췌는 태그와 엔티티, 마크다운 이스케이프를 정리한다', () => {
  assert.equal(
    plainDoorayText('<div>안녕하세요<br>@나준호&#91;9.8~10 부재&#93;</div>', 'text/html'),
    '안녕하세요 @나준호[9.8~10 부재]',
  )
  assert.equal(
    plainDoorayText(`${markdownMention} REQ\\_Login 확인 부탁드립니다`, 'text/x-markdown'),
    '@김용민 REQ_Login 확인 부탁드립니다',
  )
  assert.equal(
    plainDoorayText('![Inline-image.png](/files/1) 참고', 'text/x-markdown'),
    '[이미지] 참고',
  )
  // Dooray 마크다운 본문에도 HTML이 섞여 들어오므로 태그를 함께 걷어낸다.
  assert.equal(
    plainDoorayText('알파존 결과<br><details><summary><span>호출 결과</span></summary>본문</details>', 'text/x-markdown'),
    '알파존 결과 호출 결과 본문',
  )
  assert.equal(doorayMentionExcerpt('가나다라마바사', 'text/x-markdown', 3), '가나다…')
})

test('확인 키는 항목 종류마다 안정적으로 만들어진다', () => {
  assert.equal(
    doorayMentionItemKey({ kind: 'mention-comment', postId: '10', commentId: '20' }),
    'comment:10:20',
  )
  assert.equal(
    doorayMentionItemKey({ kind: 'related-comment', postId: '10', commentId: '21' }),
    'comment:10:21',
  )
  assert.equal(
    doorayMentionItemKey({ kind: 'mention-body', postId: '10', bodyDigest: 'abc123' }),
    'post-body:10:abc123',
  )
  assert.equal(doorayMentionItemKey({ kind: 'assigned', postId: '10' }), 'post-role:10:assigned')
  assert.equal(doorayMentionItemKey({ kind: 'cc', postId: '10' }), 'post-role:10:cc')
})

test('업무 링크는 댓글 앵커까지 포함한 정규 주소로 만든다', () => {
  assert.equal(doorayTaskWebUrl('nhnent.dooray.com', '1', '2'), 'https://nhnent.dooray.com/task/1/2')
  assert.equal(
    doorayTaskWebUrl('nhnent.dooray.com', '1', '2', '3'),
    'https://nhnent.dooray.com/task/1/2#comment-3',
  )
  assert.equal(normalizeDoorayWebHostname(''), 'nhnent.dooray.com')
  assert.equal(normalizeDoorayWebHostname('Sample.dooray.com'), 'sample.dooray.com')
  assert.throws(() => normalizeDoorayWebHostname('example.com'), DoorayTaskError)
})

test('조회 기간은 순서와 상한을 검사한다', () => {
  const range = normalizeDoorayMentionRange({
    since: '2026-09-03T00:00:00+09:00',
    until: '2026-09-10T00:00:00+09:00',
  })
  assert.equal(range.since, '2026-09-02T15:00:00.000Z')
  assert.equal(range.until, '2026-09-09T15:00:00.000Z')
  assert.throws(() => normalizeDoorayMentionRange({ since: 'not-a-date' }), DoorayTaskError)
  assert.throws(() => normalizeDoorayMentionRange({
    since: '2026-09-10T00:00:00Z',
    until: '2026-09-03T00:00:00Z',
  }), DoorayTaskError)
  assert.throws(() => normalizeDoorayMentionRange({
    since: '2020-01-01T00:00:00Z',
    until: '2026-01-01T00:00:00Z',
  }), DoorayTaskError)
})

test('요청 속도 제한기는 버스트를 넘어서면 대기한다', async () => {
  let currentTime = 0
  const waits = []
  const acquire = createDoorayRateLimiter({
    ratePerSecond: 5,
    burst: 2,
    now: () => currentTime,
    sleep: async (durationMs) => {
      waits.push(durationMs)
      currentTime += durationMs
    },
  })
  await acquire()
  await acquire()
  assert.deepEqual(waits, [])
  await acquire()
  assert.equal(waits.length, 1)
  assert.equal(waits[0], 200)
})

test('접근 가능한 프로젝트 범위를 동시에 조회하고 중복을 합친다', async () => {
  const started = new Set()
  let releaseRequests
  let resolveAllStarted
  const requestGate = new Promise((resolve) => { releaseRequests = resolve })
  const allStarted = new Promise((resolve) => { resolveAllStarted = resolve })
  const fetchImpl = async (endpoint) => {
    const url = new URL(endpoint)
    const key = `${url.searchParams.get('scope')}:${url.searchParams.get('type')}`
    started.add(key)
    if (started.size === 3) resolveAllStarted()
    await requestGate
    if (key === 'private:public') {
      return jsonResponse(successPayload([{ id: 'p1', code: 'roy-jp', name: 'J로얄' }]))
    }
    if (key === 'public:public') {
      return jsonResponse(successPayload([{ id: 'p2', code: 'common', name: '공통' }]))
    }
    return jsonResponse(successPayload([{ id: 'p1', code: '', name: '' }]))
  }

  const loading = listDoorayMentionProjects(config, { fetchImpl, sleep: async () => {} })
  let simultaneous = false
  try {
    await Promise.race([
      allStarted,
      new Promise((resolve) => { setTimeout(resolve, 500) }),
    ])
    simultaneous = started.size === 3
  } finally {
    releaseRequests()
  }
  const result = await loading
  assert.equal(simultaneous, true)
  assert.deepEqual(result.projects, [
    { id: 'p2', code: 'common', name: '공통' },
    { id: 'p1', code: 'roy-jp', name: 'J로얄' },
  ])
})

function createDoorayStub({ posts, detail, logs }) {
  const calls = []
  const fetchImpl = async (endpoint) => {
    const url = new URL(endpoint)
    const route = url.pathname
    calls.push(route)
    if (route === '/common/v1/members/me') {
      return jsonResponse(successPayload({ id: meId, name: '김용민' }))
    }
    if (route === '/project/v1/projects') {
      const scope = url.searchParams.get('scope')
      const type = url.searchParams.get('type')
      return jsonResponse(successPayload(
        scope === 'private' && type === 'public' ? [{ id: 'p1', code: 'roy-jp' }] : [],
      ))
    }
    if (route === '/project/v1/projects/p1/posts') {
      assert.equal(url.searchParams.get('updatedAt'), '2026-09-03T00:00:00.000Z')
      return jsonResponse(successPayload(Number(url.searchParams.get('page')) === 0 ? posts : []))
    }
    if (route === '/project/v1/projects/p1/posts/a1') return jsonResponse(successPayload(detail))
    if (route === '/project/v1/projects/p1/posts/a1/logs') return jsonResponse(successPayload(logs))
    if (route === `/common/v1/members/${'300'}`) {
      return jsonResponse(successPayload({ id: '300', name: '이미경' }))
    }
    return jsonResponse({ header: { isSuccessful: false, resultMessage: 'null' } }, 404)
  }
  return { fetchImpl, calls }
}

const basePost = {
  id: 'a1',
  number: 70,
  taskNumber: 'roy-jp/70',
  subject: '[J로얄]<서버> 로그인 구현',
  createdAt: '2026-09-04T10:00:00+09:00',
  updatedAt: '2026-09-09T18:54:53+09:00',
  closed: false,
  workflowClass: 'working',
  workflow: { id: 'w1', name: '진행 중' },
  project: { id: 'p1', code: 'roy-jp' },
  users: {
    from: { type: 'member', member: { organizationMemberId: '200', name: '천기환' } },
    to: [{ type: 'member', member: { organizationMemberId: meId, name: '김용민' } }],
    cc: [],
  },
}

const baseDetail = {
  ...basePost,
  body: { mimeType: 'text/x-markdown', content: `${markdownMention} 수석님 확인 부탁드립니다` },
}

const baseLogs = [
  {
    id: 'c1',
    type: 'comment',
    createdAt: '2026-09-07T16:08:15+09:00',
    creator: { type: 'member', member: { organizationMemberId: '200', name: '천기환' } },
    body: { mimeType: 'text/x-markdown', content: `${markdownMention} 프로토콜 공유드립니다` },
  },
  {
    id: 'c2',
    type: 'comment',
    createdAt: '2026-09-08T09:00:00+09:00',
    creator: { type: 'member', member: { organizationMemberId: meId, name: '김용민' } },
    body: { mimeType: 'text/x-markdown', content: `${otherMarkdownMention} 확인했습니다` },
  },
  {
    id: 'c3',
    type: 'comment',
    createdAt: '2026-09-08T11:00:00+09:00',
    creator: { type: 'member', member: { organizationMemberId: '300' } },
    body: { mimeType: 'text/html', content: '<div>기획서 업데이트했습니다</div>' },
  },
  {
    id: 'c4',
    type: 'comment',
    createdAt: '2026-08-20T11:00:00+09:00',
    creator: { type: 'member', member: { organizationMemberId: '200', name: '천기환' } },
    body: { mimeType: 'text/x-markdown', content: `${markdownMention} 기간 밖 댓글` },
  },
]

const collectOptions = {
  config,
  since: '2026-09-03T00:00:00Z',
  until: '2026-09-10T00:00:00Z',
  webHostname: 'nhnent.dooray.com',
}

const collectDeps = (fetchImpl, extra = {}) => ({
  fetchImpl,
  sleep: async () => {},
  now: () => new Date('2026-09-10T05:00:00Z'),
  ...extra,
})

test('기간 안의 멘션과 담당 업무 활동을 모아 정렬한다', async () => {
  const { fetchImpl } = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const phases = []
  const result = await collectDoorayMentions(collectOptions, collectDeps(fetchImpl, {
    onProgress: ({ phase }) => { phases.push(phase) },
  }))

  assert.equal(result.me.name, '김용민')
  assert.equal(result.projectCount, 1)
  assert.equal(result.scannedPostCount, 1)
  assert.equal(result.throttledCount, 0)
  assert.equal(result.failureCount, 0)

  const summary = result.items.map((item) => [item.kind, item.commentId, item.actorName])
  assert.deepEqual(summary, [
    ['mention-body', null, '천기환'],
    ['related-comment', 'c3', '이미경'],
    ['mention-comment', 'c1', '천기환'],
    ['assigned', null, '천기환'],
  ])

  const mentionComment = result.items.find((item) => item.commentId === 'c1')
  assert.equal(mentionComment.url, 'https://nhnent.dooray.com/task/p1/a1#comment-c1')
  assert.equal(mentionComment.key, 'comment:a1:c1')
  assert.equal(mentionComment.excerpt, '@김용민 프로토콜 공유드립니다')
  assert.equal(mentionComment.subject, '[J로얄]<서버> 로그인 구현')
  assert.equal(mentionComment.projectCode, 'roy-jp')
  assert.equal(mentionComment.workflowName, '진행 중')

  // 내가 쓴 댓글(c2)과 기간 밖 댓글(c4)은 빠진다.
  assert.equal(result.items.some((item) => item.commentId === 'c2'), false)
  assert.equal(result.items.some((item) => item.commentId === 'c4'), false)
  assert.equal(phases.includes('projects'), true)
  assert.equal(phases.at(-1), 'done')
})

test('업무 본문과 댓글 조회를 동시에 시작한다', async () => {
  const stub = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const started = new Set()
  let releaseRequests
  let resolveBothStarted
  const requestGate = new Promise((resolve) => { releaseRequests = resolve })
  const bothStarted = new Promise((resolve) => { resolveBothStarted = resolve })
  const fetchImpl = async (endpoint, init) => {
    const route = new URL(endpoint).pathname
    if (route === '/project/v1/projects/p1/posts/a1' || route === '/project/v1/projects/p1/posts/a1/logs') {
      started.add(route)
      if (started.size === 2) resolveBothStarted()
      await requestGate
    }
    return stub.fetchImpl(endpoint, init)
  }

  const collecting = collectDoorayMentions(collectOptions, collectDeps(fetchImpl, { concurrency: 1 }))
  let simultaneous = false
  try {
    await Promise.race([
      bothStarted,
      new Promise((resolve) => { setTimeout(resolve, 500) }),
    ])
    simultaneous = started.size === 2
  } finally {
    releaseRequests()
  }
  await collecting
  assert.equal(simultaneous, true)
})

test('내가 등록하고 나를 지정한 업무는 확인 대상에서 뺀다', async () => {
  const selfPost = {
    ...basePost,
    users: {
      from: { type: 'member', member: { organizationMemberId: meId, name: '김용민' } },
      to: [{ type: 'member', member: { organizationMemberId: meId, name: '김용민' } }],
      cc: [],
    },
  }
  const { fetchImpl } = createDoorayStub({
    posts: [selfPost],
    detail: { ...selfPost, body: baseDetail.body },
    logs: baseLogs,
  })
  const result = await collectDoorayMentions(collectOptions, collectDeps(fetchImpl))
  // 자동 생성한 일일 취합 업무처럼 스스로 만든 업무는 본문 멘션과 담당 지정 모두 제외된다.
  assert.equal(result.items.some((item) => item.kind === 'mention-body'), false)
  assert.equal(result.items.some((item) => item.kind === 'assigned'), false)
  // 남이 남긴 댓글은 그대로 남는다.
  assert.deepEqual(
    result.items.map((item) => item.commentId),
    ['c3', 'c1'],
  )
})

test('본문과 담당 활동을 끄면 멘션 댓글만 남는다', async () => {
  const { fetchImpl, calls } = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const result = await collectDoorayMentions(
    { ...collectOptions, includeBody: false, includeAssigned: false },
    collectDeps(fetchImpl),
  )
  assert.deepEqual(result.items.map((item) => item.kind), ['mention-comment'])
  // 본문을 보지 않으면 업무 상세는 호출하지 않는다.
  assert.equal(calls.includes('/project/v1/projects/p1/posts/a1'), false)
})

test('본문과 댓글 멘션을 서로 독립적으로 선택한다', async () => {
  const bodyOnlyStub = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const bodyOnly = await collectDoorayMentions(
    {
      ...collectOptions,
      includeComments: false,
      includeAssigned: false,
      includeCc: false,
    },
    collectDeps(bodyOnlyStub.fetchImpl),
  )
  assert.deepEqual(bodyOnly.items.map((item) => item.kind), ['mention-body'])
  assert.equal(bodyOnlyStub.calls.filter((route) => route.endsWith('/logs')).length, 0)

  const commentsOnlyStub = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const commentsOnly = await collectDoorayMentions(
    {
      ...collectOptions,
      includeBody: false,
      includeAssigned: false,
      includeCc: false,
    },
    collectDeps(commentsOnlyStub.fetchImpl),
  )
  assert.deepEqual(commentsOnly.items.map((item) => item.kind), ['mention-comment'])
  assert.equal(commentsOnlyStub.calls.includes('/project/v1/projects/p1/posts/a1'), false)
})

test('댓글 멘션을 꺼도 담당 업무의 댓글 활동은 유지한다', async () => {
  const stub = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const result = await collectDoorayMentions(
    { ...collectOptions, includeBody: false, includeComments: false },
    collectDeps(stub.fetchImpl),
  )
  assert.deepEqual(
    result.items.map((item) => item.kind),
    ['related-comment', 'related-comment', 'assigned'],
  )
})

test('담당 업무와 참조 업무를 서로 독립적으로 선택한다', async () => {
  const ccPost = {
    ...basePost,
    users: {
      ...basePost.users,
      to: [],
      cc: [{ type: 'member', member: { organizationMemberId: meId, name: '김용민' } }],
    },
  }
  const logs = [baseLogs.find((entry) => entry.id === 'c3')]

  const ccStub = createDoorayStub({ posts: [ccPost], detail: ccPost, logs })
  const ccOnly = await collectDoorayMentions(
    { ...collectOptions, includeBody: false, includeAssigned: false, includeCc: true },
    collectDeps(ccStub.fetchImpl),
  )
  assert.deepEqual(ccOnly.items.map((item) => item.kind), ['related-comment', 'cc'])

  const assignedStub = createDoorayStub({ posts: [ccPost], detail: ccPost, logs })
  const assignedOnly = await collectDoorayMentions(
    { ...collectOptions, includeBody: false, includeAssigned: true, includeCc: false },
    collectDeps(assignedStub.fetchImpl),
  )
  assert.deepEqual(assignedOnly.items, [])
})

test('updatedAt이 그대로면 캐시를 재사용해 상세를 다시 읽지 않는다', async () => {
  const first = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const initial = await collectDoorayMentions(collectOptions, collectDeps(first.fetchImpl))
  assert.equal(first.calls.filter((route) => route.endsWith('/logs')).length, 1)
  assert.equal(initial.cache.a1.updatedAt, basePost.updatedAt)

  const second = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const cached = await collectDoorayMentions(
    { ...collectOptions, cache: initial.cache },
    collectDeps(second.fetchImpl),
  )
  assert.equal(second.calls.filter((route) => route.endsWith('/logs')).length, 0)
  assert.equal(second.calls.includes('/project/v1/projects/p1/posts/a1'), false)
  assert.deepEqual(
    cached.items.map((item) => item.key),
    initial.items.map((item) => item.key),
  )
})

test('수집 옵션이 바뀌면 같은 updatedAt의 캐시도 다시 만든다', async () => {
  const first = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const reduced = await collectDoorayMentions(
    { ...collectOptions, includeBody: false, includeAssigned: false },
    collectDeps(first.fetchImpl),
  )
  assert.deepEqual(reduced.items.map((item) => item.kind), ['mention-comment'])

  const second = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const expanded = await collectDoorayMentions(
    { ...collectOptions, cache: reduced.cache },
    collectDeps(second.fetchImpl),
  )
  assert.equal(second.calls.includes('/project/v1/projects/p1/posts/a1'), true)
  assert.equal(second.calls.filter((route) => route.endsWith('/logs')).length, 1)
  assert.deepEqual(
    expanded.items.map((item) => item.kind),
    ['mention-body', 'related-comment', 'mention-comment', 'assigned'],
  )

  const third = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const reducedAgain = await collectDoorayMentions(
    { ...collectOptions, includeBody: false, includeAssigned: false, cache: expanded.cache },
    collectDeps(third.fetchImpl),
  )
  assert.equal(third.calls.filter((route) => route.endsWith('/logs')).length, 1)
  assert.deepEqual(reducedAgain.items.map((item) => item.kind), ['mention-comment'])
})

test('업무가 갱신되면 캐시를 무시하고 다시 읽는다', async () => {
  const stale = { a1: { updatedAt: '2026-09-05T00:00:00+09:00', seenAt: '2026-09-05T00:00:00Z', items: [] } }
  const { fetchImpl, calls } = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const result = await collectDoorayMentions({ ...collectOptions, cache: stale }, collectDeps(fetchImpl))
  assert.equal(calls.filter((route) => route.endsWith('/logs')).length, 1)
  assert.equal(result.items.length, 4)
})

test('429는 재시도하고 권한 없는 업무는 건너뛴다', async () => {
  let throttled = 0
  const stub = createDoorayStub({ posts: [basePost], detail: baseDetail, logs: baseLogs })
  const fetchImpl = async (endpoint, init) => {
    if (endpoint.endsWith('/logs?size=100') && throttled < 2) {
      throttled += 1
      return jsonResponse({}, 429)
    }
    if (endpoint.includes('/posts/a1?') || endpoint.endsWith('/posts/a1')) {
      return jsonResponse({ header: { isSuccessful: false } }, 403)
    }
    return stub.fetchImpl(endpoint, init)
  }
  const result = await collectDoorayMentions(collectOptions, collectDeps(fetchImpl))
  assert.equal(result.throttledCount, 2)
  assert.equal(result.failureCount, 0)
  // 상세를 못 읽어도 댓글 기반 항목은 그대로 수집된다.
  assert.deepEqual(
    result.items.map((item) => item.kind),
    ['related-comment', 'mention-comment', 'assigned'],
  )
})

test('API 키가 없으면 수집을 시작하지 않는다', async () => {
  await assert.rejects(
    collectDoorayMentions({ ...collectOptions, config: { apiKey: '', baseUrl: 'https://api.dooray.com' } }, collectDeps(async () => {
      throw new Error('호출되면 안 된다')
    })),
    (error) => error instanceof DoorayTaskError && error.code === 'CONFIG_UNAVAILABLE',
  )
})

test('확인 상태를 항목에 붙이고 사라진 항목은 정리한다', () => {
  const items = [{ key: 'comment:1:2' }, { key: 'post-role:1:assigned' }]
  const merged = mergeDoorayMentionAcks(items, { 'comment:1:2': { acknowledgedAt: '2026-09-10T00:00:00Z' } })
  assert.equal(merged[0].acknowledgedAt, '2026-09-10T00:00:00Z')
  assert.equal(merged[1].acknowledgedAt, null)

  // 기간을 좁혀 다시 수집해도 확인 표시는 남아야 하므로 오래된 것만 나이로 정리한다.
  const pruned = pruneDoorayMentionAcks({
    recent: { acknowledgedAt: '2026-09-01T00:00:00Z' },
    ancient: { acknowledgedAt: '2025-01-01T00:00:00Z' },
    broken: {},
  }, { now: () => new Date('2026-09-10T00:00:00Z') })
  assert.deepEqual(Object.keys(pruned), ['recent'])
})

test('오래 보지 않은 캐시 항목은 버린다', () => {
  const cache = {
    fresh: { updatedAt: 'u', seenAt: '2026-09-01T00:00:00Z', items: [] },
    stale: { updatedAt: 'u', seenAt: '2026-01-01T00:00:00Z', items: [] },
    broken: { updatedAt: 'u', items: [] },
  }
  const pruned = pruneDoorayMentionCache(cache, { now: () => new Date('2026-09-10T00:00:00Z') })
  assert.deepEqual(Object.keys(pruned), ['fresh'])
})

test('정렬은 최신 항목과 멘션을 앞세운다', () => {
  const sorted = sortDoorayMentionItems([
    { key: 'b', kind: 'related-comment', occurredAt: '2026-09-08T00:00:00Z' },
    { key: 'a', kind: 'mention-comment', occurredAt: '2026-09-08T00:00:00Z' },
    { key: 'c', kind: 'mention-comment', occurredAt: '2026-09-09T00:00:00Z' },
  ])
  assert.deepEqual(sorted.map((item) => item.key), ['c', 'a', 'b'])
})
