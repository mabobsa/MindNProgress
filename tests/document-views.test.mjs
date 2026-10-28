import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { DOCUMENT_VIEWS, DOCUMENT_VIEW_FORMAT, buildDocumentView, documentEtag } from '../mcp/documentViews.mjs'

const publicBaseUrl = 'https://mindnprogress.test/'
const user = { id: 'user-editor', name: '편집자', email: 'editor@example.invalid', role: 'editor', publicAccess: false }
const imageAccess = { mode: 'local-file', localPath: 'C:/data/_assets/map-views/image.png', fileName: 'image.png', mimeType: 'image/png' }
const imageAccessOf = (_mapId, node) => node.data?.kind === 'image' ? imageAccess : null

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function fixture({ withReference = false } = {}) {
  const nodes = [
    { id: 'root', type: 'mind', position: { x: 0, y: 0 }, data: { label: '루트', kind: 'root', status: 'in-progress', progress: 40, isWork: false, description: '루트 설명', sharedKnowledge: '' } },
    {
      id: 'task-a', type: 'mind', position: { x: 240, y: 0 },
      data: {
        label: '업무 A', kind: 'task', status: 'in-progress', progress: 50, isWork: true,
        description: '업무 A의 요구사항 원문입니다.\n완료 조건 두 가지.',
        sharedKnowledge: '업무 A의 재사용 결론',
        sharedKnowledgeUpdatedAt: '2026-10-21T00:00:00.000Z',
        sharedKnowledgeUpdatedBy: user,
        checklist: [{ id: 'c1', text: '구현', done: true }, { id: 'c2', text: '검증', done: false }],
        waitingItems: [{ id: 'w1', label: '서버 API', note: '긴 메모 원문', resumeCondition: 'API 배포', since: '2026-10-20' }],
        blockedBy: ['task-b'],
        requirementIds: ['REQ-1', 'REQ-2'],
        requirementConditions: ['REQ-1: 로그인 성공'],
        ownedFiles: ['src/a.ts'],
        aiConversationId: 'conv-1',
        aiConversations: [{ conversationId: 'conv-1', skills: ['x'], mcpServers: ['mnp'] }, { conversationId: 'conv-2', skills: [], mcpServers: [] }],
      },
    },
    { id: 'task-b', type: 'mind', position: { x: 240, y: 120 }, data: { label: '업무 B', kind: 'task', status: 'done', progress: 100, isWork: true, description: 'B 원문', sharedKnowledge: 'B 지식' } },
    { id: 'image-1', type: 'mind', position: { x: 480, y: 0 }, data: { label: '이미지', kind: 'image', status: 'planned', progress: 0, description: '화면 원본', image: { assetId: 'image.png', mimeType: 'image/png' } } },
  ]
  if (withReference) {
    nodes.push({ id: 'ref-1', type: 'mind', position: { x: 480, y: 120 }, data: { label: 'Ref', kind: 'task', status: 'planned', progress: 0, description: '원본 문서의 투영 본문', reference: { mapId: 'map-source', nodeId: 'source-1' } } })
  }
  const edges = [
    { id: 'e1', source: 'root', target: 'task-a', type: 'smoothstep', markerEnd: { type: 'arrowclosed' }, reconnectable: 'target', data: { relation: 'hierarchy' } },
    { id: 'e2', source: 'root', target: 'task-b', type: 'smoothstep', markerEnd: { type: 'arrowclosed' }, data: { relation: 'hierarchy' } },
    { id: 'e3', source: 'root', target: 'image-1', type: 'smoothstep', markerEnd: { type: 'arrowclosed' }, data: { relation: 'hierarchy' } },
    { id: 'k1', source: 'task-b', target: 'task-a', type: 'knowledge', markerEnd: { type: 'arrowclosed' }, data: { relation: 'knowledge', knowledgePolicy: 'inspect-if-insufficient' } },
  ]
  if (withReference) edges.push({ id: 'e4', source: 'root', target: 'ref-1', type: 'smoothstep', data: { relation: 'hierarchy' } })
  return {
    map: { id: 'map-views', title: '보기 검증', color: 'blue', createdAt: '2026-10-01', createdBy: user, updatedAt: '2026-10-21', updatedBy: user, version: 7, nodes, edges },
    group: { id: 'group-1', name: '그룹' },
    groupMembership: 'grouped',
    documentGroups: [{ mapId: 'map-views', group: { id: 'group-1', name: '그룹' }, groupMembership: 'grouped' }],
    referenceCommentStats: withReference ? { 'ref-1': { total: 1 } } : {},
    unresolvedReferenceNodeIds: [],
    delegationOrigin: { mapId: 'map-views', cardId: 'task-a', source: 'conversation-origin' },
  }
}

