import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { documentReconstructionGuide } from '../../src/utils/documentReconstructionGuide.mjs'
import { layoutMindMap, verifyRenderedLayout, MIND_MAP_LAYOUT_VERSION } from '../../src/utils/mindMapLayout.mjs'
import { applyProgressRollup } from '../../src/utils/progressRollup.mjs'
import { impactHash, inspectReconstructionImpact } from './reconstructionImpact.mjs'

export function reconstructionError(message, status = 400, code = 'RECONSTRUCTION_INVALID') {
  return Object.assign(new Error(message), { status, code, reconstructionError: true })
}

// 평소 문서 요청은 병렬 실행하고, 보관·전환만 진행 중인 변경을 기다려 독점한다.
export function createDocumentMutationGate() {
  const pending = []
  let active = 0
  let exclusive = false
  const drain = () => {
    while (pending.length && !exclusive) {
      if (pending[0].exclusive && active > 0) return
      const next = pending.shift()
      active++
      exclusive = next.exclusive
      let released = false
      next.resolve(() => {
        if (released) return
        released = true
        active--; exclusive = false; drain()
      })
    }
  }
  return (isExclusive = false) => new Promise((resolve) => { pending.push({ exclusive: isExclusive, resolve }); drain() })
}

export const reconstructionSourceHash = (map) => createHash('sha256').update(JSON.stringify({
  id: map.id, version: map.version, title: map.title, nodes: map.nodes, edges: map.edges,
})).digest('hex')
const keyFor = (mapId, cardId) => `${mapId}/${cardId}`
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// MCP 스키마와 브라우저 JSON의 객체 키 순서가 달라도 같은 안이다. 배열(카드·형제 순서)은 유지한다.
const canonicalValue = (value) => Array.isArray(value) ? value.map(canonicalValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])])) : value
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const activeWork = (node) => node.data?.isWork === true && !node.data.reference
  && (node.data.status !== 'done' || node.data.progress < 100)
const textOf = (node) => (node.data.waitingItems ?? []).flatMap((w) => [w.label, w.note, w.resumeCondition]).filter(Boolean).join('\n')
const statusStats = (maps) => {
  const nodes = maps.flatMap((map) => map.nodes)
  const work = nodes.filter((node) => node.data?.isWork && !node.data.reference && node.data.kind !== 'root')
  return { documents: maps.length, cards: nodes.length, work: work.length,
    done: work.filter((node) => node.data.status === 'done' && node.data.progress >= 100).length,
    unfinished: work.filter(activeWork).length, waitingCards: nodes.filter((node) => !node.data.reference && node.data.waitingItems?.length).length,
    references: nodes.filter((node) => node.data.reference).length }
}

