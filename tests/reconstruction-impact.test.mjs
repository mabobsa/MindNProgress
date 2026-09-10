import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createDocumentReconstruction } from '../server/lib/documentReconstruction.mjs'
import { proposalHash } from '../server/lib/reconstructionImpact.mjs'
import { reconstructionLayoutFixture } from './helpers/reconstructionLayoutFixture.mjs'

const card = (id, data = {}) => ({ id, type: 'mind', position: { x: 0, y: 0 }, data: { label: id, description: '유지할 현재 기준', kind: 'task', isWork: true, status: 'planned', progress: 0, ...data } })
const map = (id) => ({ id, title: id, version: 1, nodes: [card('root', { kind: 'root', isWork: false }), card('work')], edges: [{ id: 'edge', source: 'root', target: 'work' }] })
async function fixture(t, setup = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-impact-test-'))
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^mnp-impact-test-/); await rm(directory, { recursive: true, force: true }) })
  const maps = new Map(['map-a', 'map-b', 'map-c', 'map-outside'].map((id) => [id, map(id)]))
  const project = { version: 1, coordinatorMapId: 'map-coordinator', sourceVersion: 'v0.4', objective: '현재 요구사항 유지' }
  const layout = { groups: [{ id: 'group-a', name: '그룹 A', mapIds: ['map-a', 'map-b', 'map-c'] }, { id: 'group-outside', name: '외부', mapIds: ['map-outside'] }], items: [] }
  const baselines = new Map(); const comments = new Map(); let manager; let onSave = () => {}; let unreadable = null
  setup(maps)
  const readMap = async (id) => id !== unreadable && maps.has(id) ? { ...structuredClone(maps.get(id)), ...manager?.metadata(id) } : null
  const listMaps = async (options = {}) => [...maps.values()].map((m) => ({ ...m, ...manager?.metadata(m.id) })).filter((m) => (options.includeArchived || !m.archivedAt) && (options.includePending || !m.reconstructionPending) && (options.includeTrashed || !m.trashedAt))
  const currentLayout = async () => manager.projectLayout(layout, (await listMaps()).map((m) => m.id))
  const options = { dataDirectory: directory, readMap, listMaps, readLayout: currentLayout, isValidMap: () => true, readComments: async (id) => comments.get(id) ?? [],
    checkIdle: async () => {}, writeJson: (file, value) => writeFile(file, JSON.stringify(value)),
    saveMap: async (id, value) => { const saved = { ...structuredClone(value), version: 1 }; maps.set(id, saved); onSave(); return saved },
    groupContext: async (ids) => (await currentLayout()).groups.filter((g) => g.mapIds.some((id) => ids.includes(id))).map((g) => ({ groupId: g.id, name: g.name, mapIds: g.mapIds, project: structuredClone(project) })),
    proposalBaseline: (plan) => baselines.get(proposalHash(plan)),
  }
  manager = await createDocumentReconstruction(options)
  const planFor = async (id, suffix = '') => {
    const source = maps.get(id); const context = await manager.context([id])
    return { id: id + '-compact' + suffix, mode: 'compact', baseline: 'v0.4', reason: '정리 시험', sources: context.sources, groupBaselines: context.groupBaselines,
      targets: [{ key: 'next', title: source.title + ' 후속', nodes: structuredClone(source.nodes), edges: structuredClone(source.edges) }],
      decisions: source.nodes.map((n) => ({ mapId: id, cardId: n.id, disposition: 'carry', reason: '현재 조건 유지', targets: [{ key: 'next', cardId: n.id }] })),
      approval: { statement: '시험 데이터에 전환 적용', source: '자동 시험' } }
  }
  const verify = async (plan) => {
    let preview = await manager.preview(plan)
    for (const final of [false, true]) preview = await manager.inspectRenderedLayout(plan, preview.previewHash, reconstructionLayoutFixture(preview), final, { id: 'tester' })
    return preview
  }
  const submit = async (plan) => { const preview = await manager.preview(plan, { submitting: true }); baselines.set(proposalHash(plan), { references: preview.impactValidation.references, submittedAt: new Date().toISOString() }); return preview }
  return { maps, layout, project, manager, baselines, comments, planFor, verify, submit,
    onSave: (fn) => { onSave = fn }, unreadable: (id) => { unreadable = id } }
}
const ref = (owner, target) => { owner.nodes.push(card('ref-' + target, { isWork: false, reference: { mapId: target, nodeId: 'work' } })); owner.edges.push({ id: 'edge-' + target, source: 'root', target: 'ref-' + target }) }

test('A가 C를 참조해도 무관한 B 전환은 허용하고 원래 제안·검증 좌표를 보존한다', async (t) => {
  const f = await fixture(t, (maps) => { ref(maps.get('map-a'), 'map-c'); ref(maps.get('map-b'), 'map-c') })
  const a = await f.planFor('map-a'); const unchanged = structuredClone(a)
  await f.submit(a); const before = await f.verify(a)
  const b = await f.planFor('map-b'); await f.manager.apply(b, {}, (await f.verify(b)).previewHash)
  const after = await f.manager.preview(a)
  assert.equal(after.previewHash, before.previewHash)
  assert.equal(after.layoutPhase, 'verified')
  assert.match(after.warnings.join('\n'), /양방향 Ref 연결이 없어/)
  assert.equal(after.impactValidation.allowedTransitions.length, 1)
  assert.deepEqual(a, unchanged)
  const applied = await f.manager.apply(a, {}, before.previewHash)
  assert.equal(applied.state, 'applied')
  assert.deepEqual(applied.groupBaselines, unchanged.groupBaselines)
  assert.notDeepEqual(applied.impactValidation.currentGroups, unchanged.groupBaselines)
})