// Verbatim copy of the get_document handler before views were added. full must stay byte-identical to this.
function legacyFullResponse(documentResult, health) {
  const documentAccessUrl = (base, mapId) => `${String(base).replace(/\/+$/, '')}/mindmap/${encodeURIComponent(mapId)}`
  const cardAccessUrl = (base, mapId, cardId) => `${documentAccessUrl(base, mapId)}/${encodeURIComponent(cardId)}`
  return {
    ...documentResult,
    access: {
      publicBaseUrl: health.publicBaseUrl,
      documentUrl: documentAccessUrl(health.publicBaseUrl, documentResult.map.id),
      cards: documentResult.map.nodes.map((node) => {
        const access = imageAccessOf(documentResult.map.id, node)
        return {
          cardId: node.id,
          label: node.data?.label ?? node.id,
          kind: node.data?.kind,
          accessUrl: cardAccessUrl(health.publicBaseUrl, documentResult.map.id, node.id),
          ...(access ? { imageAccess: access } : {}),
        }
      }),
      rule: '웹 링크를 기록할 때 localhost나 127.0.0.1로 재작성하지 말고 accessUrl을 그대로 사용하세요. 이미지 카드의 imageAccess.localPath는 기록용 링크가 아니라 로컬 원본을 직접 열람할 때만 사용하세요.',
    },
  }
}

const view = (documentResult, options = {}) => buildDocumentView(structuredClone(documentResult), { publicBaseUrl, imageAccessOf, ...options })

// Required field contract per view. Missing any of these must fail.
const SAFETY_FIELDS = ['group', 'groupMembership', 'documentGroups', 'delegationOrigin', 'unresolvedReferenceNodeIds']
const VIEW_CONTRACTS = {
  compact: {
    top: ['view', ...SAFETY_FIELDS, 'referenceCommentStats', 'map', 'documentEtag', 'access', 'omitted'],
    map: ['id', 'title', 'color', 'version', 'updatedAt', 'updatedBy', 'nodes', 'edges'],
    node: ['id', 'position', 'data', 'textIntegrity'],
    data: ['label', 'kind', 'status', 'progress', 'description', 'sharedKnowledge', 'checklist', 'waitingItems', 'blockedBy', 'requirementIds', 'requirementConditions', 'aiConversationCount'],
    edge: ['id', 'source', 'target', 'data'],
    access: ['publicBaseUrl', 'documentUrl', 'cardAccessUrlTemplate', 'imageCards', 'rule'],
    omitted: ['fields', 'notOmitted', 'rule', 'retrieval'],
  },
  outline: {
    top: ['view', ...SAFETY_FIELDS, 'referenceCommentStats', 'map', 'documentEtag', 'stats', 'cards', 'knowledgeLinks', 'selectedCards', 'access', 'omitted'],
    map: ['id', 'title', 'version', 'updatedAt', 'updatedBy', 'accessUrl'],
    card: ['id', 'parentId', 'childCount', 'data', 'textIntegrity'],
    data: ['label', 'kind', 'status', 'progress', 'isWork', 'waitingItems', 'blockedBy', 'requirementIds', 'requirementConditions', 'checklistSummary', 'aiConversationCount', 'sharedKnowledgeUpdatedBy'],
    link: ['sourceId', 'targetId', 'policy'],
    omitted: ['cardIds', 'fields', 'notOmitted', 'rule', 'retrieval'],
  },
  version: {
    top: ['view', ...SAFETY_FIELDS, 'map', 'documentEtag', 'stats', 'omitted', 'versionScope'],
    map: ['id', 'title', 'color', 'version', 'updatedAt', 'updatedBy'],
    stats: ['cardCount', 'hierarchyEdgeCount', 'knowledgeEdgeCount', 'referenceCardCount'],
  },
}

