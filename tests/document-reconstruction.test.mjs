import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDocumentMutationGate, createDocumentReconstruction, reconstructionSourceHash, validateReconstruction } from '../server/lib/documentReconstruction.mjs'
import { reconstructionLayoutFixture, verifyLayoutFixture } from './helpers/reconstructionLayoutFixture.mjs'

export const card = (id, data = {}) => ({ id, type: 'mind', position: { x: 0, y: 0 }, data: { label: id, description: '요구사항 원문', sharedKnowledge: '', kind: 'task', isWork: true, status: 'planned', progress: 0, ...data } })
export const original = () => ({ id: 'map-source', title: '기존 문서', version: 3, nodes: [card('root', { kind: 'root', isWork: false }), card('work', { checklist: [{ id: 'a', text: '결과를 검증한다', done: false }], waitingItems: [{ id: 'wait', label: '기획 결정', note: '기존 범위 확인', resumeCondition: '사용자가 기준 확정', since: '2026-09-10T00:00:00.000Z' }] }), card('done', { status: 'done', progress: 100, sharedKnowledge: '검증된 정책' })], edges: [{ id: 'a', source: 'root', target: 'work' }, { id: 'b', source: 'root', target: 'done' }] })
export const planFor = (source) => ({ id: 'test-compact', mode: 'compact', baseline: 'v0.4', reason: '이력을 보관하고 현재 업무를 정리', sources: [{ mapId: source.id, version: source.version, sha256: reconstructionSourceHash(source) }], targets: [{ key: 'next', title: '현재 기준', nodes: [card('new-root', { kind: 'root', isWork: false, sharedKnowledge: '검증된 정책' }), { ...structuredClone(source.nodes[1]), id: 'new-work' }], edges: [{ id: 'next-edge', source: 'new-root', target: 'new-work' }] }], decisions: [{ mapId: source.id, cardId: 'root', disposition: 'carry', reason: '기준 유지', targets: [{ key: 'next', cardId: 'new-root' }] }, { mapId: source.id, cardId: 'work', disposition: 'carry', reason: '미완료 조건 보존', targets: [{ key: 'next', cardId: 'new-work' }] }, { mapId: source.id, cardId: 'done', disposition: 'knowledge', reason: '완료된 검증 결과를 현재 정책으로', targets: [{ key: 'next', cardId: 'new-root' }] }], approval: { statement: '이 시험 전환안을 적용해 주세요.', source: '자동 시험의 승인 입력' } })
const isValidMap = (map) => Array.isArray(map.nodes) && Array.isArray(map.edges)
const valid = (plan, source = original()) => validateReconstruction(plan, [source], { isValidMap })

test('전수 대응표·미완료·체크리스트·대기·새 계층을 검증하고 입력은 변경하지 않는다', () => {
  const source = original(); const plan = planFor(source); const snapshot = structuredClone(plan)
  const result = valid(plan, source)
  assert.deepEqual(plan, snapshot)
  assert.equal(result.before.work, 2); assert.equal(result.after.work, 1)
  assert.equal(result.targets[0].map.nodes[0].data.reconstructionSources.length, 2)
  const cases = [
    [(p) => p.decisions.pop(), /미분류/],
    [(p) => p.decisions.push(p.decisions[0]), /중복/],
    [(p) => { p.targets[0].nodes[1].data.isWork = false }, /미완료/],
    [(p) => { p.targets[0].nodes[1].data.checklist = [] }, /체크리스트/],
    [(p) => { p.targets[0].nodes[1].data.waitingItems = [] }, /대기/],
    [(p) => { p.targets[0].nodes[1].data.waitingItems[0].resumeCondition = '임의 변경' }, /대기/],
    [(p) => { p.decisions[1].disposition = 'drop'; p.decisions[1].evidence = '삭제' }, /기획 갱신/],
    [(p) => { p.targets[0].nodes[1].data.aiConversationId = 'old' }, /대화/],
    [(p) => { p.targets[0].edges[0].target = 'missing' }, /존재하지/],
    [(p) => { p.sources[0].version++ }, /변경/],
    [(p) => { p.targets[0].nodes[1].data.blockedBy = ['old-card'] }, /선행/],
    [(p) => { p.targets[0].nodes[1].data.checklist[0].done = true }, /진행률/],
  ]
  for (const [change, expected] of cases) { const changed = structuredClone(plan); change(changed); assert.throws(() => valid(changed, source), expected) }
  const update = structuredClone(plan); update.mode = 'spec-update'
  assert.throws(() => valid(update), /새 원본/)
  update.newSource = '기획 v0.5'; update.changeSummary = '기존 조건이 명시적으로 제외됨'
  update.decisions[1] = { ...update.decisions[1], disposition: 'drop', evidence: 'v0.5 3페이지', targets: [] }
  assert.doesNotThrow(() => valid(update))
})