export function validateReconstruction(plan, sourceMaps, { isValidMap, targetExists = () => false } = {}) {
  const fail = (message, code) => { throw reconstructionError(message, 400, code) }
  if (!plan || !/^[a-zA-Z0-9_-]{1,80}$/.test(plan.id ?? '')) fail('전환 ID는 영문·숫자·밑줄·하이픈 1~80자여야 합니다.')
  if (!Object.hasOwn(documentReconstructionGuide.modes, plan.mode)) fail('기획 갱신 또는 규모 정리 모드를 선택하세요.')
  if (!nonempty(plan.baseline) || !nonempty(plan.reason)) fail('현재 기획 기준과 정리 목적이 필요합니다.')
  if (plan.mode === 'spec-update' && (!nonempty(plan.newSource) || !nonempty(plan.changeSummary))) fail('기획 갱신은 새 원본과 변경 분석이 필요합니다.')
  if (!Array.isArray(plan.sources) || !plan.sources.length || plan.sources.length > 30) fail('원본 문서를 1~30개 지정하세요.')
  if (!Array.isArray(plan.targets) || !plan.targets.length || plan.targets.length > 30) fail('후속 문서를 1~30개 지정하세요.')
  if (!Array.isArray(plan.decisions) || plan.decisions.some((item) => !item || typeof item !== 'object')) fail('모든 원본 카드의 처리표가 필요합니다.')
  const sources = new Map(sourceMaps.map((map) => [map.id, map]))
  if (sources.size !== plan.sources.length || new Set(plan.sources.map((s) => s.mapId)).size !== plan.sources.length) fail('원본 문서가 중복되거나 누락되었습니다.')
  const originalNodes = new Map()
  for (const source of plan.sources) {
    const map = sources.get(source.mapId)
    if (!map || map.trashedAt || map.archivedAt || map.reconstructionPending) fail('활성 원본 문서를 찾을 수 없습니다.')
    if (source.version !== map.version || source.sha256 !== reconstructionSourceHash(map)) throw reconstructionError('원본 문서가 변경되었습니다. 전환안을 다시 검토하세요.', 409, 'RECONSTRUCTION_STALE')
    for (const node of map.nodes) originalNodes.set(keyFor(map.id, node.id), { map, node })
  }
  const targetKeys = new Set()
  const targetNodes = new Map()
  const targets = plan.targets.map((target) => {
    if (!target || typeof target !== 'object') fail('후속 문서 형식이 올바르지 않습니다.')
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(target.key ?? '') || targetKeys.has(target.key)) fail('후속 문서 key가 중복되거나 올바르지 않습니다.')
    targetKeys.add(target.key)
    if (!nonempty(target.title) || target.title.length > 80) fail('후속 문서 제목은 1~80자여야 합니다.')
    if (!Array.isArray(target.nodes) || !Array.isArray(target.edges)) fail('후속 문서의 카드·관계 목록이 필요합니다.')
    const id = `map-reorg-${createHash('sha256').update(`${plan.id}/${target.key}`).digest('hex').slice(0, 20)}`
    if (targetExists(id)) fail('후속 문서 ID가 이미 존재합니다. 다른 전환 ID를 사용하세요.')
    const map = structuredClone({ id, title: target.title, color: target.color, nodes: target.nodes?.map((node) => ({ ...node, position: { x: 0, y: 0 } })), edges: target.edges })
    if (!isValidMap(map)) fail(`후속 문서 형식이 올바르지 않습니다: ${target.title}`)
    if (new Set(map.nodes.map((node) => node.id)).size !== map.nodes.length || new Set(map.edges.map((edge) => edge.id)).size !== map.edges.length) fail('후속 카드 또는 관계 ID가 중복되었습니다.')
    const ids = new Set(map.nodes.map((node) => node.id))
    const parents = new Map()
    for (const edge of map.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target)) fail('존재하지 않는 카드를 연결한 관계가 있습니다.')
      if (edge.data?.relation !== 'knowledge') {
        if (parents.has(edge.target)) fail('하위 카드의 상위 카드는 하나여야 합니다.')
        parents.set(edge.target, edge.source)
      }
    }
    const roots = map.nodes.filter((node) => !parents.has(node.id))
    if (roots.length !== 1 || roots[0].data.kind !== 'root' || roots[0].data.isWork || map.nodes.filter((node) => node.data.kind === 'root').length !== 1) fail('후속 문서는 집계 전용 루트 하나가 필요합니다.')
    for (const node of map.nodes) {
      if (!nonempty(node.id) || node.type !== 'mind' || !nonempty(node.data?.label) || typeof node.data.description !== 'string' || !['root', 'branch', 'task', 'image'].includes(node.data.kind)
        || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)
        || typeof node.data.isWork !== 'boolean' || !['planned', 'in-progress', 'done'].includes(node.data.status)
        || !Number.isFinite(node.data.progress) || node.data.progress < 0 || node.data.progress > 100) fail('후속 카드의 기본 필드가 올바르지 않습니다.')
      if ((node.data.status === 'done') !== (node.data.progress === 100)) fail('완료 상태와 진행률이 일치하지 않습니다.')
      if (node.data.checklist !== undefined && (!Array.isArray(node.data.checklist)
        || node.data.checklist.some((item) => !nonempty(item?.id) || !nonempty(item?.text) || typeof item.done !== 'boolean')
        || new Set(node.data.checklist.map((item) => item.id)).size !== node.data.checklist.length)) fail('체크리스트 형식 또는 ID가 올바르지 않습니다.')
      if (node.data.blockedBy !== undefined && (!Array.isArray(node.data.blockedBy) || node.data.blockedBy.some((id) => !ids.has(id) || id === node.id))) fail('선행 업무 연결이 올바르지 않습니다.')
      if (node.data.status === 'done' && node.data.waitingItems?.length) fail('대기 항목이 있는 카드를 완료 처리할 수 없습니다.')
      if (node.data.isWork && node.data.checklist?.length && node.data.progress !== Math.round(100 * node.data.checklist.filter((item) => item.done).length / node.data.checklist.length)) fail('진행률은 체크리스트 결과와 일치해야 합니다.')
      // 출처는 서버가 처리표에서 생성한다. 호출자가 과거 출처를 위조하거나 복제하지 않는다.
      delete node.data.reconstructionSources
      const visited = new Set()
      let cursor = node.id
      while (parents.has(cursor)) {
        if (visited.has(cursor)) fail('계층에 순환 관계가 있습니다.')
        visited.add(cursor)
        cursor = parents.get(cursor)
      }
      if (node.data.aiConversationId || node.data.aiConversations?.length) fail('과거 AI 대화를 새 카드에 연결하지 마세요. 출처 링크를 사용하세요.')
      if (node.data.kind === 'image') fail('이미지 원본은 기존 문서에 보존하고 출처 링크로 연결하세요.')
      if (node.data.reference && node.data.isWork) fail('Ref 카드를 새 실행 업무로 사용하지 마세요.')
      targetNodes.set(keyFor(target.key, node.id), { map, node })
    }
    for (const relation of ['knowledge', 'blockedBy']) {
      const adjacency = new Map(map.nodes.map((node) => [node.id, relation === 'knowledge'
        ? map.edges.filter((edge) => edge.data?.relation === 'knowledge' && edge.source === node.id).map((edge) => edge.target)
        : node.data.blockedBy ?? []]))
      const visited = new Set(); const visiting = new Set()
      const visit = (id) => {
        if (visiting.has(id)) fail('지식선 또는 선행 업무 관계에 순환이 있습니다.')
        if (visited.has(id)) return
        visiting.add(id)
        for (const next of adjacency.get(id)) visit(next)
        visiting.delete(id); visited.add(id)
      }
      for (const id of ids) visit(id)
    }
    return { key: target.key, map }
  })
  for (const { map } of targets) {
    for (const node of map.nodes) {
      const reference = node.data.reference
      if (!reference) continue
      if (typeof reference !== 'object' || !nonempty(reference.nodeId)) fail('Ref 원본 카드 ID가 필요합니다.')
      if (reference.targetKey) {
        const target = targets.find((target) => target.key === reference.targetKey)
        if (!target || !target.map.nodes.some((card) => card.id === reference.nodeId)) fail('새 문서 Ref의 대상 카드가 없습니다.')
        node.data.reference = { mapId: target.map.id, nodeId: reference.nodeId }
      } else if (!/^map-[a-zA-Z0-9_-]+$/.test(reference.mapId ?? '')) fail('Ref 원본 문서 ID가 올바르지 않습니다.')
    }
  }
  const handled = new Set()
  for (const decision of plan.decisions) {
    const key = keyFor(decision.mapId, decision.cardId)
    const source = originalNodes.get(key)
    if (!source || handled.has(key)) fail('원본 카드 처리표에 중복 또는 알 수 없는 카드가 있습니다.')
    handled.add(key)
    if (!Object.hasOwn(documentReconstructionGuide.dispositions, decision.disposition) || !nonempty(decision.reason)) fail('각 카드의 처리 방식과 이유가 필요합니다.')
    if (decision.disposition === 'drop' && (plan.mode !== 'spec-update' || !nonempty(decision.evidence))) fail('요구사항 제외는 기획 갱신에서 변경 근거와 함께만 허용됩니다.')
    if (decision.targets !== undefined && !Array.isArray(decision.targets)) fail('후속 카드 목록이 올바르지 않습니다.')
    const destinations = (decision.targets ?? []).map((ref) => targetNodes.get(keyFor(ref?.key, ref?.cardId)))
    if (destinations.some((item) => !item)) fail('처리표의 후속 카드를 찾을 수 없습니다.')
    if (['carry', 'merge', 'knowledge'].includes(decision.disposition) && !destinations.length) fail('승계·통합·지식 항목에는 후속 카드가 필요합니다.')
    // Ref와 루트는 실제 실행 업무가 아니다. 비업무 카드에 붙은 대기는 따로 보존한다.
    const isUnfinished = source.node.data.kind !== 'root' && activeWork(source.node)
    if (isUnfinished && decision.disposition !== 'drop') {
      if (!destinations.some(({ node }) => activeWork(node) && node.data.kind !== 'root')) fail(`미완료 업무를 승계할 실제 업무가 없습니다: ${source.node.data.label}`)
      const checklist = destinations.flatMap(({ node }) => node.data.checklist ?? [])
      for (const item of source.node.data.checklist ?? []) {
        if (!checklist.some((next) => next.text === item.text && next.done === item.done)) fail(`체크리스트 결과가 승계되지 않았습니다: ${source.node.data.label} / ${item.text}`)
      }
    }
    if (!source.node.data.reference && source.node.data.waitingItems?.length && decision.disposition !== 'drop') {
      const destinationText = destinations.map(({ node }) => textOf(node)).join('\n')
      if (!destinations.some(({ node }) => node.data.waitingItems?.length)) fail(`대기 항목의 후속 카드가 없습니다: ${source.node.data.label}`)
      for (const waiting of source.node.data.waitingItems) {
        for (const value of [waiting.label, waiting.note, waiting.resumeCondition].filter(Boolean)) {
          if (!destinationText.includes(value)) fail(`대기 조건이 승계되지 않았습니다: ${source.node.data.label}`)
        }
      }
    }
    for (const { node } of destinations) {
      node.data.reconstructionSources ??= []
      if (!node.data.reconstructionSources.some((ref) => ref.mapId === decision.mapId && ref.cardId === decision.cardId)) {
        node.data.reconstructionSources.push({ mapId: decision.mapId, cardId: decision.cardId, version: source.map.version, disposition: decision.disposition })
      }
    }
  }
  if (handled.size !== originalNodes.size) fail(`미분류 원본 카드가 ${originalNodes.size - handled.size}개 있습니다.`)
  const decisions = new Map(plan.decisions.map((decision) => [keyFor(decision.mapId, decision.cardId), decision]))
  for (const { map, node } of originalNodes.values()) {
    if (!activeWork(node)) continue
    const decision = decisions.get(keyFor(map.id, node.id))
    if (decision.disposition === 'drop') continue
    for (const prerequisite of node.data.blockedBy ?? []) {
      const original = originalNodes.get(keyFor(map.id, prerequisite))
      if (!original || !activeWork(original.node)) continue
      const predecessor = decisions.get(keyFor(map.id, prerequisite))
      if (predecessor.disposition === 'drop') continue
      const represented = (decision.targets ?? []).some((target) => (predecessor.targets ?? []).some((dependency) => target.key === dependency.key
        && (target.cardId === dependency.cardId || targetNodes.get(keyFor(target.key, target.cardId)).node.data.blockedBy?.includes(dependency.cardId))))
      if (!represented) fail(`미완료 선행 업무 관계가 승계되지 않았습니다: ${node.data.label}`)
    }
  }
  const after = statusStats(targets.map((target) => target.map))
  return { id: plan.id, mode: plan.mode, sources: plan.sources, targets, before: statusStats(sourceMaps), after,
    dispositionCounts: plan.decisions.reduce((counts, d) => ({ ...counts, [d.disposition]: (counts[d.disposition] ?? 0) + 1 }), {}),
    sourceCardCount: handled.size, warnings: ['문자열·구조 검증은 의미 검토를 대신하지 않습니다. 현재 지식과 요구사항의 의미 보존을 확인하세요.'], guide: documentReconstructionGuide }
}