function requireKeys(value, keys, label) {
  for (const key of keys) assert.ok(value && Object.hasOwn(value, key), `${label}.${key} 필드 누락`)
}

function assertViewContract(name, response) {
  const contract = VIEW_CONTRACTS[name]
  assert.equal(response.view, name)
  requireKeys(response, contract.top, name)
  requireKeys(response.map, contract.map, `${name}.map`)
  if (name === 'compact') {
    for (const node of response.map.nodes) requireKeys(node, contract.node, 'compact.node')
    requireKeys(response.map.nodes.find((node) => node.id === 'task-a').data, contract.data, 'compact.task-a.data')
    for (const edge of response.map.edges) requireKeys(edge, contract.edge, 'compact.edge')
    requireKeys(response.access, contract.access, 'compact.access')
    requireKeys(response.omitted, contract.omitted, 'compact.omitted')
  }
  if (name === 'outline') {
    for (const card of response.cards) requireKeys(card, contract.card, 'outline.card')
    requireKeys(response.cards.find((card) => card.id === 'task-a').data, contract.data, 'outline.task-a.data')
    for (const link of response.knowledgeLinks) requireKeys(link, contract.link, 'outline.link')
    requireKeys(response.omitted, contract.omitted, 'outline.omitted')
  }
  if (name === 'version') requireKeys(response.stats, contract.stats, 'version.stats')
}

test('view를 생략한 full 응답은 기존 get_document 응답과 바이트 단위로 같다', () => {
  for (const withReference of [false, true]) {
    const documentResult = fixture({ withReference })
    const expected = JSON.stringify(legacyFullResponse(structuredClone(documentResult), { publicBaseUrl }))
    assert.equal(JSON.stringify(view(documentResult)), expected)
    assert.equal(JSON.stringify(view(documentResult, { view: 'full' })), expected)
    // knownVersion이 맞지 않거나 Ref 때문에 생략하지 않을 때도 full 형태는 그대로다.
    assert.equal(JSON.stringify(view(documentResult, { knownVersion: 6 })), expected)
    if (withReference) assert.equal(JSON.stringify(view(documentResult, { knownVersion: 7 })), expected)
  }
  assert.deepEqual(DOCUMENT_VIEWS, ['full', 'compact', 'outline', 'version'])
})

test('compact·outline·version은 필수 필드 계약을 지키고 필드 누락을 거부한다', () => {
  const documentResult = fixture()
  for (const name of ['compact', 'outline', 'version']) {
    const response = view(documentResult, { view: name })
    assertViewContract(name, response)
    for (const key of VIEW_CONTRACTS[name].top) {
      const broken = structuredClone(response)
      delete broken[key]
      assert.throws(() => assertViewContract(name, broken), { code: 'ERR_ASSERTION' }, `${name}.${key} 누락 검출`)
    }
    for (const key of VIEW_CONTRACTS[name].map) {
      const broken = structuredClone(response)
      delete broken.map[key]
      assert.throws(() => assertViewContract(name, broken), { code: 'ERR_ASSERTION' }, `${name}.map.${key} 누락 검출`)
    }
  }
  const outline = view(documentResult, { view: 'outline' })
  for (const key of VIEW_CONTRACTS.outline.data) {
    const broken = structuredClone(outline)
    delete broken.cards.find((card) => card.id === 'task-a').data[key]
    assert.throws(() => assertViewContract('outline', broken), { code: 'ERR_ASSERTION' }, `outline data.${key} 누락 검출`)
  }
})

