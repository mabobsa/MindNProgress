import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  assertOutputFileDiffersFromPlanFile, shapeReconstructionResponse, summarizeLifecycleResult, summarizePreview,
  summarizeReconstructions, summarizeRequest, writeResponseFile,
} from '../mcp/reconstructionResponses.mjs'

// 2026-11-17: 미리보기 183,071자·요청 조회 51,120자·전환 이력 643,401자가 AI 도구 출력 한도를 넘었다.
// 기본 응답은 판단에 필요한 해시·검사 결과·경고를 두고 큰 본문만 요약하며, 전체는 detail=full 또는 outputFile로 받는다.
const node = (id, data = {}) => ({ id, type: 'mind', position: { x: 1, y: 2 }, data: { label: id, isWork: true, status: 'planned', ...data } })
const map = { nodes: [node('root', { isWork: false }), node('a', { waitingItems: [{ id: 'w1' }, { id: 'w2' }] }), node('b', { status: 'done' }), node('ref', { isWork: false, reference: { mapId: 'map-x', nodeId: 'n' } })], edges: [{ id: 'e1' }, { id: 'e2' }] }
const impact = { version: 1, currentGroups: [{ id: 'g', mapIds: ['map-1'] }], references: { documents: [{ id: 'map-x' }], links: [{ id: 'l1' }, { id: 'l2' }] }, allowedTransitions: [], warnings: ['참조 확인'] }
const preview = { previewHash: 'hash-1', layoutPhase: 'draft', warnings: ['의미 검토'], impactValidation: impact, sources: [{ mapId: 'map-1' }],
  targets: [{ key: 'next', title: '후속', layout: { boxes: [] }, map, renderMap: { nodes: map.nodes } }] }

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-recon-response-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('미리보기 요약은 생성될 문서 본문만 구성 수로 바꾸고 해시·단계·경고·참조 영향은 둔다', () => {
  const { result, fields } = summarizePreview(preview)
  assert.equal(result.previewHash, 'hash-1')
  assert.equal(result.layoutPhase, 'draft')
  assert.deepEqual(result.warnings, ['의미 검토'])
  assert.equal(Object.hasOwn(result.targets[0], 'map'), false)
  assert.equal(Object.hasOwn(result.targets[0], 'renderMap'), false)
  assert.deepEqual(result.targets[0].layout, { boxes: [] })
  assert.deepEqual(result.targets[0].mapSummary, { cards: 4, edges: 2, workCards: 2, incompleteWorkCards: 1, waitingCards: 1, waitingItems: 2, referenceCards: 1 })
  assert.equal(result.impactValidation.currentGroupsCount, 1)
  assert.deepEqual(result.impactValidation.references, impact.references, '예산 안이면 참조 영향 그래프는 그대로 둔다')
  assert.deepEqual(result.impactValidation.warnings, ['참조 확인'])
  assert.deepEqual(Object.keys(fields).sort(), ['impactValidation.currentGroups', 'targets[].map', 'targets[].renderMap'])
  const tight = summarizePreview(preview, { limitChars: 2_100 })
  assert.deepEqual(tight.result.impactValidation.referencesCount, { documents: 1, links: 2 }, '예산을 넘으면 참조 그래프를 개수로 줄인다')
  assert.deepEqual(tight.result.impactValidation.warnings, ['참조 확인'])
})

test('요청 조회 요약은 저장된 정리안 본문을 구성·해시로 바꾸고, 정리안이 없으면 그대로 둔다', () => {
  const plan = { id: 'p1', mode: 'compact', baseline: 'v1', targets: [{ key: 'next', title: '후속', nodes: map.nodes, edges: map.edges }], decisions: [{ cardId: 'a' }, { cardId: 'b' }] }
  const { result, fields } = summarizeRequest({ id: 'reorg-request-1', revision: 2, plan, referenceBaseline: { documents: [] } })
  assert.equal(Object.hasOwn(result, 'plan'), false)
  assert.equal(result.revision, 2)
  assert.deepEqual(result.referenceBaseline, { documents: [] })
  const compact = JSON.stringify(plan)
  assert.deepEqual(result.planSummary, { id: 'p1', mode: 'compact', baseline: 'v1', targets: [{ key: 'next', title: '후속', cards: 4, edges: 2 }], decisions: 2,
    chars: [...compact].length, sha256: createHash('sha256').update(compact).digest('hex') })
  assert.deepEqual(Object.keys(fields), ['plan'])
  const empty = summarizeRequest({ id: 'reorg-request-1', revision: 0, plan: null })
  assert.deepEqual(empty, { result: { id: 'reorg-request-1', revision: 0, plan: null }, fields: {} })
})

