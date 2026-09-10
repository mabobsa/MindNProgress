import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyGroupWaitingReview, groupWaitingDetails } from '../server/lib/groupWaitingReviews.mjs'
import { createGroupProjects } from '../server/lib/groupProjects.mjs'
import { suggestGroupWaitingCategory, groupWaitingPresentation } from '../src/utils/groupWaiting.mjs'
import { groupOverviewRows, filterGroupOverviewRows, groupProjectDraftAfterRefresh } from '../src/utils/groupOverview.mjs'

const item = (id, label) => ({ id, label, note: '원문 첫 절\n\n마지막 절', resumeCondition: '제공된 결과를 검증한 뒤 재개', since: '2026-09-10T00:00:00Z' })
const card = (id, items = [], extra = {}) => ({ id, data: { label: id, status: 'in-progress', kind: 'task', isWork: true, waitingItems: items, ...extra } })
const root = () => card('root', [item('root-wait', '서버 API 계약')], { kind: 'root', isWork: false })
const map = () => ({ id: 'doc', title: '시험 문서', version: 7, nodes: [root(), card('a', [item('assets', '최종 아트 전달'), item('policy', '선물 가격 정책 확정')]), card('b', [item('verify', '실경로 검증')]), card('plain', [item('ignored', '비업무 카드')], { isWork: false })], edges: [{ source: 'root', target: 'a' }, { source: 'root', target: 'b' }, { source: 'root', target: 'plain' }] })
const project = () => ({ version: 0, coordinatorMapId: null, source: '', sourceVersion: 'v0.4', objective: '서버·아트는 추후 제공, 더미 Play 구현', instructions: '사용자 승인 후 실행' })
const user = { id: 'tester', name: '시험 사용자' }

test('분류 갱신은 편집 중 기준을 보존하고 실제 기준 충돌은 반복 갱신으로 해제하지 않는다', () => {
  const base = project(); const edited = { ...base, objective: '사용자 편집 중' }
  const reviewOnly = { ...base, version: 1 }
  assert.deepEqual(groupProjectDraftAfterRefresh(edited, base, reviewOnly), { ...edited, version: 1 })
  const changed = { ...base, sourceVersion: 'v0.5', version: 2 }
  assert.equal(groupProjectDraftAfterRefresh(base, base, changed), changed)
  assert.equal(groupProjectDraftAfterRefresh(base, base, changed), changed, '동일 updater 재호출에서도 임의 미저장 상태를 만들지 않는다')
  const stale = groupProjectDraftAfterRefresh(edited, base, changed)
  assert.equal(stale, edited)
  assert.equal(groupProjectDraftAfterRefresh(stale, changed, changed), edited)
  assert.deepEqual(base, project())
})
function reviewInput(value, settings, category = 'external', impact = 'deferred') {
  const detail = groupWaitingDetails(value, value.nodes[0], settings).find((entry) => entry.item.id === 'assets')
  return { mapId: value.id, cardId: detail.cardId, waitingId: detail.item.id, expectedFingerprint: detail.fingerprint, category, impact }
}

test('자유문장의 사유는 표시 후보로만 분류하며 범위 차단·예정 여부를 추정하지 않는다', () => {
  assert.equal(suggestGroupWaitingCategory({ label: '최종 아트·사운드 전달' }), 'external')
  assert.equal(suggestGroupWaitingCategory({ label: 'S14 표시 방식 확정' }), 'decision')
  assert.equal(suggestGroupWaitingCategory({ label: '실제 서버 왕복 검증' }), 'verification')
  assert.equal(suggestGroupWaitingCategory({ label: '추가 정보 필요', note: '서버·아트는 필요하지 않다.' }), 'other')
  const detail = groupWaitingDetails(map(), root(), project())[0]
  assert.deepEqual(groupWaitingPresentation(detail), { category: 'external', impact: 'unreviewed', reviewed: false, stale: false })
})

test('루트와 하위 업무의 원문·재개 조건을 보존하고 비업무 대기는 집계하지 않는다', () => {
  const value = map(); const before = structuredClone(value)
  const details = groupWaitingDetails(value, value.nodes[0], project())
  assert.equal(details.length, 4)
  assert.equal(details[0].isRoot, true)
  assert.equal(new Set(details.filter((entry) => !entry.isRoot).map((entry) => entry.cardId)).size, 2)
  assert.deepEqual(details[1].item, value.nodes[1].data.waitingItems[0])
  assert.deepEqual(value, before)
})

test('분류 저장은 문서·대기·진행률을 변경하지 않으며 분류 원문과 기준의 일치를 요구한다', () => {
  const value = map(); const before = structuredClone(value); const settings = project()
  const input = reviewInput(value, settings)
  const reviews = applyGroupWaitingReview(settings, value, value.nodes[0], input, user)
  assert.equal(settings.waitingReviews, undefined)
  assert.deepEqual(value, before)
  const saved = { ...settings, waitingReviews: reviews }
  const detail = groupWaitingDetails(value, value.nodes[0], saved)[1]
  assert.deepEqual(groupWaitingPresentation(detail), { category: 'external', impact: 'deferred', reviewed: true, stale: false })
  assert.equal(detail.review.reviewedBy.name, user.name)
  const latest = { ...saved, sourceVersion: 'v0.5' }
  const changed = groupWaitingDetails(value, value.nodes[0], latest)[1]
  assert.equal(changed.review.valid, false); assert.equal(changed.review.invalidReason, '기획 기준 변경')
  assert.equal(groupWaitingPresentation(changed).impact, 'unreviewed')
  assert.throws(() => applyGroupWaitingReview(latest, value, value.nodes[0], input, user), { status: 409 })
  value.nodes[1].data.waitingItems[0].resumeCondition += '\n수정된 조건'
  assert.equal(groupWaitingDetails(value, value.nodes[0], saved)[1].review.invalidReason, '카드 또는 대기 내용 변경')
  assert.throws(() => applyGroupWaitingReview(saved, value, value.nodes[0], input, user), { status: 409 })
})