test('compact는 카드 원문과 관계를 유지하고 정해진 렌더링·계정 상세만 줄인다', () => {
  const documentResult = fixture()
  const compact = view(documentResult, { view: 'compact' })
  for (const original of documentResult.map.nodes) {
    const projected = compact.map.nodes.find((node) => node.id === original.id)
    const { aiConversations, sharedKnowledgeUpdatedBy, ...rest } = original.data
    assert.deepEqual({ ...projected.data, sharedKnowledgeUpdatedBy: undefined, aiConversationCount: undefined }, { ...rest, sharedKnowledgeUpdatedBy: undefined, aiConversationCount: undefined })
    if (aiConversations) assert.equal(projected.data.aiConversationCount, aiConversations.length)
    if (sharedKnowledgeUpdatedBy) assert.deepEqual(projected.data.sharedKnowledgeUpdatedBy, { id: user.id, name: user.name })
    assert.deepEqual(projected.position, original.position)
    assert.equal(projected.textIntegrity.description.sha256, sha256(original.data.description ?? ''))
  }
  assert.deepEqual(compact.map.updatedBy, { id: user.id, name: user.name })
  assert.deepEqual(compact.map.edges.find((edge) => edge.id === 'k1'), { id: 'k1', source: 'task-b', target: 'task-a', data: { relation: 'knowledge', knowledgePolicy: 'inspect-if-insufficient' } })
  assert.equal(compact.access.cardAccessUrlTemplate, 'https://mindnprogress.test/mindmap/map-views/{cardId}')
  assert.deepEqual(compact.access.imageCards, [{ cardId: 'image-1', imageAccess }])
  assert.equal(JSON.stringify(compact).includes(user.email), false)
  assert.ok(Object.keys(compact.omitted.fields).some((key) => key.includes('aiConversations')))
  assert.match(compact.omitted.notOmitted, /aiConversations 이외의 모든 data 필드.*aiConversationCount만 제공/s)
  assert.equal(compact.omitted.retrieval.aiConversations.tool, 'mindnprogress_list_ai_conversations')
})