test('적용·원본 보존·멱등·보관 복원·충돌·재시작 복구를 임시 저장소로 검증한다', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-reconstruction-unit-'))
  assert.equal(path.dirname(directory), path.resolve(tmpdir()))
  assert.match(path.basename(directory), /^mnp-reconstruction-unit-/)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = original(); const maps = new Map([[source.id, structuredClone(source)]])
  const comments = new Map([[source.id, [{ id: 'c1', text: '원문 댓글' }]]])
  const layout = { version: 1, groups: [{ id: 'group-test', name: '시험', mapIds: [source.id] }], items: [{ type: 'group', id: 'group-test' }] }
  let manager; let failSave = false; let busy = false; let saves = 0
  const options = { dataDirectory: directory, isValidMap, readMap: async (id) => maps.has(id) ? { ...structuredClone(maps.get(id)), ...manager?.metadata(id) } : null,
    readComments: async (id) => comments.get(id) ?? [], listMaps: async () => [...maps.values()], readLayout: async () => layout,
    writeJson: (file, value) => writeFile(file, JSON.stringify(value)), checkIdle: async () => { if (busy) throw new Error('AI 실행 중') },
    saveMap: async (id, map) => { saves++; if (failSave && saves % 2 === 0) throw new Error('저장 실패'); const saved = { ...map, version: 1 }; maps.set(id, saved); return saved },
  }
  manager = await createDocumentReconstruction(options)
  const plan = planFor(source); plan.sources = (await manager.context([source.id])).sources
  const initialPreview = await manager.preview(plan)
  await assert.rejects(manager.apply(plan, { id: 'tester' }, initialPreview.previewHash), /실제 마인드맵/)
  const preview = await verifyLayoutFixture(manager, plan)
  assert.equal(maps.size, 1, '미리보기는 저장하지 않는다')
  await assert.rejects(manager.apply(plan, { id: 'tester' }), /미리보기/)
  busy = true; await assert.rejects(manager.apply(plan, { id: 'tester' }, preview.previewHash), /AI 실행/); busy = false
  const applied = await manager.apply(plan, { id: 'tester' }, preview.previewHash)
  assert.equal(applied.state, 'applied'); assert.deepEqual(maps.get(source.id), source)
  assert.equal(manager.metadata(source.id).archivedAt.length > 0, true)
  assert.throws(() => manager.assertWritable(source.id), /보관/)
  assert.equal((await manager.apply(plan, { id: 'tester' }, preview.previewHash)).id, applied.id)
  const targetId = applied.targetMapIds[0]
  assert.deepEqual(manager.projectLayout(layout, [targetId]).groups[0].mapIds, [targetId])
  comments.set(targetId, [{ id: 'new', text: '전환 후 댓글' }])
  await assert.rejects(manager.rollback(plan.id, { id: 'tester' }), /댓글/)
  comments.delete(targetId)
  await manager.rollback(plan.id, { id: 'tester' })
  assert.equal(Boolean(manager.metadata(source.id).archivedAt), false)
  assert.equal(Boolean(manager.metadata(targetId).archivedAt), true)
  assert.deepEqual(maps.get(source.id), source)
  manager = await createDocumentReconstruction(options)
  assert.equal(manager.get(plan.id).state, 'rolled-back')
  await assert.rejects(manager.archive(source.id, { baseVersion: 3, baseLifecycleVersion: 0, archived: true }, {}), /보관 상태/)
  await manager.archive(source.id, { baseVersion: 3, baseLifecycleVersion: 2, archived: true }, {})
  await manager.archive(source.id, { baseVersion: 3, baseLifecycleVersion: 3, archived: false }, {})
  const failure = planFor(source); failure.id = 'save-fails'; failure.sources = (await manager.context([source.id])).sources
  failure.targets.push({ key: 'partial-second', title: '저장 실패 대상', nodes: [card('root', { kind: 'root', isWork: false })], edges: [] })
  failSave = true; saves = 0
  await assert.rejects(manager.apply(failure, {}, (await verifyLayoutFixture(manager, failure)).previewHash), /저장 실패/)
  assert.equal(Boolean(manager.metadata(source.id).archivedAt), false)
  assert.equal(manager.get(failure.id).state, 'failed')
  assert.equal(maps.has(manager.get(failure.id).targetMapIds[0]), true, '일부 후속 문서는 이미 저장되었음')
  assert.equal(manager.isUnavailable(manager.get(failure.id).targetMapIds[0]), true, '부분 저장 문서는 활성 노출하지 않음')
  const state = JSON.parse(await readFile(path.join(directory, '_document-lifecycle.json'), 'utf8'))
  state.operations.interrupted = { id: 'interrupted', state: 'preparing', targetMapIds: ['map-partial'] }
  await writeFile(path.join(directory, '_document-lifecycle.json'), JSON.stringify(state))
  manager = await createDocumentReconstruction(options)
  assert.equal(manager.get('interrupted').state, 'failed')
  assert.equal(manager.isUnavailable('map-partial'), true)
})