for (const direction of ['outgoing', 'incoming']) test(`그룹 안 ${direction} Ref로 연결된 B가 전환되면 A를 차단한다`, async (t) => {
  const f = await fixture(t, (maps) => ref(maps.get(direction === 'outgoing' ? 'map-a' : 'map-b'), direction === 'outgoing' ? 'map-b' : 'map-a'))
  const a = await f.planFor('map-a'); await f.submit(a); const before = await f.verify(a)
  const b = await f.planFor('map-b'); await f.manager.apply(b, {}, (await f.verify(b)).previewHash)
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE' && /ref-/.test(e.message))
  await assert.rejects(f.manager.apply(a, {}, before.previewHash), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE')
  assert.equal(f.manager.metadata('map-a').archivedAt, undefined)
})

for (const direction of ['outgoing', 'incoming']) test(`다른 그룹의 ${direction} Ref 문서 변경도 제출 기준으로 차단한다`, async (t) => {
  const f = await fixture(t, (maps) => ref(maps.get(direction === 'outgoing' ? 'map-a' : 'map-outside'), direction === 'outgoing' ? 'map-outside' : 'map-a'))
  const a = await f.planFor('map-a'); await f.submit(a)
  const other = await f.planFor('map-outside'); await f.manager.apply(other, {}, (await f.verify(other)).previewHash)
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE')
})

test('새 정리안에만 추가한 Ref와 원본에서 제거한 Ref도 검사한다', async (t) => {
  const f = await fixture(t, (maps) => ref(maps.get('map-a'), 'map-outside'))
  const a = await f.planFor('map-a')
  a.targets[0].nodes = a.targets[0].nodes.filter((n) => !n.data.reference); a.targets[0].edges = a.targets[0].edges.filter((e) => e.target === 'work')
  a.decisions.find((d) => d.cardId.startsWith('ref-')).targets = [{ key: 'next', cardId: 'root' }]
  ref(a.targets[0], 'map-b')
  await f.submit(a)
  f.maps.get('map-outside').version++
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE')
  f.maps.get('map-outside').version--
  const b = await f.planFor('map-b'); await f.manager.apply(b, {}, (await f.verify(b)).previewHash)
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE')
})

test('기획 기준·대상 소속·수동 문서 추가는 계속 차단하고 JSON 키 순서는 허용한다', async (t) => {
  const f = await fixture(t); const a = await f.planFor('map-a')
  f.project.version++
  await assert.rejects(f.manager.preview(a), /그룹 기획 기준/); f.project.version--
  f.maps.set('map-new', map('map-new')); f.layout.groups[0].mapIds.push('map-new')
  await assert.rejects(f.manager.preview(a), /추가·이동·삭제/); f.layout.groups[0].mapIds.pop(); f.maps.delete('map-new')
  f.layout.groups[0].mapIds = ['map-b', 'map-c']; f.layout.groups[1].mapIds.push('map-a')
  await assert.rejects(f.manager.preview(a), /그룹/)
  f.layout.groups[0].mapIds = ['map-c', 'map-b', 'map-a']; f.layout.groups[1].mapIds.pop()
  a.groupBaselines = a.groupBaselines.map((g) => Object.fromEntries(Object.entries(g).reverse()))
  await assert.doesNotReject(f.manager.preview(a))
})

test('최종 저장 도중 추가된 그룹 밖 역방향 Ref를 차단하고 원본을 유지한다', async (t) => {
  const f = await fixture(t); const a = await f.planFor('map-a'); const preview = await f.verify(a)
  f.onSave(() => ref(f.maps.get('map-outside'), 'map-a'))
  await assert.rejects(f.manager.apply(a, {}, preview.previewHash), /저장 중 양방향 Ref/)
  assert.equal(f.manager.metadata('map-a').archivedAt, undefined)
  assert.equal(f.manager.get(a.id).state, 'failed')
  assert.equal(f.manager.isUnavailable(f.manager.get(a.id).targetMapIds[0]), true)
})

test('문서 조회 실패는 Ref 없음으로 판정하지 않는다', async (t) => {
  const f = await fixture(t); const a = await f.planFor('map-a'); f.unreadable('map-outside')
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_UNVERIFIED')
})

test('구 정리안은 무관한 연속 전환을 허용하지만 Ref 문서의 제출 이후 변경은 차단한다', async (t) => {
  const f = await fixture(t, (maps) => ref(maps.get('map-a'), 'map-outside'))
  const a = await f.planFor('map-a'); const baseline = { submittedAt: '2026-09-10T00:00:00.000Z' }
  f.baselines.set(proposalHash(a), baseline)
  const b = await f.planFor('map-b'); const first = await f.manager.apply(b, {}, (await f.verify(b)).previewHash)
  const b2 = await f.planFor(first.targetMapIds[0]); await f.manager.apply(b2, {}, (await f.verify(b2)).previewHash)
  assert.equal((await f.manager.preview(a)).impactValidation.allowedTransitions.length, 2)
  assert.equal(baseline.references, undefined, '구 제안에 검증 기준을 자동 저장하지 않는다')
  f.maps.get('map-outside').updatedAt = '2026-09-11T00:00:00.000Z'
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE')
})

test('참조 댓글 변경과 제출 뒤 새로 연결된 외부 Ref도 차단한다', async (t) => {
  const f = await fixture(t, (maps) => ref(maps.get('map-a'), 'map-c'))
  const a = await f.planFor('map-a'); await f.submit(a)
  f.comments.set('map-c', [{ id: 'comment', detail: '참조 기준 변경' }])
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE')
  f.comments.delete('map-c')
  ref(f.maps.get('map-outside'), 'map-a')
  await assert.rejects(f.manager.preview(a), (e) => e.code === 'RECONSTRUCTION_REFERENCE_STALE')
})