test('outline은 생략 사실·범위·회수 경로를 표기하고 cardIds 카드만 전문을 준다', () => {
  const documentResult = fixture()
  const outline = view(documentResult, { view: 'outline', cardIds: ['task-a'] })
  const task = outline.cards.find((card) => card.id === 'task-a')
  for (const field of ['description', 'sharedKnowledge', 'checklist', 'aiConversations']) assert.equal(Object.hasOwn(task.data, field), false)
  assert.equal(task.textIntegrity.description.length, documentResult.map.nodes[1].data.description.length)
  assert.equal(task.textIntegrity.sharedKnowledge.sha256, sha256('업무 A의 재사용 결론'))
  assert.deepEqual(task.data.checklistSummary, { total: 2, done: 1 })
  // 대기 메모에는 재개를 제한하는 금지·예외 조건이 있을 수 있어 outline에서도 원문을 유지한다.
  assert.deepEqual(task.data.waitingItems, documentResult.map.nodes[1].data.waitingItems)
  assert.equal(Object.keys(outline.omitted.fields).some((key) => key.includes('waitingItems')), false)
  assert.match(outline.omitted.notOmitted, /waitingItems 항목 전체\(note 원문 포함\)/)
  assert.match(outline.omitted.fields['cards[].data.checklist'], /미완료 항목.*승인·검증 조건.*완료·검수·위임 판단 전.*항목 원문을 확인/s)
  assert.deepEqual(task.data.requirementIds, ['REQ-1', 'REQ-2'])
  assert.deepEqual(task.data.blockedBy, ['task-b'])
  assert.equal(task.parentId, 'root')
  assert.equal(outline.cards.find((card) => card.id === 'root').childCount, 3)
  assert.deepEqual(outline.knowledgeLinks, [{ sourceId: 'task-b', targetId: 'task-a', policy: 'inspect-if-insufficient' }])

  assert.equal(outline.selectedCards.length, 1)
  assert.equal(outline.selectedCards[0].data.description, documentResult.map.nodes[1].data.description)
  assert.deepEqual(outline.selectedCards[0].data.checklist, documentResult.map.nodes[1].data.checklist)
  assert.equal(outline.selectedCards[0].accessUrl, 'https://mindnprogress.test/mindmap/map-views/task-a')
  assert.deepEqual(outline.omitted.cardIds, ['root', 'task-b', 'image-1'])
  assert.ok(Object.keys(outline.omitted.fields).some((key) => key.includes('description')))
  assert.match(outline.omitted.rule, /생략된 원문.*retrieval/)
  assert.deepEqual(outline.omitted.retrieval.selectedCards.arguments, { mapId: 'map-views', view: 'outline', cardIds: ['<cardId>'] })
  assert.deepEqual(outline.omitted.retrieval.singleCard, { tool: 'mindnprogress_get_card', arguments: { mapId: 'map-views', cardId: '<cardId>' } })
  assert.deepEqual(outline.omitted.retrieval.fullDocument.arguments, { mapId: 'map-views', view: 'full' })

  // 회수 경로로 받은 전문은 full 원문과 같다.
  const recovered = view(documentResult, { view: 'outline', cardIds: outline.omitted.cardIds })
  for (const card of recovered.selectedCards) {
    assert.equal(card.data.description, documentResult.map.nodes.find((node) => node.id === card.id).data.description)
  }
  assert.deepEqual(recovered.omitted.cardIds, ['task-a'])
})