test('보관·전환만 변경 요청을 독점하며 앞선 변경과 뒤의 변경을 안전하게 분리한다', async () => {
  const acquire = createDocumentMutationGate()
  const first = await acquire(); const second = await acquire()
  let transitionStarted = false; let laterStarted = false
  const transition = acquire(true).then((release) => { transitionStarted = true; return release })
  const later = acquire().then((release) => { laterStarted = true; return release })
  first(); await Promise.resolve(); assert.equal(transitionStarted, false)
  second(); const releaseTransition = await transition
  assert.equal(laterStarted, false)
  releaseTransition(); const releaseLater = await later
  assert.equal(laterStarted, true); releaseLater(); releaseLater()
  const final = await acquire(true); final()
})

test('렌더 배치는 원본·참조·정리안과 결합되고 재시작 시 승인 검증을 다시 요구한다', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-layout-proof-'))
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^mnp-layout-proof-/); await rm(directory, { recursive: true, force: true }) })
  const source = original(); const reference = { id: 'map-reference', version: 1, title: '참조', nodes: [card('ref-source', { aiConversationId: '과거 대화', externalLink: { displayWidth: 510, displayHeight: 420 } })], edges: [] }
  const maps = new Map([[source.id, source], [reference.id, reference]]); let saves = 0
  const options = { dataDirectory: directory, isValidMap, readMap: async (id) => structuredClone(maps.get(id)),
    listMaps: async () => [...maps.values()], readLayout: async () => ({ groups: [], items: [] }), checkIdle: async () => {},
    writeJson: (file, value) => writeFile(file, JSON.stringify(value)), saveMap: async (id, map) => { saves++; return map },
    projectReferenceData: (local, remote) => ({ ...local, ...remote, reference: local.reference }),
  }
  let manager = await createDocumentReconstruction(options)
  const plan = planFor(source); plan.sources = (await manager.context([source.id])).sources
  plan.targets[0].nodes.push(card('ref', { isWork: false, reference: { mapId: reference.id, nodeId: 'ref-source' } }))
  plan.targets[0].edges.push({ id: 'ref-edge', source: 'new-root', target: 'ref' })
  const preview = await manager.preview(plan)
  assert.deepEqual(await manager.preview(plan), preview, '같은 안은 동일한 배치로 미리보기')
  const reordered = (value) => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value
  assert.deepEqual(await manager.preview(reordered(plan)), preview, 'MCP와 UI의 JSON 객체 키 순서 차이는 허용')
  const rendered = preview.targets[0].renderMap.nodes.find((node) => node.id === 'ref')
  const stored = preview.targets[0].map.nodes.find((node) => node.id === 'ref')
  assert.equal(rendered.data.externalLink.displayHeight, 420)
  assert.equal(stored.data.aiConversationId, undefined, '렌더용 참조 투영을 새 카드 데이터에 복사하지 않는다')
  const fixture = reconstructionLayoutFixture(preview)
  await assert.rejects(manager.inspectRenderedLayout(plan, preview.previewHash, fixture, true, {}), /먼저/)
  await assert.rejects(manager.inspectRenderedLayout(plan, preview.previewHash, [], false, {}), /모든 후속/)
  fixture[0].cards[0].height += 50
  const measured = await manager.inspectRenderedLayout(plan, preview.previewHash, fixture, false, {})
  assert.notEqual(measured.previewHash, preview.previewHash, '실제 크기가 달라지면 배치 해시 변경')
  const invalid = reconstructionLayoutFixture(measured); invalid[0].cards[0].x += 20
  await assert.rejects(manager.inspectRenderedLayout(plan, measured.previewHash, invalid, true, {}), /좌표/)
  await assert.rejects(manager.apply(plan, {}, measured.previewHash), /실제 마인드맵/)
  const verified = await manager.inspectRenderedLayout(plan, measured.previewHash, reconstructionLayoutFixture(measured), true, { id: 'reviewer' })
  assert.equal(verified.layoutPhase, 'verified')
  assert.equal(verified.layoutVerification.verifiedBy.id, 'reviewer')
  assert.deepEqual(verified.targets, measured.targets, '최종 렌더 검사는 승인할 좌표를 바꾸지 않는다')
  assert.deepEqual(await manager.preview(plan), verified, 'MCP도 동일한 최종 검증 결과를 조회')
  const changed = structuredClone(plan); changed.reason += '변경'
  await assert.rejects(manager.apply(changed, {}, verified.previewHash), /미리보기/)
  reference.version++
  await assert.rejects(manager.apply(plan, {}, verified.previewHash), /미리보기/)
  assert.equal(saves, 0, '참조 변경은 새 문서 저장 전에 차단')
  const fresh = await verifyLayoutFixture(manager, plan)
  manager = await createDocumentReconstruction(options)
  await assert.rejects(manager.apply(plan, {}, fresh.previewHash), /미리보기/)
  assert.equal((await manager.preview(plan)).layoutPhase, 'draft')
  source.version++
  await assert.rejects(manager.preview(plan), /원본 문서가 변경/)
  assert.equal(saves, 0)
})

