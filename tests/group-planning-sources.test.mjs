import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createGroupProjects } from '../server/lib/groupProjects.mjs'
import { groupCriteriaFingerprint, applyGroupWaitingReview, groupWaitingDetails } from '../server/lib/groupWaitingReviews.mjs'
import { GROUP_PLANNING_SOURCE_LIMIT, groupPlanningSources, withGroupPlanningSources, groupProjectCriteriaEqual, groupPlanningSourceSummary, groupPlanningBaseline } from '../src/utils/groupPlanningSources.mjs'
import { groupProjectDraftAfterRefresh } from '../src/utils/groupOverview.mjs'
import { buildGroupCoordinatorRequest, buildGroupDocumentRequest } from '../src/utils/aiApprovalInstructions.mjs'

const legacy = () => ({ version: 7, coordinatorMapId: null, source: 'https://example.invalid/기본?x=1&y=2', sourceVersion: 'v0.4', objective: '전체 목표\n\n마지막 절 보존', instructions: '공통 지침\n  들여쓰기 보존' })
const additional = () => ({ id: 'source-added', title: '옷장 추가 기획', source: 'C:\\기획 자료\\옷장 추가.pptx', sourceVersion: 'v0.1' })
const user = { id: 'test', name: '시험 사용자' }

async function fixture(action) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-planning-sources-'))
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()))
  assert.ok(path.basename(directory).startsWith('mnp-planning-sources-'))
  try {
    const map = { id: 'map-test', title: '담당 문서', version: 4, nodes: [{ id: 'root', data: { kind: 'root', label: '최상위', status: 'planned', isWork: false, waitingItems: [{ id: 'wait', label: '최종 아트', resumeCondition: '아트 제공 후 재개' }] } }], edges: [] }
    const group = { id: 'group-test', name: '기획 그룹', mapIds: [map.id] }
    const forbidden = () => { throw Error('기준 저장으로 문서·배치·AI를 변경하면 안 됩니다.') }
    const create = () => createGroupProjects({ dataDirectory: directory, replaceFile: rename, listMaps: async () => [map], readMap: async () => map, saveMap: forbidden, readLayout: async () => ({ groups: [group] }), writeLayout: forbidden, delegations: new Map(), publicDelegation: (item) => item, runtimeSnapshot: () => [] })
    const file = path.join(directory, '_group-projects', 'group-test.json')
    await mkdir(path.dirname(file), { recursive: true })
    const original = `${JSON.stringify(legacy(), null, 2)}\n`
    await writeFile(file, original, 'utf8')
    await action({ groups: create(), create, groupId: group.id, file, original, map })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('기존 단일 기획서는 원문·버전·분류 지문을 유지한 채 읽기 전용 목록으로 제공한다', async () => {
  await fixture(async ({ groups, groupId, file, original }) => {
    const { project, sourcesSupported } = await groups.context(groupId)
    assert.equal(sourcesSupported, true)
    assert.equal(project.version, 7)
    assert.deepEqual(project.sources, groupPlanningSources(legacy()))
    assert.equal(await readFile(file, 'utf8'), original, '조회만으로 기존 파일을 마이그레이션하지 않는다')
    const oldFingerprint = createHash('sha256').update(JSON.stringify(['source', 'sourceVersion', 'objective', 'instructions'].map((key) => legacy()[key]))).digest('hex')
    assert.equal(groupCriteriaFingerprint(project), oldFingerprint)
    assert.equal(groupProjectCriteriaEqual(project, legacy()), true)
  })
})

test('여러 기획서 저장·재조회·재생성 시 목록과 공통 기준을 보존하고 구버전 수정은 첫 원본에만 적용한다', async () => {
  await fixture(async ({ groups, create, groupId, map }) => {
    const before = structuredClone(map)
    const sources = [...groupPlanningSources(legacy()), additional()]
    let context = await groups.update(groupId, { baseVersion: 7, sources }, user)
    assert.equal(context.project.version, 8)
    assert.deepEqual(context.project.sources, sources)
    assert.equal(context.project.objective, legacy().objective)
    assert.equal(context.project.instructions, legacy().instructions)
    assert.equal(context.project.source, legacy().source)
    assert.deepEqual((await create().context(groupId)).project, context.project)
    assert.match(context.guide.sources, /모든 기획서/)
    context = await groups.update(groupId, { baseVersion: 8, sourceVersion: 'v0.5' }, user)
    assert.deepEqual(context.project.sources, [{ ...sources[0], sourceVersion: 'v0.5' }, sources[1]])
    context = await groups.update(groupId, { baseVersion: 9, objective: '사용자가 수정한 목표' }, user)
    assert.deepEqual(context.project.sources[1], additional())
    context = await groups.update(groupId, { baseVersion: 10, sources: [additional()] }, user)
    assert.equal(context.project.source, additional().source)
    assert.equal(context.project.sourceVersion, additional().sourceVersion)
    context = await groups.update(groupId, { baseVersion: 11, sources: [] }, user)
    assert.deepEqual(context.project.sources, [])
    assert.equal(context.project.source, ''); assert.equal(context.project.sourceVersion, '')
    assert.deepEqual(map, before)
  })
})

test('목록 저장은 버전 충돌·잘못된 형식·중복 ID·빈 항목·개수와 길이 초과·혼합 요청을 거부한다', async () => {
  await fixture(async ({ groups, groupId, file, original }) => {
    const item = additional()
    for (const sources of [null, {}, [null], [item, item], [{ ...item, id: '../bad' }], [{ ...item, id: 'a'.repeat(81) }], [{ ...item, sourceVersion: 1 }], [{ ...item, title: 'a'.repeat(121) }], [{ ...item, source: 'a'.repeat(4097) }], [{ ...item, sourceVersion: 'a'.repeat(241) }], [{ id: 'empty', title: '', source: ' ', sourceVersion: '' }], [{ ...item, url: '오타 필드' }], Array.from({ length: GROUP_PLANNING_SOURCE_LIMIT + 1 }, (_, index) => ({ ...item, id: `source-${index}` }))]) {
      await assert.rejects(groups.update(groupId, { baseVersion: 7, sources }, user), { status: 400 })
    }
    await assert.rejects(groups.update(groupId, { baseVersion: 6, sources: [item] }, user), { status: 409 })
    await assert.rejects(groups.update(groupId, { baseVersion: 7, sources: [item], source: '혼합' }, user), { status: 400 })
    await assert.rejects(groups.update(groupId, { baseVersion: 7, sources: [item], sourceVersion: '혼합' }, user), { status: 400 })
    assert.equal(await readFile(file, 'utf8'), original)
  })
})

test('기획서 추가·제거·두 번째 주소·버전 변경은 기준 버전을 올리고 기존 대기 분류를 무효화한다', async () => {
  await fixture(async ({ groups, groupId, map }) => {
    const current = await groups.context(groupId)
    const root = map.nodes[0]
    const detail = current.documents[0].waitingDetails[0]
    const input = { mapId: map.id, cardId: root.id, waitingId: 'wait', expectedFingerprint: detail.fingerprint, category: 'external', impact: 'deferred' }
    let settings = { ...current.project, waitingReviews: applyGroupWaitingReview(current.project, map, root, input, user) }
    assert.equal(groupWaitingDetails(map, root, settings)[0].review.valid, true)
    const expanded = withGroupPlanningSources(settings, [...settings.sources, additional()])
    assert.equal(groupWaitingDetails(map, root, expanded)[0].review.invalidReason, '기획 기준 변경')
    const expandedDetail = groupWaitingDetails(map, root, expanded)[0]
    settings = { ...expanded, waitingReviews: applyGroupWaitingReview(expanded, map, root, { ...input, expectedFingerprint: expandedDetail.fingerprint }, user) }
    for (const sources of [settings.sources.slice(0, 1), settings.sources.map((source, index) => index ? { ...source, sourceVersion: 'v0.2' } : source), settings.sources.map((source, index) => index ? { ...source, source: '새 원본 주소' } : source)]) {
      const changed = withGroupPlanningSources(settings, sources)
      assert.equal(groupWaitingDetails(map, root, changed)[0].review.invalidReason, '기획 기준 변경')
      await assert.rejects(async () => applyGroupWaitingReview(changed, map, root, { ...input, expectedFingerprint: expandedDetail.fingerprint }, user), { status: 409 })
    }
    const saved = await groups.update(groupId, { baseVersion: current.project.version, sources: expanded.sources }, user)
    assert.equal(saved.project.version, current.project.version + 1, '위임 승인 검사에 사용하는 버전을 갱신한다')
  })
})

test('자동 새로고침은 기획서 편집을 보존하며 배열 인스턴스 변경은 수정으로 취급하지 않는다', () => {
  const base = withGroupPlanningSources(legacy(), [...groupPlanningSources(legacy()), additional()])
  const incoming = structuredClone(base)
  assert.equal(groupProjectCriteriaEqual(base, incoming), true)
  assert.equal(groupProjectDraftAfterRefresh(base, base, incoming), incoming)
  const draft = withGroupPlanningSources(base, base.sources.map((item, index) => index ? { ...item, sourceVersion: '편집 중' } : item))
  assert.equal(groupProjectCriteriaEqual(draft, incoming), false)
  assert.deepEqual(groupProjectDraftAfterRefresh(draft, base, incoming), draft)
  const remote = withGroupPlanningSources({ ...base, version: 8 }, [...base.sources, { ...additional(), id: 'third', title: '다른 사용자 추가' }])
  const stale = groupProjectDraftAfterRefresh(draft, base, remote)
  assert.equal(stale, draft)
  assert.equal(groupProjectDraftAfterRefresh(stale, remote, structuredClone(remote)), draft)
  assert.equal(groupProjectDraftAfterRefresh(base, base, remote), remote)
})

test('기준 요약·재구성 기본값과 총괄·문서 AI 전문은 여러 기획서를 빠뜨리지 않는다', () => {
  const project = withGroupPlanningSources(legacy(), [...groupPlanningSources(legacy()), additional()])
  assert.equal(groupPlanningSourceSummary(project), '기획서 2개')
  assert.equal(groupPlanningSourceSummary(legacy()), 'v0.4')
  assert.equal(groupPlanningSourceSummary({}), '기획서 미등록')
  assert.equal(groupPlanningBaseline(legacy()), 'v0.4')
  assert.match(groupPlanningBaseline(project), /기획서 1 · v0.4.*옷장 추가 기획 · v0.1/)
  for (const prompt of [buildGroupCoordinatorRequest({ groupId: 'group-test' }), buildGroupDocumentRequest({ groupId: 'group-test', groupName: '시험' })]) {
    assert.match(prompt, /project.sources의 모든 기획서 주소·개별 버전/)
    assert.match(prompt, /추가 기획서를 기존 원본의 대체본으로 간주하지/)
    assert.match(prompt, /기획서 추가·제거·주소·개별 버전/)
  }
})