test('같은 view·cardIds로 받은 documentEtag만 같은 문서 재전송을 피한다', () => {
  const documentResult = fixture()
  const version = view(documentResult, { view: 'version' })
  assert.equal(version.map.version, 7)
  assert.equal(Object.hasOwn(version.map, 'nodes'), false)
  assert.equal(version.documentEtag, documentEtag(documentResult, { view: 'version' }))
  assert.match(version.documentEtag, /^v7-version-[0-9a-f]{32}$/)
  assert.match(version.versionScope, /list_comments/)
  assert.match(version.omitted.rule, /stats\.referenceCardCount가 0보다 크면.*Ref 카드 원본은 바뀌었을 수.*documentEtag가 없는 full이면.*mindnprogress_get_card/s)

  // 같은 view(와 outline의 같은 cardIds)로 받은 etag일 때만 생략한다.
  const compact = view(documentResult, { view: 'compact' })
  const outline = view(documentResult, { view: 'outline' })
  const outlineA = view(documentResult, { view: 'outline', cardIds: ['task-a'] })
  const representations = [
    ['version', undefined, version.documentEtag],
    ['compact', undefined, compact.documentEtag],
    ['outline', undefined, outline.documentEtag],
    ['outline', ['task-a'], outlineA.documentEtag],
  ]
  assert.equal(new Set(representations.map(([, , etag]) => etag)).size, representations.length, 'view·cardIds마다 documentEtag가 다르다')
  for (const [name, cardIds, etag] of representations) {
    const unchanged = view(documentResult, { view: name, ...(cardIds ? { cardIds } : {}), ifNoneMatch: etag })
    assert.equal(unchanged.notModified, true)
    assert.equal(unchanged.view, name)
    assert.equal(Object.hasOwn(unchanged.map, 'nodes'), false)
    assert.equal(unchanged.group.id, 'group-1')
    assert.deepEqual(unchanged.omitted.retrieval, { tool: 'mindnprogress_get_document', arguments: { mapId: 'map-views', view: name, ...(cardIds ? { cardIds } : {}) } })
    assert.match(unchanged.omitted.rule, /같은 view·cardIds/)
    assert.match(unchanged.omitted.rule, /끝까지 읽었고 원문 그대로 남아 있을 때만.*잘렸거나 일부만 읽었거나.*요약·압축.*확신할 수 없으면 ifNoneMatch 없이 다시 조회/s)
  }
  // cardIds 순서·중복은 표현을 바꾸지 않는다.
  assert.equal(view(documentResult, { view: 'outline', cardIds: ['task-b', 'task-a', 'task-a'] }).documentEtag, view(documentResult, { view: 'outline', cardIds: ['task-a', 'task-b'] }).documentEtag)

  // version 응답의 etag를 compact에 보내면 카드 원문을 받는다.
  const compactWithVersionEtag = view(documentResult, { view: 'compact', ifNoneMatch: version.documentEtag })
  assert.equal(compactWithVersionEtag.notModified, undefined)
  assert.equal(compactWithVersionEtag.freshness.notModified, false)
  assert.equal(compactWithVersionEtag.map.nodes.find((node) => node.id === 'task-a').data.description, documentResult.map.nodes[1].data.description)
  // cardIds 없는 outline etag로 cardIds를 요청하면 selectedCards를 받는다.
  const selectedWithOutlineEtag = view(documentResult, { view: 'outline', cardIds: ['task-a'], ifNoneMatch: outline.documentEtag })
  assert.equal(selectedWithOutlineEtag.notModified, undefined)
  assert.equal(selectedWithOutlineEtag.selectedCards[0].data.description, documentResult.map.nodes[1].data.description)
  // full 응답은 documentEtag를 주지 않으므로 다른 view의 etag로 full 본문이 생략되지 않는다.
  for (const etag of [version.documentEtag, compact.documentEtag, outline.documentEtag]) {
    assert.equal(Object.hasOwn(view(documentResult, { ifNoneMatch: etag }).map, 'nodes'), true)
  }

  const changed = structuredClone(documentResult)
  changed.map.nodes[1].data.description += ' 수정'
  const stale = view(changed, { view: 'outline', ifNoneMatch: outline.documentEtag })
  assert.equal(stale.notModified, undefined)
  assert.equal(stale.freshness.notModified, false)
  assert.ok(stale.cards.length > 0)
})

test('documentEtag는 응답 형식을 반영해 형식 변경 전에 받은 etag로 본문을 생략하지 않는다', () => {
  const documentResult = fixture()
  const etagFor = (viewName, cardIds, format) => {
    const payload = {
      ...(format === undefined ? {} : { format }),
      view: viewName,
      cardIds: cardIds ?? [],
      map: documentResult.map,
      referenceCommentStats: documentResult.referenceCommentStats ?? {},
      unresolvedReferenceNodeIds: documentResult.unresolvedReferenceNodeIds ?? [],
      documentGroups: documentResult.documentGroups ?? [],
      groupProject: documentResult.groupProject ?? null,
    }
    return `v${documentResult.map.version}-${viewName}-${sha256(JSON.stringify(payload)).slice(0, 32)}`
  }
  assert.equal(DOCUMENT_VIEW_FORMAT, 3, '현재 그룹 소속을 포함한 조건부 조회 형식')
  for (const [viewName, cardIds] of [['compact'], ['outline'], ['outline', ['task-a']], ['version']]) {
    const current = view(documentResult, { view: viewName, ...(cardIds ? { cardIds } : {}) })
    assert.equal(current.documentEtag, etagFor(viewName, cardIds, DOCUMENT_VIEW_FORMAT), '현재 형식 식별자가 etag 해시에 들어간다')
    assert.match(current.documentEtag, new RegExp(`^v7-${viewName}-[0-9a-f]{32}$`))
    // 형식 식별자가 없던 이전 etag와 다른 형식 값의 etag는 현재 응답과 일치하지 않는다.
    for (const staleEtag of [etagFor(viewName, cardIds, undefined), etagFor(viewName, cardIds, DOCUMENT_VIEW_FORMAT + 1)]) {
      assert.notEqual(staleEtag, current.documentEtag)
      const refetched = view(documentResult, { view: viewName, ...(cardIds ? { cardIds } : {}), ifNoneMatch: staleEtag })
      assert.equal(refetched.notModified, undefined)
      assert.equal(refetched.freshness.notModified, false)
    }
  }
})