test('전환 이력 목록은 식별·상태·문서·개수만 두고, 예산을 넘으면 오래된 것부터 빼고 전체 수를 밝힌다', () => {
  const operation = (index) => ({ id: `op-${index}`, state: 'applied', mode: 'compact', baseline: '기준', createdAt: `2026-11-${String(20 - index).padStart(2, '0')}`,
    createdBy: { id: 'u', name: '김용민', email: 'x@example.com' }, sources: [{ mapId: 'map-1', sha256: 'a'.repeat(64) }], targetMapIds: ['map-2'],
    before: { cards: 3 }, after: { cards: 2 }, impactValidation: impact, groupBaselines: [{}], targetLayouts: [{}], decisions: [{}, {}, {}], changeSummary: '변경 요약'.repeat(50) })
  const all = { operations: [operation(1), operation(2), operation(3)] }
  const { result } = summarizeReconstructions(all)
  assert.deepEqual(result.operations[0], { id: 'op-1', state: 'applied', mode: 'compact', baseline: '기준', createdAt: '2026-11-19', targetMapIds: ['map-2'],
    before: { cards: 3 }, after: { cards: 2 }, createdBy: '김용민', sourceMapIds: ['map-1'], decisionsCount: 3 })
  assert.equal(result.operationsTotal, undefined)
  const one = JSON.stringify(result.operations[0]).length
  const tight = summarizeReconstructions(all, { limitChars: 2_000 + one * 2 + 60 })
  assert.equal(tight.result.operationsTotal, 3)
  assert.equal(tight.result.operationsReturned, 2)
  assert.deepEqual(tight.result.operations.map((item) => item.id), ['op-1', 'op-2'], '서버의 최신순을 지키고 오래된 것을 뺀다')
  assert.match(tight.fields['operations[] 이후 항목'], /오래된 전환 1건.*outputFile/)
})

test('전환 이력 한 건은 카드 대응표를 두고, 예산을 넘으면 참조 그래프·대응표 순서로 줄인다', () => {
  const operation = { id: 'op-1', state: 'applied', createdBy: { id: 'u', name: '김용민' }, impactValidation: impact, groupBaselines: [{}, {}], targetLayouts: [{}],
    decisions: [{ mapId: 'map-1', cardId: 'a', disposition: 'carry', reason: '유지'.repeat(200) }] }
  const { result } = summarizeReconstructions(operation)
  assert.deepEqual(result.decisions, operation.decisions)
  assert.deepEqual(result.createdBy, { id: 'u', name: '김용민' })
  assert.equal(result.groupBaselinesCount, 2)
  assert.equal(result.targetLayoutsCount, 1)
  assert.equal(result.impactValidation.currentGroupsCount, 1)
  const tight = summarizeReconstructions(operation, { limitChars: 2_300 })
  assert.equal(tight.result.decisionsCount, 1)
  assert.equal(Object.hasOwn(tight.result, 'decisions'), false)
  assert.deepEqual(tight.result.impactValidation.referencesCount, { documents: 1, links: 2 })
})