test('다른 문서·보관 문서·잘못된 분류와 외부 대기로의 무효 조합을 거부한다', () => {
  const value = map(); const settings = project(); const input = reviewInput(value, settings)
  for (const invalid of [{ category: 'invalid' }, { impact: 'invalid' }, { category: 'decision', impact: 'deferred' }]) assert.throws(() => applyGroupWaitingReview(settings, value, value.nodes[0], { ...input, ...invalid }, user), { status: 400 })
  for (const invalid of [{ mapId: 'outside' }, { cardId: 'missing' }, { waitingId: 'missing' }, { expectedFingerprint: 'stale' }]) assert.throws(() => applyGroupWaitingReview(settings, value, value.nodes[0], { ...input, ...invalid }, user), { status: 409 })
  assert.throws(() => applyGroupWaitingReview(settings, { ...value, archivedAt: 'today' }, value.nodes[0], input, user), { status: 409 })
})

test('문서 필터는 사유와 현재 범위 영향을 구분하고 같은 문서를 중복 집계하지 않는다', () => {
  const value = map(); let settings = project()
  settings.waitingReviews = applyGroupWaitingReview(settings, value, value.nodes[0], reviewInput(value, settings), user)
  const details = groupWaitingDetails(value, value.nodes[0], settings)
  const rows = groupOverviewRows({ project: settings, documents: [{ id: 'doc', title: '문서', root: value.nodes[0], work: { waiting: 2 }, waitingDetails: details }], delegations: [] })
  assert.equal(filterGroupOverviewRows(rows, '', 'external').length, 1)
  assert.equal(filterGroupOverviewRows(rows, '', 'deferred').length, 1)
  assert.equal(filterGroupOverviewRows(rows, '', 'blocking').length, 0)
  assert.equal(filterGroupOverviewRows(rows, '', 'unreviewed').length, 1)
  assert.equal(filterGroupOverviewRows(rows, '', 'decision').length, 1)
  assert.equal(filterGroupOverviewRows(rows, '', 'verification').length, 1)
  assert.equal(filterGroupOverviewRows(rows, '', 'ai').length, 0)
  assert.equal(rows[0].reasons.length, 4)
})

test('구버전 서버에서 사유가 빠져도 대기를 숨기거나 AI 실패로 바꾸지 않는다', () => {
  const [row] = groupOverviewRows({ project: project(), documents: [{ id: 'old', title: '구버전', work: { waiting: 2 } }], delegations: [] })
  assert.equal(row.waitingUnavailable, true)
  assert.deepEqual(row.filters, ['unreviewed'])
})

test('분류는 그룹에 영속 저장하며 기준 버전 충돌·대상 이동·삭제 및 원문 혼합 저장을 막는다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-waiting-review-'))
  try {
    const value = map(); const before = structuredClone(value)
    const group = { id: 'group-wait-test', name: '시험', mapIds: [value.id] }
    const layout = { version: 1, items: [{ type: 'group', id: group.id }], groups: [group] }
    let saves = 0
    const create = () => createGroupProjects({ dataDirectory: directory, replaceFile: rename, listMaps: async () => [value], readMap: async (id) => id === value.id ? value : null, saveMap: async () => { saves++; throw Error('카드 변경 금지') }, readLayout: async () => layout, writeLayout: async () => { throw Error('그룹 이동 금지') }, delegations: new Map(), publicDelegation: (entry) => entry, runtimeSnapshot: () => [] })
    const groups = create()
    let current = await groups.update(group.id, { baseVersion: 0, ...project() }, user)
    assert.equal(current.waitingReviewSupported, true)
    assert.equal(current.documents[0].work.waiting, 2)
    const input = reviewInput(value, current.project)
    const criteriaVersion = current.project.version
    current = await groups.update(group.id, { baseVersion: current.project.version, baseWaitingReviewVersion: 0, waitingReview: input }, user)
    assert.equal(current.project.version, criteriaVersion, '분류는 기존 위임의 승인 기준 버전을 변경하지 않는다')
    assert.equal(current.project.waitingReviewVersion, 1)
    assert.equal(current.documents[0].waitingDetails[1].review.valid, true)
    assert.deepEqual(value, before); assert.equal(saves, 0)
    const restored = await create().context(group.id)
    assert.equal(restored.documents[0].waitingDetails[1].review.impact, 'deferred')
    await assert.rejects(groups.update(group.id, { baseVersion: 0, baseWaitingReviewVersion: 1, waitingReview: input }, user), { status: 409 })
    await assert.rejects(groups.update(group.id, { baseVersion: current.project.version, baseWaitingReviewVersion: 0, waitingReview: input }, user), { status: 409 })
    await assert.rejects(groups.update(group.id, { baseVersion: current.project.version, baseWaitingReviewVersion: 1, waitingReview: input, objective: '혼합 저장' }, user), { status: 400 })
    await assert.rejects(groups.update(group.id, { baseVersion: current.project.version, baseWaitingReviewVersion: 1, waitingReview: { ...input, mapId: 'outside' } }, user), { status: 409 })
    current = await groups.update(group.id, { baseVersion: current.project.version, instructions: '새 공통 기준' }, user)
    assert.equal(current.documents[0].waitingDetails[1].review.valid, false)
    assert.deepEqual(value, before)
    value.nodes[1].data.waitingItems = []
    await assert.rejects(groups.update(group.id, { baseVersion: current.project.version, baseWaitingReviewVersion: 1, waitingReview: input }, user), { status: 409 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