test('knownVersion은 version 일치 여부만 알려 주고 본문을 생략하지 않는다', () => {
  const documentResult = fixture()
  const outlineSelected = view(documentResult, { view: 'outline', cardIds: ['task-a'], knownVersion: 7 })
  assert.equal(outlineSelected.notModified, undefined)
  assert.equal(outlineSelected.freshness.notModified, false)
  assert.equal(outlineSelected.freshness.versionMatched, true)
  assert.match(outlineSelected.freshness.reason, /본문을 생략하지 않습니다.*ifNoneMatch/s)
  assert.equal(outlineSelected.selectedCards[0].id, 'task-a')
  const compact = view(documentResult, { view: 'compact', knownVersion: 7 })
  assert.equal(compact.map.nodes.length, documentResult.map.nodes.length)
  assert.equal(view(documentResult, { view: 'version', knownVersion: 6 }).freshness.versionMatched, false)
  const full = view(documentResult, { knownVersion: 7 })
  assert.equal(full.map.nodes.length, documentResult.map.nodes.length)
  // etag가 맞아도 knownVersion이 다르면 생략하지 않는다.
  const outline = view(documentResult, { view: 'outline' })
  assert.equal(view(documentResult, { view: 'outline', ifNoneMatch: outline.documentEtag, knownVersion: 6 }).notModified, undefined)
})

test('Ref 카드가 있으면 knownVersion 응답에 Ref 원본 변경 한계를 알린다', () => {
  const documentResult = fixture({ withReference: true })
  const outline = view(documentResult, { view: 'outline', knownVersion: 7 })
  assert.equal(outline.notModified, undefined)
  assert.equal(outline.freshness.notModified, false)
  assert.match(outline.freshness.reason, /Ref 카드 1장/)
  // Ref 원본 변경은 문서 version을 바꾸지 않지만 documentEtag는 바뀐다.
  const sourceChanged = structuredClone(documentResult)
  sourceChanged.map.nodes.at(-1).data.description = '원본 문서의 새 본문'
  assert.equal(sourceChanged.map.version, documentResult.map.version)
  assert.notEqual(documentEtag(sourceChanged, { view: 'outline' }), documentEtag(documentResult, { view: 'outline' }))
  assert.equal(view(documentResult, { view: 'outline', ifNoneMatch: documentEtag(documentResult, { view: 'outline' }) }).notModified, true)
  assert.equal(view(sourceChanged, { view: 'outline', ifNoneMatch: documentEtag(documentResult, { view: 'outline' }) }).notModified, undefined)
})

test('cardIds는 outline에서만 받고 없는 카드는 회수 방법과 함께 거부한다', () => {
  const documentResult = fixture()
  for (const name of ['full', 'compact', 'version']) {
    assert.throws(() => view(documentResult, { view: name, cardIds: ['task-a'] }), { reasonCode: 'DOCUMENT_VIEW_ARGUMENT_INVALID' })
  }
  assert.throws(() => view(documentResult, { view: 'outline', cardIds: ['missing'] }), (error) => {
    assert.equal(error.reasonCode, 'DOCUMENT_CARD_NOT_FOUND')
    assert.deepEqual(error.details.missingCardIds, ['missing'])
    assert.match(error.message, /cards\[\]\.id/)
    return true
  })
  assert.throws(() => view(documentResult, { view: 'summary' }), /지원하지 않는 view/)
})