// 보관·전환 상태는 문서 원문과 분리한다. 한 파일의 원자적 교체가 활성 문서 전환점이다.
export async function createDocumentReconstruction({ dataDirectory, writeJson, readMap, saveMap, listMaps, readLayout, checkIdle, isValidMap, readComments = async () => [], checkGroup = async () => {}, groupContext = async () => [], proposalBaseline = () => null, projectReferenceData = (local) => local }) {
  const file = path.join(dataDirectory, '_document-lifecycle.json')
  let state
  try { state = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { version: 1, documents: {}, operations: {} } }
  let queue = Promise.resolve()
  const previewSecret = randomBytes(32)
  const lockedIds = new Set()
  const previewHash = (value) => createHmac('sha256', previewSecret).update(JSON.stringify(canonicalValue(value))).digest('hex')
  const previews = new Map()
  const placeTarget = (target, measurements) => {
    const placed = layoutMindMap(target.renderMap ?? target.map, measurements)
    const originalData = new Map(target.map.nodes.map((node) => [node.id, node.data]))
    return { key: target.key, layout: placed.layout, renderMap: placed.map,
      map: { ...placed.map, nodes: placed.map.nodes.map((node) => ({ ...node, data: originalData.get(node.id) })) } }
  }
  const publishPreview = (intent, result) => {
    const published = { ...result, previewHash: previewHash({ intent, layouts: result.targets.map((target) => target.layout) }) }
    previews.delete(intent); previews.set(intent, { result: published, expiresAt: Date.now() + 30 * 60_000 })
    while (previews.size > 20) previews.delete(previews.keys().next().value)
    return structuredClone(published)
  }
  const exclusive = (action) => { const result = queue.then(action); queue = result.catch(() => {}); return result }
  async function persist(next) { await writeJson(file, next); state = next }
  const metadata = (id) => state.documents[id] ?? {}
  const get = (id) => state.operations[id] ?? null
  const publicRecord = (record) => record ? { ...record, plan: undefined } : null
  const isUnavailable = (id) => Boolean(metadata(id).archivedAt || metadata(id).reconstructionPending)
  function assertWritable(id) {
    if (isUnavailable(id) || lockedIds.has(id)) throw reconstructionError('보관 중이거나 전환 준비 중인 문서는 변경할 수 없습니다. 보관함에서 복원한 뒤 수정하세요.', 409, 'DOCUMENT_ARCHIVED')
  }
  function projectLayout(layout, activeIds, metadataSnapshot = state.documents) {
    if (!layout || !Array.isArray(layout.groups) || !Array.isArray(layout.items)) return layout
    const next = structuredClone(layout)
    const active = new Set(activeIds)
    const snapshotMetadata = (id) => metadataSnapshot[id] ?? {}
    const listed = new Set([...next.groups.flatMap((group) => group.mapIds), ...next.items.filter((item) => item.type === 'map').map((item) => item.id)])
    const expand = (id, visited = new Set()) => {
      if (active.has(id)) return [id]
      if (visited.has(id)) return []
      visited.add(id)
      return (snapshotMetadata(id).successorMapIds ?? []).filter((target) => !listed.has(target)).flatMap((target) => expand(target, visited))
    }
    for (const group of next.groups) group.mapIds = [...new Set(group.mapIds.flatMap((id) => expand(id)))]
    next.items = next.items.flatMap((item) => item.type === 'group' ? [item] : expand(item.id).map((id) => ({ type: 'map', id })))
    // 이전 배치가 저장되며 사라졌더라도 후속 문서는 원래 그룹으로 연결한다.
    const placed = new Set([...next.groups.flatMap((g) => g.mapIds), ...next.items.filter((i) => i.type === 'map').map((i) => i.id)])
    for (const id of activeIds) {
      const group = next.groups.find((g) => g.id === snapshotMetadata(id).originGroupId)
      if (!placed.has(id) && group) { group.mapIds.push(id); placed.add(id) }
    }
    return next
  }
  const inspectImpact = async (plan, sources, targets, baseline) => inspectReconstructionImpact({ plan, sources, targets,
    groups: await groupContext(plan.sources.map((source) => source.mapId)),
    library: await listMaps({ includeArchived: true, includePending: true, includeTrashed: true }),
    readMap, readComments, readLayout, metadata, operations: Object.values(state.operations), baseline, sourceHash: reconstructionSourceHash })
  async function inspect(plan, { submitting = false } = {}) {
    if (!Array.isArray(plan?.sources) || plan.sources.length < 1 || plan.sources.length > 30
      || plan.sources.some((source) => !source || !/^map-[a-zA-Z0-9_-]+$/.test(source.mapId ?? ''))) throw reconstructionError('원본 문서 ID를 1~30개 지정하세요.')
    const sources = await Promise.all((plan?.sources ?? []).map((source) => readMap(source.mapId)))
    if (sources.some((source) => !source)) throw reconstructionError('원본 문서를 찾을 수 없습니다.', 404)
    const existing = new Set((await listMaps({ includeArchived: true, includePending: true, includeTrashed: true })).map((map) => map.id))
    const result = validateReconstruction(plan, sources, { isValidMap, targetExists: (id) => existing.has(id) })
    for (const source of plan.sources) {
      if (source.commentsSha256 !== hash(await readComments(source.mapId)) || source.lifecycleVersion !== (metadata(source.mapId).lifecycleVersion ?? 0)) throw reconstructionError('원본 댓글 또는 보관 상태가 변경되었습니다. 전환안을 다시 검토하세요.', 409, 'RECONSTRUCTION_STALE')
    }
    await checkGroup(plan.sources.map((source) => source.mapId))
    const impactValidation = await inspectImpact(plan, sources, result.targets, submitting ? null : proposalBaseline(plan))
    const referenceSnapshots = new Map()
    for (const target of result.targets) target.map = applyProgressRollup(target.map)
    const renderTargets = structuredClone(result.targets)
    for (const target of renderTargets) {
      for (const node of target.map.nodes) {
        if (!node.data.reference) continue
        const source = result.targets.find((target) => target.map.id === node.data.reference.mapId)?.map ?? await readMap(node.data.reference.mapId)
        const sourceCard = source?.nodes.find((n) => n.id === node.data.reference.nodeId)
        if (!source || source.trashedAt || !sourceCard || sourceCard.data.reference || source.id === target.map.id && sourceCard.id === node.id) throw reconstructionError(`Ref 원본을 찾을 수 없거나 또 다른 Ref를 가리킵니다: ${node.data.label}`)
        node.data = projectReferenceData(node.data, sourceCard.data)
        node.data.commentCount = (await readComments(source.id)).filter((comment) => comment.nodeId === sourceCard.id).length
        if (!result.targets.some((target) => target.map.id === source.id)) referenceSnapshots.set(source.id, { mapId: source.id, sha256: reconstructionSourceHash(source) })
      }
    }
    const intent = previewHash({ plan: { ...plan, approval: undefined }, targets: renderTargets, references: [...referenceSnapshots.values()], impact: impactValidation.references, impactVersion: impactValidation.version, version: MIND_MAP_LAYOUT_VERSION })
    const cached = previews.get(intent)
    const impactResult = { impactValidation, warnings: [...result.warnings, ...impactValidation.warnings] }
    if (cached?.expiresAt > Date.now()) {
      if (impactHash({ ...impactValidation, checkedAt: undefined }) === impactHash({ ...cached.result.impactValidation, checkedAt: undefined })) return structuredClone(cached.result)
      return structuredClone({ ...cached.result, ...impactResult })
    }
    return publishPreview(intent, { ...result, layoutPhase: 'draft', baseline: plan.baseline, reason: plan.reason, newSource: plan.newSource, changeSummary: plan.changeSummary,
      ...impactResult,
      targets: result.targets.map((target, index) => placeTarget({ ...target, renderMap: renderTargets[index].map })), referenceSnapshots: [...referenceSnapshots.values()],
      sourceCards: sources.flatMap((map) => map.nodes.map((node) => ({ mapId: map.id, cardId: node.id, label: node.data.label }))) })
  }
  async function inspectRenderedLayout(plan, suppliedPreviewHash, measurements, verify, user) {
    const preview = await inspect(plan)
    if (preview.previewHash !== suppliedPreviewHash) throw reconstructionError('원본·참조 또는 미리보기가 달라졌습니다. 다시 검증하세요.', 409, 'RECONSTRUCTION_PREVIEW_REQUIRED')
    const entry = [...previews.entries()].find(([, cached]) => cached.result.previewHash === suppliedPreviewHash)
    if (!entry) throw reconstructionError('미리보기의 렌더 검증 시간이 만료되었습니다.', 409)
    if (!Array.isArray(measurements) || measurements.length !== preview.targets.length || new Set(measurements.map((item) => item?.key)).size !== measurements.length) throw reconstructionError('모든 후속 문서의 실제 렌더 측정이 필요합니다.')
    const targets = preview.targets.map((target) => {
      const measured = measurements.find((item) => item?.key === target.key)?.cards
      if (verify) {
        if (preview.layoutPhase === 'draft') throw reconstructionError('실제 크기를 반영한 배치를 먼저 확인하세요.', 409)
        verifyRenderedLayout(target.map, target.layout, measured)
        return target
      }
      return placeTarget(target, measured)
    })
    return publishPreview(entry[0], { ...preview, targets, layoutPhase: verify ? 'verified' : 'measured',
      layoutVerification: verify ? { verifiedAt: new Date().toISOString(), verifiedBy: user, version: MIND_MAP_LAYOUT_VERSION } : undefined })
  }
  async function context(mapIds) {
    if (!Array.isArray(mapIds) || !mapIds.length || mapIds.length > 30 || new Set(mapIds).size !== mapIds.length || mapIds.some((id) => typeof id !== 'string' || !/^map-[a-zA-Z0-9_-]+$/.test(id))) throw reconstructionError('중복 없이 원본 문서를 1~30개 지정하세요.')
    const maps = await Promise.all(mapIds.map(readMap))
    if (maps.some((map) => !map || map.trashedAt)) throw reconstructionError('원본 문서를 찾을 수 없습니다.', 404)
    return { guide: documentReconstructionGuide, groupBaselines: await groupContext(mapIds), sources: await Promise.all(maps.map(async (map) => ({ mapId: map.id, title: map.title, version: map.version, sha256: reconstructionSourceHash(map), commentsSha256: hash(await readComments(map.id)), lifecycleVersion: metadata(map.id).lifecycleVersion ?? 0, archivedAt: map.archivedAt ?? null }))), stats: statusStats(maps),
      cards: maps.flatMap((map) => map.nodes.map((node) => ({ mapId: map.id, cardId: node.id, label: node.data.label, kind: node.data.kind, isWork: node.data.isWork, status: node.data.status, progress: node.data.progress, waitingItems: node.data.waitingItems ?? [], checklist: node.data.checklist ?? [], reference: node.data.reference ?? null }))) }
  }
  async function choices({ groupId, mapId } = {}) {
    let documents = await listMaps()
    if (groupId) {
      const layout = await readLayout(documents.map((map) => map.id))
      const group = layout.groups.find((group) => group.id === groupId)
      if (!group) throw reconstructionError('그룹을 찾을 수 없습니다.', 404)
      documents = documents.filter((map) => group.mapIds.includes(map.id))
    } else if (mapId) {
      documents = documents.filter((map) => map.id === mapId)
      if (!documents.length) throw reconstructionError('활성 문서를 찾을 수 없습니다.', 404)
    }
    const groups = documents.length ? await groupContext(documents.map((map) => map.id)) : []
    return { baseline: groups.length === 1 ? groups[0].project?.sourceVersion ?? '' : '', documents: documents.map((map) => ({
      id: map.id, title: map.title, nodeCount: map.nodeCount,
      excluded: groups.some((group) => group.project?.coordinatorMapId === map.id),
    })) }
  }
  async function archive(mapId, body, user) {
    return exclusive(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw reconstructionError('보관 요청 정보가 필요합니다.')
      const map = await readMap(mapId)
      if (!map || map.trashedAt) throw reconstructionError('문서를 찾을 수 없습니다.', 404)
      if (body.baseVersion !== map.version) throw reconstructionError('문서 버전이 변경되었습니다.', 409)
      if (body.baseLifecycleVersion !== (metadata(mapId).lifecycleVersion ?? 0)) throw reconstructionError('보관 상태가 변경되었습니다. 다시 조회하세요.', 409)
      if (metadata(mapId).reconstructionPending) throw reconstructionError('전환 준비 문서는 개별 변경할 수 없습니다.', 409)
      if (body.archived !== true && body.archived !== false) throw reconstructionError('보관 또는 복원을 선택하세요.')
      lockedIds.add(mapId)
      try {
      if (body.archived) { await checkIdle([mapId]); await checkGroup([mapId]) }
      const layout = await readLayout((await listMaps()).map((m) => m.id))
      const next = structuredClone(state)
      const history = [...(metadata(mapId).archiveHistory ?? []), { archived: body.archived, at: new Date().toISOString(), by: user, reason: String(body.reason ?? '') }]
      next.documents[mapId] = { ...metadata(mapId), archivedAt: body.archived ? new Date().toISOString() : null,
        lifecycleVersion: (metadata(mapId).lifecycleVersion ?? 0) + 1,
        archiveHistory: history,
        archivedBy: body.archived ? user : null, archiveReason: body.archived ? String(body.reason ?? '문서 보관') : '',
        originGroupId: metadata(mapId).originGroupId ?? layout.groups.find((g) => g.mapIds.includes(mapId))?.id ?? null }
      await persist(next)
      return readMap(mapId)
      } finally { lockedIds.delete(mapId) }
    })
  }
  async function apply(plan, user, suppliedPreviewHash) {
    return exclusive(async () => {
      if (!nonempty(plan?.approval?.statement) || !nonempty(plan.approval.source)) throw reconstructionError('실제 사용자 승인 발언과 확인 가능한 대화 출처가 필요합니다.')
      if (get(plan.id)?.state === 'applied') {
        if (get(plan.id).planHash !== createHash('sha256').update(JSON.stringify(plan)).digest('hex')) throw reconstructionError('같은 전환 ID의 내용이 다릅니다.', 409)
        return publicRecord(get(plan.id))
      }
      if (get(plan.id)) throw reconstructionError('이미 사용한 전환 ID입니다. 기록을 확인하고 새 전환 ID를 사용하세요.', 409)
      const preview = await inspect(plan)
      if (suppliedPreviewHash !== preview.previewHash) throw reconstructionError('현재 전환안의 미리보기를 먼저 확인하세요. 서버 재시작 뒤에는 다시 검증하세요.', 409, 'RECONSTRUCTION_PREVIEW_REQUIRED')
      if (preview.layoutPhase !== 'verified') throw reconstructionError('실제 마인드맵 미리보기에서 카드 크기·배지·겹침 검증을 완료한 뒤 적용하세요.', 409, 'RECONSTRUCTION_LAYOUT_REVIEW_REQUIRED')
      const locked = plan.sources.map((s) => s.mapId)
      locked.forEach((id) => lockedIds.add(id))
      try {
      await checkIdle(plan.sources.map((s) => s.mapId))
      const layout = await readLayout((await listMaps()).map((map) => map.id))
      const now = new Date().toISOString()
      const originalMetadata = Object.fromEntries(plan.sources.map((source) => [source.mapId, {
        ...metadata(source.mapId), originGroupId: layout.groups.find((group) => group.mapIds.includes(source.mapId))?.id ?? metadata(source.mapId).originGroupId ?? null,
      }]))
      const record = { id: plan.id, state: 'preparing', mode: plan.mode, baseline: plan.baseline, reason: plan.reason,
        newSource: plan.newSource ?? '', changeSummary: plan.changeSummary ?? '', approval: plan.approval,
        groupBaselines: plan.groupBaselines ?? [],
        impactValidation: preview.impactValidation,
        createdAt: now, createdBy: user, sources: plan.sources, targetMapIds: preview.targets.map((target) => target.map.id),
        targets: preview.targets.map(({ key, map }) => ({ key, mapId: map.id, title: map.title })),
        targetLayouts: preview.targets.map(({ key, map, layout }) => ({ key, mapId: map.id, layout })), layoutVerification: preview.layoutVerification,
        before: preview.before, after: preview.after, dispositionCounts: preview.dispositionCounts,
        decisions: plan.decisions, originalMetadata, planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex') }
      const staged = structuredClone(state)
      for (const target of preview.targets) staged.documents[target.map.id] = { reconstructionPending: plan.id }
      staged.operations[plan.id] = record
      await persist(staged)
      try {
        const created = []
        for (const target of preview.targets) created.push(await saveMap(target.map.id, target.map, user, target.map.title, target.map.color, 'reconstruction-created'))
        for (const target of preview.targets) {
          const saved = created.find((map) => map.id === target.map.id)
          if (!saved || JSON.stringify(saved.nodes.map((node) => ({ id: node.id, position: node.position }))) !== JSON.stringify(target.map.nodes.map((node) => ({ id: node.id, position: node.position })))) throw reconstructionError('저장된 카드 배치가 승인한 미리보기와 다릅니다.', 409)
        }
        for (const snapshot of preview.referenceSnapshots) {
          const referenced = await readMap(snapshot.mapId)
          if (!referenced || referenced.trashedAt || reconstructionSourceHash(referenced) !== snapshot.sha256) throw reconstructionError('저장 중 참조 원본이 변경되었습니다. 원본을 유지하고 다시 검토하세요.', 409)
        }
        // 저장 중 원본에 변경이 생겼으면 전환하지 않는다. 생성된 문서는 보관 처리한다.
        for (const source of plan.sources) {
          const current = await readMap(source.mapId)
          if (!current || current.trashedAt || reconstructionSourceHash(current) !== source.sha256 || hash(await readComments(source.mapId)) !== source.commentsSha256) throw reconstructionError('저장 중 원본이 변경되었습니다.', 409, 'RECONSTRUCTION_STALE')
        }
        await checkIdle(plan.sources.map((s) => s.mapId))
        const finalImpact = await inspectImpact(plan, await Promise.all(plan.sources.map((source) => readMap(source.mapId))), preview.targets, proposalBaseline(plan))
        if (impactHash(finalImpact.references) !== impactHash(preview.impactValidation.references)) throw reconstructionError('저장 중 양방향 Ref 연결 또는 원본이 변경되었습니다. 다시 검토하세요.', 409, 'RECONSTRUCTION_REFERENCE_STALE')
        const next = structuredClone(state)
        for (const source of plan.sources) {
          const targetKeys = new Set(plan.decisions.filter((d) => d.mapId === source.mapId).flatMap((d) => (d.targets ?? []).map((t) => t.key)))
          const successors = preview.targets.filter((target) => targetKeys.has(target.key)).map((target) => target.map.id)
          next.documents[source.mapId] = { ...metadata(source.mapId), archivedAt: now, archivedBy: user, archiveReason: plan.reason,
            lifecycleVersion: (metadata(source.mapId).lifecycleVersion ?? 0) + 1,
            successorMapIds: successors, reconstructionId: plan.id, originGroupId: layout.groups.find((g) => g.mapIds.includes(source.mapId))?.id ?? null }
        }
        for (const target of preview.targets) {
          const sourceIds = [...new Set(plan.decisions.filter((d) => d.targets?.some((t) => t.key === target.key)).map((d) => d.mapId))]
          const groups = new Set(layout.groups.filter((g) => g.mapIds.some((id) => sourceIds.includes(id))).map((g) => g.id))
          if (groups.size > 1) throw reconstructionError('서로 다른 그룹의 문서를 하나로 합치는 전환은 지원하지 않습니다.')
          const originGroupId = [...groups][0] ?? layout.groups.find((group) => group.mapIds.some((id) => plan.sources.some((source) => source.mapId === id)))?.id ?? null
          next.documents[target.map.id] = { reconstructionId: plan.id, predecessorMapIds: sourceIds, originGroupId }
        }
        next.operations[plan.id] = { ...record, impactValidation: finalImpact, state: 'applied', appliedAt: new Date().toISOString(), targetVersions: await Promise.all(created.map(async (map) => ({ mapId: map.id, version: map.version, sha256: reconstructionSourceHash(map), commentsSha256: hash(await readComments(map.id)) }))) }
        await persist(next)
        return publicRecord(get(plan.id))
      } catch (error) {
        const failed = structuredClone(state)
        for (const id of record.targetMapIds) failed.documents[id] = { archivedAt: new Date().toISOString(), archivedBy: user, archiveReason: '전환 실패로 보관된 생성 문서', reconstructionId: plan.id }
        failed.operations[plan.id] = { ...record, state: 'failed', error: error.message }
        await persist(failed)
        throw error
      }
      } finally { locked.forEach((id) => lockedIds.delete(id)) }
    })
  }
  async function rollback(id, user) {
    return exclusive(async () => {
      const record = get(id)
      if (record?.state !== 'applied') throw reconstructionError('적용된 전환만 되돌릴 수 있습니다.', 409)
      const locked = [...record.sources.map((s) => s.mapId), ...record.targetMapIds]
      locked.forEach((id) => lockedIds.add(id))
      try {
      await checkIdle([...record.sources.map((s) => s.mapId), ...record.targetMapIds])
      await checkGroup(record.targetMapIds)
      for (const target of record.targetVersions) {
        const map = await readMap(target.mapId)
        if (!map || map.version !== target.version || map.trashedAt || map.archivedAt || reconstructionSourceHash(map) !== target.sha256 || hash(await readComments(map.id)) !== target.commentsSha256) throw reconstructionError('후속 문서 또는 댓글이 변경되었습니다. 일괄 되돌리기 전에 변경 내용을 검토하세요.', 409)
      }
      for (const source of record.sources) {
        const map = await readMap(source.mapId)
        if (!map || map.trashedAt || metadata(source.mapId).reconstructionId !== id || !metadata(source.mapId).archivedAt
          || metadata(source.mapId).lifecycleVersion !== source.lifecycleVersion + 1
          || reconstructionSourceHash(map) !== source.sha256 || hash(await readComments(source.mapId)) !== source.commentsSha256) throw reconstructionError('원본 본문·댓글 또는 보관 상태가 변경되었습니다.', 409)
      }
      const next = structuredClone(state)
      for (const source of record.sources) next.documents[source.mapId] = { ...record.originalMetadata[source.mapId], lifecycleVersion: (metadata(source.mapId).lifecycleVersion ?? 0) + 1 }
      for (const target of record.targetMapIds) next.documents[target] = { ...metadata(target), archivedAt: new Date().toISOString(), archivedBy: user, archiveReason: '문서 재구성 되돌리기' }
      next.operations[id] = { ...record, state: 'rolled-back', rolledBackAt: new Date().toISOString(), rolledBackBy: user }
      await persist(next)
      return publicRecord(get(id))
      } finally { locked.forEach((id) => lockedIds.delete(id)) }
    })
  }
  // 프로세스가 준비 중 중단되면 원본은 그대로 활성이고 미완성 후속 문서는 보관한다.
  for (const record of Object.values(state.operations)) {
    if (record.state !== 'preparing') continue
    record.state = 'failed'
    record.error = '서버 재시작으로 중단된 전환입니다. 원본 문서를 유지했습니다.'
    for (const id of record.targetMapIds) state.documents[id] = { archivedAt: new Date().toISOString(), archiveReason: record.error, reconstructionId: record.id }
    await persist(structuredClone(state))
  }
  return { metadata, metadataSnapshot: () => state.documents, isUnavailable, assertWritable, projectLayout, context, choices, preview: inspect, inspectRenderedLayout, apply, archive, rollback,
    list: () => Object.values(state.operations).map(publicRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: (id) => publicRecord(get(id)) }
}