test('적용·되돌리기 응답은 전환 상태와 문서 ID를 두고 전체 문서 목록·배치는 개수로 줄인다', () => {
  const operation = { id: 'op-1', state: 'applied', createdBy: { id: 'u', name: '김용민' }, sources: [{ mapId: 'map-1' }], targetMapIds: ['map-2'], decisions: [{}], impactValidation: impact }
  const result = summarizeLifecycleResult({ operation, maps: [{ id: 'map-1' }, { id: 'map-2' }, { id: 'map-3' }], documentLayout: { groups: [] },
    documentGroups: [{ mapId: 'map-1' }, { mapId: 'map-2' }, { mapId: 'map-3' }] })
  assert.equal(result.operation.state, 'applied')
  assert.deepEqual(result.operation.createdBy, { id: 'u', name: '김용민' })
  assert.deepEqual(result.operation.targetMapIds, ['map-2'])
  assert.equal(result.operation.decisionsCount, 1)
  assert.equal(result.mapsCount, 3)
  assert.equal(Object.hasOwn(result, 'maps'), false)
  assert.equal(Object.hasOwn(result, 'documentLayout'), false)
  assert.deepEqual(result.documentGroups.map((entry) => entry.mapId), ['map-1', 'map-2'], '그룹 정보는 이 전환의 문서만 남긴다')
  assert.deepEqual(result.omitted.retrieval.operation, { tool: 'mindnprogress_get_reconstructions', arguments: { id: 'op-1', outputFile: '<이 PC의 .json 절대 경로>' } })
  assert.equal(summarizeLifecycleResult({ error: 'x' }).error, 'x', '전환 기록이 없는 응답은 그대로 둔다')
})

test('응답 조립은 detail=full이면 전체를, outputFile이면 전체를 파일로 저장하고 해시를 돌려준다', () => withDirectory(async (directory) => {
  const retrieval = { full: { tool: 't', arguments: { detail: 'full' } } }
  const summary = await shapeReconstructionResponse(preview, { summarize: summarizePreview, retrieval })
  assert.deepEqual(Object.keys(summary).slice(0, 2), ['omitted', 'previewHash'], '생략 안내를 맨 앞에 둔다')
  assert.deepEqual(summary.omitted.retrieval, retrieval)
  assert.deepEqual(await shapeReconstructionResponse(preview, { detail: 'full', summarize: summarizePreview, retrieval }), preview)
  const file = path.join(directory, '미리보기 전체.json')
  const saved = await shapeReconstructionResponse(preview, { outputFile: file, summarize: summarizePreview, retrieval })
  const bytes = await readFile(file)
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), preview, '파일에는 요약하지 않은 전체가 들어간다')
  assert.deepEqual(saved.outputFile, { path: path.resolve(file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, chars: [...bytes.toString('utf8')].length })
  assert.equal(Object.hasOwn(saved.targets[0], 'map'), false, '파일로 받을 때 응답은 요약이다')
  const plain = await shapeReconstructionResponse({ id: 'r', plan: null }, { summarize: summarizeRequest, retrieval })
  assert.deepEqual(plain, { id: 'r', plan: null }, '생략한 것이 없으면 원래 응답 그대로다')
}))

test('outputFile은 절대 경로·.json·있는 폴더만 받고, 정리안 파일과 같은 경로는 거절한다', () => withDirectory(async (directory) => {
  const reject = (promise, pattern) => assert.rejects(promise, (error) => {
    assert.equal(error.reasonCode, 'RECONSTRUCTION_OUTPUT_FILE_INVALID')
    assert.match(error.message, pattern)
    return true
  })
  await reject(writeResponseFile('out.json', {}), /절대 경로/)
  await reject(writeResponseFile(path.join(directory, 'out.txt'), {}), /\.json 파일/)
  await reject(writeResponseFile(path.join(directory, 'none', 'out.json'), {}), /폴더가 없습니다/)
  const plan = path.join(directory, 'plan.json')
  assert.throws(() => assertOutputFileDiffersFromPlanFile({ planFile: plan, outputFile: plan.toUpperCase() }), /planFile.*같은 경로/)
  assert.doesNotThrow(() => assertOutputFileDiffersFromPlanFile({ planFile: plan, outputFile: path.join(directory, 'preview.json') }))
  assert.doesNotThrow(() => assertOutputFileDiffersFromPlanFile({ plan: {}, outputFile: plan }))
}))
