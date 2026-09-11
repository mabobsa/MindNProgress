import assert from 'node:assert/strict'
import test from 'node:test'
import { loadAiConversationRole, resolveAiConversationRole } from '../src/utils/aiConversationRole.mjs'
import { aiConversationTitle, buildAiConversationPrompt, combineAiEditorRequest, DEFAULT_AI_EDITOR_REQUEST, resolveAiConversationTarget } from '../src/utils/aiConversationLaunch.mjs'
import { buildGroupCoordinatorRequest, buildGroupDocumentProposalRequest } from '../src/utils/aiApprovalInstructions.mjs'

const context = {
  map: { id: 'map-coordinator', nodes: [
    { id: 'task', data: { kind: 'task' } },
    { id: 'root', data: { kind: 'root' } },
  ], edges: [{ source: 'root', target: 'task' }, { source: 'task', target: 'root', data: { relation: 'knowledge' } }] },
  groupProject: { groupId: 'group-manager', coordinatorMapId: 'map-coordinator', role: 'coordinator' },
}
const input = { mapId: context.map.id, cardId: 'root', purpose: 'card' }
const request = buildGroupCoordinatorRequest({ groupId: context.groupProject.groupId })

test('총괄 뷰·루트 선택·우클릭·대화 목록의 신규 시작은 같은 역할과 전문을 사용한다', () => {
  const overview = resolveAiConversationTarget({ explicitTarget: {
    ...input, purpose: 'group-coordination', groupId: 'group-manager', initialRequest: request, fullInitialRequest: true,
  } })
  assert.equal(overview.groupId, 'group-manager')
  const rootSelection = resolveAiConversationTarget({ selection: { ...input, open: true, documentTitle: '총괄', cardLabel: '루트' } })
  const picker = resolveAiConversationTarget({ explicitTarget: input, selection: { open: true, mapId: 'other', cardId: 'other', documentTitle: '다른 선택' } })
  const expected = resolveAiConversationRole(overview, context)
  assert.equal(expected.purpose, 'group-coordination')
  assert.equal(expected.automaticRequest, request)
  for (const target of [rootSelection, picker]) assert.deepEqual(resolveAiConversationRole(target, context), expected)
  const combined = combineAiEditorRequest(expected.automaticRequest, '추가 확인 사항', expected.fullInitialRequest)
  assert.equal(combined, `${request}\n\n추가 확인 사항`)
  const prompt = buildAiConversationPrompt({ ...input, purpose: expected.purpose, editorId: 'fixture-editor', attributionToken: 'fixture-token', request: combined })
  assert.ok(prompt.includes(request))
  assert.match(prompt, /# 그룹의 두 단계 사용자 승인/)
  assert.match(aiConversationTitle({ purpose: expected.purpose, documentTitle: '총괄', cardTitle: '루트' }), /^\[그룹 총괄\]/)
})

test('총괄 문서의 하위 카드·다른 문서 루트·미지정 그룹은 일반 카드 요청을 유지한다', () => {
  for (const [target, value] of [
    [{ ...input, cardId: 'task' }, context],
    [input, { ...context, groupProject: { ...context.groupProject, role: 'document', coordinatorMapId: 'map-other' } }],
    [input, { ...context, groupProject: null }],
    [input, { ...context, groupProject: { ...context.groupProject, role: 'coordinator', coordinatorMapId: 'map-other' } }],
  ]) {
    const role = resolveAiConversationRole(target, value)
    assert.equal(role.purpose, 'card')
    assert.equal(role.automaticRequest, DEFAULT_AI_EDITOR_REQUEST)
  }
})

test('루트 kind만으로 총괄을 판정하지 않고 실제 계층과 원본 여부를 확인한다', () => {
  const nestedRoot = structuredClone(context)
  nestedRoot.map.nodes[0].data.kind = 'root'
  assert.equal(resolveAiConversationRole({ ...input, cardId: 'task' }, nestedRoot).purpose, 'card')
  assert.equal(resolveAiConversationRole(input, nestedRoot).purpose, 'group-coordination')
  const refRoot = structuredClone(context)
  refRoot.map.nodes[1].data.reference = { mapId: 'source', nodeId: 'source-root' }
  assert.equal(resolveAiConversationRole(input, refRoot).purpose, 'card')
})

test('총괄 루트의 지식 정리·문서 재구성·Dooray 승인은 별도 목적과 긴 요청을 유지한다', async () => {
  const initialRequest = '별도 승인 범위\n'.repeat(700) + '끝 문장'
  for (const purpose of ['shared-knowledge-review', 'document-reconstruction', 'dooray-response']) {
    const role = await loadAiConversationRole({ ...input, purpose, initialRequest, fullInitialRequest: true }, {
      fetchImpl: () => { throw new Error('별도 목적에서는 일반 역할을 조회하지 않는다') },
    })
    assert.equal(role.purpose, purpose)
    assert.equal(role.automaticRequest, initialRequest)
    assert.equal(role.fullInitialRequest, true)
  }
})

test('그룹 뷰의 문서별 제안 전문은 중복하거나 버리지 않는다', () => {
  const initialRequest = buildGroupCoordinatorRequest({ groupId: 'group-manager', instruction: buildGroupDocumentProposalRequest({ mapId: 'map-target', cardId: 'target-root', title: '담당 문서' }) })
  assert.equal(resolveAiConversationRole({ ...input, purpose: 'group-coordination', groupId: 'group-manager', initialRequest }, context).automaticRequest, initialRequest)
})

test('일반 카드 경로로 전달한 추가 전문은 총괄 역할을 보완하되 원문 끝까지 보존한다', () => {
  const initialRequest = '전달한 분석 제안\n'.repeat(700) + '마지막 제외 범위'
  const role = resolveAiConversationRole({ ...input, initialRequest, fullInitialRequest: true }, context)
  assert.equal(role.automaticRequest, buildGroupCoordinatorRequest({ groupId: 'group-manager', instruction: initialRequest }))
  assert.ok(role.automaticRequest.includes(initialRequest))
})

test('오래된 총괄 진입점이나 소속 그룹 변경은 일반 카드로 조용히 대체하지 않는다', () => {
  const target = { ...input, purpose: 'group-coordination', groupId: 'group-manager', initialRequest: request }
  assert.throws(() => resolveAiConversationRole(target, { ...context, groupProject: null }), /총괄 문서.*변경/)
  assert.throws(() => resolveAiConversationRole(target, { ...context, groupProject: { ...context.groupProject, groupId: 'group-changed' } }), /소속 그룹이 변경/)
  assert.throws(() => resolveAiConversationRole({ ...target, cardId: 'task' }, context), /최상위 루트/)
})

test('문서 불일치·삭제·보관·카드 없음·그룹 정보 누락은 시작을 차단한다', () => {
  for (const value of [undefined, { map: context.map },
    { ...context, map: { ...context.map, id: 'map-other' } },
    { ...context, map: { ...context.map, trashedAt: '2026-09-11' } },
    { ...context, map: { ...context.map, archivedAt: '2026-09-11' } },
    { ...context, map: { ...context.map, nodes: [] } },
  ]) assert.throws(() => resolveAiConversationRole(input, value), /확인하지 못했습니다/)
})

test('역할 조회는 캐시 없이 읽기만 하며 변경된 최신 역할을 다시 반환한다', async () => {
  let current = context
  const calls = []
  const controller = new AbortController()
  const options = { signal: controller.signal, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => current }
  } }
  assert.equal((await loadAiConversationRole(input, options)).purpose, 'group-coordination')
  current = { ...context, groupProject: null }
  assert.equal((await loadAiConversationRole(input, options)).purpose, 'card')
  assert.equal(calls.length, 2)
  for (const { url, init } of calls) {
    assert.equal(url, '/api/maps/map-coordinator')
    assert.deepEqual(init, { credentials: 'include', cache: 'no-store', signal: controller.signal })
  }
})

test('역할 조회 실패·연결 중단·응답 파싱 실패는 기본 전문으로 우회하지 않는다', async () => {
  await assert.rejects(loadAiConversationRole(input, { fetchImpl: async () => ({ ok: false, json: async () => ({ error: '인증 필요' }) }) }), /인증 필요/)
  await assert.rejects(loadAiConversationRole(input, { fetchImpl: async () => { throw new Error('연결 중단') } }), /연결 중단/)
  await assert.rejects(loadAiConversationRole(input, { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('잘못된 응답') } }) }), /잘못된 응답/)
})