test('미완료 선행 관계를 누락하거나 지식선·선행 관계를 순환시키면 거부한다', () => {
  const source = original()
  source.nodes.push(card('prerequisite')); source.edges.push({ id: 'prerequisite-edge', source: 'root', target: 'prerequisite' })
  source.nodes[1].data.blockedBy = ['prerequisite']
  const plan = planFor(source)
  plan.targets[0].nodes[1].data.blockedBy = []
  plan.targets[0].nodes.push(card('new-prerequisite'))
  plan.targets[0].edges.push({ id: 'prerequisite-next', source: 'new-root', target: 'new-prerequisite' })
  plan.decisions.push({ mapId: source.id, cardId: 'prerequisite', disposition: 'carry', reason: '선행 업무', targets: [{ key: 'next', cardId: 'new-prerequisite' }] })
  assert.throws(() => valid(plan, source), /선행 업무 관계/)
  plan.targets[0].nodes[1].data.blockedBy = ['new-prerequisite']
  assert.doesNotThrow(() => valid(plan, source))
  plan.targets[0].nodes[2].data.blockedBy = ['new-work']
  assert.throws(() => valid(plan, source), /순환/)
  delete plan.targets[0].nodes[2].data.blockedBy
  plan.targets[0].edges.push({ id: 'k1', source: 'new-work', target: 'new-prerequisite', data: { relation: 'knowledge' } }, { id: 'k2', source: 'new-prerequisite', target: 'new-work', data: { relation: 'knowledge' } })
  assert.throws(() => valid(plan, source), /순환/)
})
