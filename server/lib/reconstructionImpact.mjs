import { createHash } from 'node:crypto'
import { groupPlanningSources, withGroupPlanningSources } from '../../src/utils/groupPlanningSources.mjs'

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
export const impactHash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const proposalHash = ({ approval: _approval, ...plan }) => impactHash(plan)
const membership = (groups, id) => groups.find((group) => group.mapIds.includes(id))?.groupId ?? null
const sorted = (values) => [...new Set(values)].sort()
// 저장 형식의 단일 원본→목록 호환만 정규화한다. 버전·전체 기준·총괄 정보는 계속 비교한다.
const criteriaHash = (criteria) => impactHash(criteria.project ? { ...criteria, project: withGroupPlanningSources(criteria.project, groupPlanningSources(criteria.project)) } : criteria)
const fail = (message, code = 'RECONSTRUCTION_GROUP_STALE') => {
  throw Object.assign(new Error(message), { status: 409, code, reconstructionError: true })
}

// 전환 이력으로 설명되는 무관한 문서 교체만 완화한다. 원본 계획은 수정하지 않는다.
export async function inspectReconstructionImpact({ plan, sources, targets, groups, library, readMap, readComments,
  readLayout, metadata, operations, baseline, sourceHash }) {
  const previous = plan.groupBaselines ?? []
  const sourceIds = sources.map((map) => map.id)
  if (!Array.isArray(previous) || previous.some((group) => !group || !Array.isArray(group.mapIds))
    || new Set(previous.map((group) => group.groupId)).size !== previous.length
    || impactHash(sorted(previous.map((group) => group.groupId))) !== impactHash(sorted(groups.map((group) => group.groupId)))) {
    fail('그룹 기준이 누락되었거나 정리 대상의 그룹이 변경되었습니다. 그룹 기준을 다시 조회하세요.')
  }
  const changes = new Set()
  for (const current of groups) {
    const before = previous.find((group) => group.groupId === current.groupId)
    const { mapIds: oldIds, ...oldCriteria } = before
    const { mapIds: newIds, ...newCriteria } = current
    if (criteriaHash(oldCriteria) !== criteriaHash(newCriteria)) fail(`그룹 기획 기준·전체 방향·총괄 정보가 변경되었습니다: ${current.name}. 기준을 다시 검토하세요.`)
    for (const id of [...oldIds, ...newIds]) if (oldIds.includes(id) !== newIds.includes(id)) changes.add(id)
  }
  for (const id of sourceIds) {
    if (membership(previous, id) !== membership(groups, id)) fail(`정리 대상의 그룹 소속이 변경되었습니다: ${sources.find((map) => map.id === id)?.title ?? id}`)
  }
  // 단순 추가·이동·삭제를 전환으로 오인하지 않고, 여러 번 이어진 전환도 원본까지 추적한다.
  const transitionIds = new Set()
  const relatedChanges = new Set(changes)
  let expanded = true
  while (expanded) {
    expanded = false
    for (const operation of operations) {
      if (operation.state !== 'applied' || transitionIds.has(operation.id)) continue
      const ids = [...operation.sources.map((source) => source.mapId), ...operation.targetMapIds]
      if (!ids.some((id) => relatedChanges.has(id))) continue
      transitionIds.add(operation.id)
      for (const id of ids) if (!relatedChanges.has(id)) { relatedChanges.add(id); expanded = true }
    }
  }
  const transitions = operations.filter((operation) => transitionIds.has(operation.id))
  for (const id of changes) {
    if (!transitions.some((operation) => operation.sources.some((source) => source.mapId === id) || operation.targetMapIds.includes(id))) {
      fail(`그룹 소속 문서의 추가·이동·삭제가 확인되었습니다: ${id}. 다른 문서의 전환으로 확인되지 않아 재검토가 필요합니다.`)
    }
  }
  for (const current of groups) {
    const before = previous.find((group) => group.groupId === current.groupId)
    const expand = (id, visiting = new Set()) => {
      if (current.mapIds.includes(id)) return [id]
      if (visiting.has(id)) fail('문서 전환 이력에 순환이 있어 그룹 소속을 확인할 수 없습니다.')
      const operation = transitions.find((item) => item.sources.some((source) => source.mapId === id))
      if (!operation) fail(`전환 이력으로 그룹 소속 변경을 확인하지 못했습니다: ${id}`)
      return operation.targetMapIds.flatMap((next) => expand(next, new Set([...visiting, id])))
    }
    if (impactHash(sorted(before.mapIds.flatMap((id) => expand(id)))) !== impactHash(sorted(current.mapIds))) {
      fail(`그룹 소속 변경이 다른 문서의 전환 결과와 일치하지 않습니다: ${current.name}`)
    }
  }
  const localIds = new Set([...sourceIds, ...targets.map(({ map }) => map.id)])
  const maps = new Map(sources.map((map) => [map.id, map]))
  // 그룹 밖과 보관 원본의 역방향 Ref도 조사한다. 일부 문서 조회 실패를 무관함으로 판정하지 않는다.
  for (const entry of library) {
    if (localIds.has(entry.id)) continue
    const map = await readMap(entry.id)
    if (!map || !Array.isArray(map.nodes)) fail(`Ref 영향 검사에 필요한 문서를 읽지 못했습니다: ${entry.title ?? entry.id}`, 'RECONSTRUCTION_REFERENCE_UNVERIFIED')
    maps.set(map.id, map)
  }
  for (const id of relatedChanges) {
    if (!maps.has(id)) fail(`변경된 문서의 원본을 찾지 못해 Ref 영향을 확인할 수 없습니다: ${id}`, 'RECONSTRUCTION_REFERENCE_UNVERIFIED')
  }
  const links = []
  const dependencies = new Set()
  const addLink = (map, node, direction) => {
    const reference = node.data.reference
    const dependencyId = direction === 'outgoing' ? reference.mapId : map.id
    const remote = maps.get(dependencyId)
    if (!remote) fail(`Ref 원본 문서를 찾을 수 없습니다: ${map.title} / ${node.data.label}`, 'RECONSTRUCTION_REFERENCE_UNVERIFIED')
    const link = { direction, mapId: map.id, cardId: node.id, mapTitle: map.title, cardTitle: node.data.label,
      targetMapId: reference.mapId, targetCardId: reference.nodeId, dependencyId, dependencyTitle: remote.title }
    links.push(link); dependencies.add(dependencyId)
    if (relatedChanges.has(dependencyId)) fail(`Ref 영향 재검토가 필요합니다: ${map.title} / ${node.data.label} → ${reference.mapId} / ${reference.nodeId}. 연결된 문서 “${remote.title}”이 전환되었습니다. 참조를 확인한 뒤 정리안을 다시 제출하세요.`, 'RECONSTRUCTION_REFERENCE_STALE')
  }
  for (const map of [...sources, ...targets.map((target) => target.map)]) {
    for (const node of map.nodes) if (node.data.reference && !localIds.has(node.data.reference.mapId)) addLink(map, node, 'outgoing')
  }
  for (const map of maps.values()) {
    if (localIds.has(map.id) || map.trashedAt) continue
    for (const node of map.nodes) if (node.data.reference && localIds.has(node.data.reference.mapId)) addLink(map, node, 'incoming')
  }
  links.sort((a, b) => impactHash(a).localeCompare(impactHash(b)))
  const layout = await readLayout(library.filter((map) => !map.archivedAt && !map.trashedAt && !map.reconstructionPending).map((map) => map.id))
  const documents = []
  for (const id of sorted(dependencies)) {
    const map = maps.get(id); const lifecycle = metadata(id)
    documents.push({ mapId: id, title: map.title, sha256: sourceHash(map), commentsSha256: impactHash(await readComments(id)),
      lifecycleVersion: lifecycle.lifecycleVersion ?? map.lifecycleVersion ?? 0, archivedAt: lifecycle.archivedAt ?? map.archivedAt ?? null,
      trashedAt: map.trashedAt ?? null, pending: lifecycle.reconstructionPending ?? map.reconstructionPending ?? null,
      groupId: layout?.groups?.find((group) => group.mapIds.includes(id))?.id ?? lifecycle.originGroupId ?? null })
  }
  const references = { documents, links }
  if (baseline?.references && impactHash(baseline.references) !== impactHash(references)) {
    const changed = [...documents, ...baseline.references.documents].find((entry) => impactHash(documents.find((item) => item.mapId === entry.mapId) ?? null) !== impactHash(baseline.references.documents.find((item) => item.mapId === entry.mapId) ?? null))
    const link = [...links, ...baseline.references.links].find((item) => !changed || item.dependencyId === changed.mapId)
    fail(`Ref 연결 또는 원본이 정리안 제출 이후 변경되었습니다: ${link?.mapTitle ?? ''} / ${link?.cardTitle ?? ''} → ${changed?.title ?? link?.dependencyTitle ?? '참조 문서'}. 영향 확인 후 정리안을 다시 제출하세요.`, 'RECONSTRUCTION_REFERENCE_STALE')
  }
  // 구 제안에는 제출 시 Ref 스냅샷이 없다. 확인 가능한 변경 시각으로 우선 차단하고,
  // 현재 양방향 연결을 최초 미리보기 기준으로 묶는다. 기존 제안 JSON에는 덧쓰지 않는다.
  if (baseline?.submittedAt && !baseline.references) {
    const submitted = Date.parse(baseline.submittedAt)
    for (const id of dependencies) {
      const map = maps.get(id); const lifecycle = metadata(id)
      const dates = [map.updatedAt, map.trashedAt, lifecycle.archivedAt, ...(lifecycle.archiveHistory ?? []).map((item) => item.at)]
      if (dates.some((date) => Date.parse(date) > submitted)) fail(`구 정리안 제출 이후 Ref 연결 문서가 변경되었습니다: ${map.title}. 영향 확인 후 정리안을 다시 제출하세요.`, 'RECONSTRUCTION_REFERENCE_STALE')
    }
  }
  return { version: 1, checkedAt: new Date().toISOString(), currentGroups: groups, references,
    allowedTransitions: transitions.map((operation) => ({ id: operation.id, sources: operation.sources.map(({ mapId, title }) => ({ mapId, title })), targets: operation.targets })),
    warnings: transitions.length ? [`다른 문서의 전환 ${transitions.length}건으로 그룹 목록이 달라졌지만, 정리 대상과 양방향 Ref 연결이 없어 기존 정리안을 유지합니다. 변경 문서: ${transitions.flatMap((operation) => operation.sources.map((source) => source.title ?? source.mapId)).join(', ')}`] : [] }
}
