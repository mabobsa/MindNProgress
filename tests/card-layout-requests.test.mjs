import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createCardLayoutRequests } from '../server/lib/cardLayoutRequests.mjs'

test('배치 요청은 승인·실측·소유자·버전·표시 검증을 거쳐 위치만 적용하고 제안을 복구한다', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-layout-unit-'))
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^mnp-layout-unit-/); await rm(directory, { recursive: true, force: true }) })
  let source = { id: 'map-test', version: 1, title: '원본', nodes: ['root', 'a', 'b'].map((id) => ({ id, type: 'mind', position: { x: 10, y: 10 }, data: { label: id, kind: id === 'root' ? 'root' : 'task' } })), edges: ['a', 'b'].map((id) => ({ id, source: 'root', target: id })) }
  let display = '현재 Ref 표시'; let time = Date.now(); const actor = { id: 'editor' }
  const deps = { dataDirectory: directory, writeJson: (file, value) => writeFile(file, JSON.stringify(value)), assertWritable: () => {}, now: () => time,
    readSnapshot: async () => ({ map: structuredClone(source), renderMap: { ...structuredClone(source), title: display } }),
    savePositions: async (map, positions) => { source = { ...map, version: map.version + 1, nodes: map.nodes.map((node) => ({ ...node, position: positions.get(node.id) })) }; return source } }
  let service = await createCardLayoutRequests(deps)
  await assert.rejects(service.create({ mapId: source.id }, actor), /확인/)
  const original = structuredClone(source)
  let request = await service.create({ mapId: source.id, proposalOnly: true }, actor)
  assert.deepEqual(request.target, { ratio: '16:9' })
  await assert.rejects(service.create({ mapId: source.id, proposalOnly: true, target: { width: 390, height: 844 } }, actor), /16:9/)
  const measured = (map) => map.nodes.map((node) => ({ cardId: node.id, ...node.position, width: 218, height: 170, outsets: { left: 8, right: 8, top: 40, bottom: 8 } }))
  const plan = { order: source.nodes.map((node) => node.id), reason: '실측과 계층을 보존한 배치입니다.' }
  await assert.rejects(service.submit(request.id, { baseRevision: 0, plan }, actor), /크기/)
  request = await service.capture(request.id, { measurements: measured(source) }, actor)
  await service.submit(request.id, { baseRevision: 0, plan }, actor)
  await assert.rejects(service.submit(request.id, { baseRevision: 0, plan }, actor), /다른 제안/)
  await assert.rejects(service.get(request.id, { id: 'other' }), /편집자/)
  assert.deepEqual(source, original)
  let preview = await service.preview(request.id, actor)
  assert.equal(preview.variant, 'balanced')
  assert.deepEqual(preview.metrics.target, request.target)
  assert.ok(preview.candidates.length > 1)
  for (const options of [null, { target: null }, { target: { width: 390, height: 844 } }, { positions: [] }, { variant: 'missing' }]) await assert.rejects(service.preview(request.id, actor, options))
  await assert.rejects(service.apply(request.id, { previewHash: preview.previewHash, approved: true, measurements: measured(preview.map) }, actor), /검증/)
  preview = await service.inspect(request.id, { previewHash: preview.previewHash, measurements: measured(preview.map) }, false, actor)
  preview = await service.inspect(request.id, { previewHash: preview.previewHash, measurements: measured(preview.map) }, true, actor)
  display = 'Ref 원본이 바뀜'
  await assert.rejects(service.apply(request.id, { previewHash: preview.previewHash, approved: true, measurements: measured(preview.map) }, actor), /표시 내용/)
  display = '현재 Ref 표시'
  // v1 무목표·v2 픽셀 요청은 조회 시 비율로 호환하되 저장 파일을 건드리지 않는다.
  const recordFile = path.join(directory, '_card-layout-requests.json')
  const legacy = JSON.parse(await readFile(recordFile, 'utf8')); delete legacy[request.id].target
  await writeFile(recordFile, JSON.stringify(legacy))
  for (const target of [undefined, { width: 1600, height: 900 }, { width: 2560, height: 1440 }]) {
    legacy[request.id].target = target
    await writeFile(recordFile, JSON.stringify(legacy))
    const originalRecord = await readFile(recordFile, 'utf8')
    service = await createCardLayoutRequests(deps)
    assert.deepEqual((await service.get(request.id, actor)).target, { ratio: '16:9' })
    assert.deepEqual(service.list(source.id, actor)[0].target, { ratio: '16:9' })
    assert.equal(await readFile(recordFile, 'utf8'), originalRecord)
  }
  assert.deepEqual((await service.get(request.id, actor)).plan, plan)
  await assert.rejects(service.apply(request.id, { previewHash: preview.previewHash, approved: true }, actor), /만료/)
  const verify = async (options = {}) => {
    let p = await service.preview(request.id, actor, options)
    const selection = { variant: p.variant, target: p.target }
    p = await service.inspect(request.id, { previewHash: p.previewHash, measurements: measured(p.map) }, false, actor)
    assert.deepEqual({ variant: p.variant, target: p.target }, selection)
    return service.inspect(request.id, { previewHash: p.previewHash, measurements: measured(p.map) }, true, actor)
  }
  preview = await verify(); time += 31 * 60_000
  await assert.rejects(service.apply(request.id, { previewHash: preview.previewHash, approved: true }, actor), /만료/)
  preview = await verify()
  await assert.rejects(service.apply(request.id, { previewHash: preview.previewHash, approved: false }, actor), /승인/)
  const oldPreview = preview
  const variant = preview.candidates.find((c) => c.id !== preview.variant).id
  preview = await verify({ variant })
  assert.notDeepEqual(preview.map.nodes.map((n) => n.position), oldPreview.map.nodes.map((n) => n.position))
  const previousTargetPreview = preview
  preview = await verify({ variant, target: { width: 1920, height: 1080 } })
  await assert.rejects(service.apply(request.id, { previewHash: previousTargetPreview.previewHash, approved: true, measurements: measured(previousTargetPreview.map) }, actor), /만료/)
  assert.equal(preview.variant, variant)
  assert.deepEqual(preview.target, { ratio: '16:9' })
  assert.deepEqual(preview.map, previousTargetPreview.map, '해상도만 다른 기존 요청도 좌표는 동일하다')
  for (const ratio of ['4:3', '21:9']) {
    const previous = preview
    preview = await verify({ variant, target: { ratio } })
    assert.deepEqual(preview.target, { ratio })
    await assert.rejects(service.apply(request.id, { previewHash: previous.previewHash, approved: true, measurements: measured(previous.map) }, actor), /만료/)
  }
  await assert.rejects(service.apply(request.id, { previewHash: oldPreview.previewHash, approved: true, measurements: measured(oldPreview.map) }, actor), /만료/)
  assert.deepEqual(source, original, '후보·목표를 바꿔도 원본 불변')
  await service.apply(request.id, { previewHash: preview.previewHash, approved: true, measurements: measured(preview.map) }, actor)
  assert.deepEqual((await service.get(request.id, actor)).appliedLayout, { version: 'card-layout-v3', target: preview.target, variant })
  assert.deepEqual(source.nodes.map(({ position: _p, ...n }) => n), original.nodes.map(({ position: _p, ...n }) => n))
  assert.deepEqual(source.edges, original.edges)
  assert.deepEqual(source.nodes.map((n) => n.position), preview.map.nodes.map((n) => n.position))
  const unchanged = structuredClone(source)
  request = await service.create({ mapId: source.id, proposalOnly: true }, actor)
  await service.cancel(request.id, actor)
  assert.deepEqual(source, unchanged)
  await assert.rejects(service.preview(request.id, actor), /종료/)
  assert.ok((await readFile(path.join(directory, '_card-layout-requests.json'), 'utf8')).includes('cancelled'))
})
