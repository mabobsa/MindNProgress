import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { AI_EXECUTION_APPROVAL_INSTRUCTION, GROUP_COORDINATOR_INSTRUCTION, GROUP_APPROVAL_INSTRUCTION, DOCUMENT_COORDINATOR_INSTRUCTION } from '../../src/utils/aiApprovalInstructions.mjs'
import { applyGroupWaitingReview, groupWaitingDetails } from './groupWaitingReviews.mjs'
import { GROUP_PLANNING_SOURCE_LIMIT, groupPlanningSources, withGroupPlanningSources } from '../../src/utils/groupPlanningSources.mjs'

export { GROUP_COORDINATOR_INSTRUCTION, DOCUMENT_COORDINATOR_INSTRUCTION }

export function documentRoot(map) {
  const targets = new Set((map?.edges ?? []).filter((edge) => edge.data?.relation !== 'knowledge').map((edge) => edge.target))
  return map?.nodes.find((node) => node.data?.kind === 'root' && !targets.has(node.id))
    ?? map?.nodes.find((node) => !targets.has(node.id)) ?? null
}

export function groupProjectError(message, status = 400) {
  return Object.assign(new Error(message), { groupProjectError: true, status })
}

function validateSources(value) {
  if (!Array.isArray(value) || value.length > GROUP_PLANNING_SOURCE_LIMIT) throw groupProjectError(`기획서는 최대 ${GROUP_PLANNING_SOURCE_LIMIT}개까지 등록할 수 있습니다.`)
  const ids = new Set()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || Object.keys(item).some((key) => !['id', 'title', 'source', 'sourceVersion'].includes(key))
      || Object.entries({ title: 120, source: 4096, sourceVersion: 240 }).some(([key, limit]) => typeof item[key] !== 'string' || item[key].length > limit)
      || ![item.title, item.source, item.sourceVersion].some((text) => text.trim())) {
      throw groupProjectError(`기획서 ${index + 1}의 이름·주소·버전 또는 고유 ID를 확인해 주세요. 빈 항목이나 중복 ID는 저장할 수 없습니다.`)
    }
    ids.add(item.id)
    return { id: item.id, title: item.title, source: item.source, sourceVersion: item.sourceVersion }
  })
}

// 그룹 설정은 목록 배치와 분리해 보관한다. 이전 클라이언트의 정렬 저장이 설정을 지우지 않는다.
export function createGroupProjects({ dataDirectory, replaceFile, listMaps, readMap, saveMap, readLayout, writeLayout, delegations, publicDelegation, documentInstructions = new Map(), publicDocumentInstruction = (item) => item, runtimeSnapshot }) {
  const directory = path.join(dataDirectory, '_group-projects')
  let queue = Promise.resolve()
  const exclusive = (action) => {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }
  const validId = (id) => typeof id === 'string' && /^group-[a-zA-Z0-9_-]{1,100}$/.test(id)
  const fileFor = (id) => {
    if (!validId(id)) throw groupProjectError('올바르지 않은 그룹 ID입니다.')
    return path.join(directory, `${id}.json`)
  }
  async function read(id) {
    try {
      const project = JSON.parse(await readFile(fileFor(id), 'utf8'))
      return withGroupPlanningSources(project, groupPlanningSources(project))
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { version: 0, coordinatorMapId: null, sources: [], source: '', sourceVersion: '', objective: '', instructions: '' }
    }
  }
  async function write(id, value) {
    await mkdir(directory, { recursive: true })
    const target = fileFor(id)
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await replaceFile(temporary, target)
  }
  async function find(id) {
    fileFor(id)
    const maps = await listMaps()
    const layout = await readLayout(maps.map((map) => map.id))
    const group = layout.groups.find((candidate) => candidate.id === id)
    if (!group) throw groupProjectError('그룹을 찾을 수 없습니다.', 404)
    return { group, layout }
  }
  async function context(id, roleMapId = '') {
    const { group } = await find(id)
    const project = await read(id)
    const documents = (await Promise.all(group.mapIds.map(readMap))).filter((map) => map && !map.trashedAt).map((map) => {
      const root = documentRoot(map)
      const work = map.nodes.filter((node) => node.data?.isWork && node.id !== root?.id)
      return {
        id: map.id, title: map.title, version: map.version,
        root: root ? { id: root.id, data: root.data } : null,
        runtime: root ? runtimeSnapshot(map.id).find((item) => item.nodeId === root.id)?.runtime ?? null : null,
        work: { total: work.length, done: work.filter((node) => node.data.status === 'done').length, waiting: work.filter((node) => node.data.waitingItems?.length).length },
        waitingDetails: groupWaitingDetails(map, root, project),
      }
    })
    const coordinator = documents.find((map) => map.id === project.coordinatorMapId) ?? null
    const commonGuide = {
      sources: 'project.sources의 모든 기획서 주소·개별 버전을 확인하고, 변경된 담당 범위는 총괄에 보고합니다.',
      documentInstruction: '그룹 총괄은 승인된 문서별 범위를 문서 루트 AI에 전달하고, 문서 담당은 자기 문서의 실제 하위 업무에 구현을 위임합니다. 전달 상태는 업무 완료가 아닙니다.',
      membership: '문서 편입은 실행 승인이 아니며 진행 중 지시·위임의 문서는 이동 전에 해당 처리를 마쳐야 합니다.',
      evidence: '카드 완료 수만으로 요구사항 구현률을 판정하지 말고 소유권과 실제 검증 근거를 확인합니다.',
      waiting: 'waitingDetails는 탐색 정보이며 승인·대기 해제·완료 근거가 아닙니다.',
    }
    const role = roleMapId
      ? roleMapId === project.coordinatorMapId ? 'group-coordinator'
        : documents.some((document) => document.id === roleMapId) ? 'document-coordinator' : 'unbound'
      : 'all'
    const guide = role === 'group-coordinator' ? {
      role,
      executionApproval: AI_EXECUTION_APPROVAL_INSTRUCTION,
      coordinator: GROUP_COORDINATOR_INSTRUCTION,
      approval: GROUP_APPROVAL_INSTRUCTION,
      ...commonGuide,
    } : role === 'document-coordinator' ? {
      role,
      documentCoordinator: DOCUMENT_COORDINATOR_INSTRUCTION,
      ...commonGuide,
    } : role === 'unbound' ? { role, ...commonGuide } : {
      role,
      instructionScope: 'executionApproval·approval·coordinator는 그룹 총괄 전용, documentCoordinator는 문서 담당 전용입니다.',
      executionApproval: AI_EXECUTION_APPROVAL_INSTRUCTION,
      coordinator: GROUP_COORDINATOR_INSTRUCTION,
      documentCoordinator: DOCUMENT_COORDINATOR_INSTRUCTION,
      approval: GROUP_APPROVAL_INSTRUCTION,
      ...commonGuide,
    }
    return {
      group, project, coordinator, documents, waitingReviewSupported: true, sourcesSupported: true,
      delegations: [...delegations.values()].filter((item) => item.groupId === id).map((item) => ({ ...publicDelegation(item), result: item.childResultSnapshot ?? '' }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      documentInstructions: [...documentInstructions.values()].filter((item) => item.groupId === id)
        .map((item) => publicDocumentInstruction(item, { includeContent: true }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      guide,
    }
  }
  function assertVersion(current, version) {
    if (!Number.isInteger(version) || current.version !== version) throw groupProjectError('그룹 설정이 변경되었습니다. 새로고침 후 변경 내용을 확인해 주세요.', 409)
  }
  function rootMap(title, description) {
    return { nodes: [{ id: `root-${randomBytes(8).toString('hex')}`, type: 'mind', position: { x: 0, y: 0 }, data: { label: title, description, kind: 'root', isWork: false, status: 'planned', progress: 0 } }], edges: [] }
  }
  async function addDocument(id, title, description, user) {
    const { group, layout } = await find(id)
    const mapId = `map-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const map = await saveMap(mapId, rootMap(title, description), user, title)
    group.mapIds.push(map.id)
    await writeLayout(layout)
    return map
  }
  async function update(id, body, user) {
    return exclusive(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw groupProjectError('그룹 설정 객체가 필요합니다.')
      const { group } = await find(id)
      const current = await read(id)
      assertVersion(current, body.baseVersion)
      let next = { ...current }
      if (body.waitingReview !== undefined) {
        // 기준 변경과 대기 분류를 한 요청에서 섞어 미확인 기준을 승인하지 않는다.
        if (Object.keys(body).some((key) => !['baseVersion', 'baseWaitingReviewVersion', 'waitingReview'].includes(key))) throw groupProjectError('대기 분류는 기획 기준 저장과 별도로 요청해 주세요.')
        if (!Number.isInteger(body.baseWaitingReviewVersion) || body.baseWaitingReviewVersion !== (current.waitingReviewVersion ?? 0)) throw groupProjectError('대기 분류가 변경되었습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.', 409)
        const mapId = body.waitingReview?.mapId
        if (!group.mapIds.includes(mapId)) throw groupProjectError('현재 그룹 소속 문서만 분류할 수 있습니다.', 409)
        const map = await readMap(mapId)
        next.waitingReviews = applyGroupWaitingReview(current, map, map ? documentRoot(map) : null, body.waitingReview, user)
        // 탐색용 분류는 위임 승인 기준(groupProjectVersion)을 바꾸지 않는다.
        next.waitingReviewVersion = (current.waitingReviewVersion ?? 0) + 1
        await write(id, next)
        return context(id)
      }
      if (body.sources !== undefined && (body.source !== undefined || body.sourceVersion !== undefined)) throw groupProjectError('기획서 목록과 구버전 단일 원본 필드는 함께 저장할 수 없습니다. sources만 전달해 주세요.')
      if (body.sources !== undefined) next = withGroupPlanningSources(next, validateSources(body.sources))
      for (const [key, limit] of Object.entries({ source: 4096, sourceVersion: 240, objective: 10000, instructions: 20000 })) {
        if (body[key] === undefined) continue
        if (typeof body[key] !== 'string' || body[key].length > limit) throw groupProjectError(`${key} 값의 형식 또는 길이가 올바르지 않습니다.`)
        next[key] = body[key]
      }
      if (body.source !== undefined || body.sourceVersion !== undefined) {
        const sources = groupPlanningSources(current)
        const first = { ...(sources[0] ?? { id: 'source-legacy', title: '' }), source: next.source, sourceVersion: next.sourceVersion }
        // 이전 클라이언트의 단일 필드 저장으로 추가 기획서를 유실하지 않는다.
        next = withGroupPlanningSources(next, [...(first.title || first.source || first.sourceVersion ? [first] : []), ...sources.slice(1)])
      }
      if (body.coordinatorMapId !== undefined && body.coordinatorMapId !== current.coordinatorMapId) {
        if (hasActive(id) || hasPendingDocumentInstruction(id)) throw groupProjectError('그룹 위임이 진행 중이거나 문서 지시가 전달 대기 중이므로 총괄 문서를 변경할 수 없습니다.', 409)
        if (typeof body.coordinatorMapId !== 'string' || !group.mapIds.includes(body.coordinatorMapId)) throw groupProjectError('총괄 문서는 그룹에 속한 문서여야 합니다.')
        const coordinator = await readMap(body.coordinatorMapId)
        if (!documentRoot(coordinator) || coordinator.trashedAt || documentRoot(coordinator).data.reference) throw groupProjectError('유효한 원본 루트가 있는 문서를 선택하세요.')
        next.coordinatorMapId = coordinator.id
      }
      if (body.createCoordinator === true && (!next.coordinatorMapId || !group.mapIds.includes(next.coordinatorMapId))) {
        const map = await addDocument(id, `${group.name} · 통합 관리`, GROUP_COORDINATOR_INSTRUCTION, user)
        next.coordinatorMapId = map.id
      }
      next.version += 1
      next.updatedAt = new Date().toISOString()
      next.updatedBy = { id: user.id, name: user.name }
      await write(id, next)
      return context(id)
    })
  }
  const terminalStates = new Set(['completed', 'failed', 'superseded', 'closed'])
  const active = (item) => !terminalStates.has(item.state)
  const hasActive = (id) => [...delegations.values()].some((item) => item.groupId === id && active(item))
  const pendingDocumentInstruction = (item) => item.state === 'queued'
  const hasPendingDocumentInstruction = (id) => [...documentInstructions.values()]
    .some((item) => item.groupId === id && pendingDocumentInstruction(item))
  async function validateLayout(nextLayout) {
    for (const item of delegations.values()) {
      if (!item.groupId || !active(item)) continue
      const group = nextLayout.groups.find((candidate) => candidate.id === item.groupId)
      if (!group || !group.mapIds.includes(item.parentMapId) || !group.mapIds.includes(item.mapId)) {
        throw groupProjectError('이 그룹의 AI 위임이 진행 중입니다. 총괄·대상 문서의 이동이나 그룹 삭제는 위임이 끝난 뒤에 할 수 있습니다.', 409)
      }
    }
    for (const item of documentInstructions.values()) {
      if (!item.groupId || !pendingDocumentInstruction(item)) continue
      const group = nextLayout.groups.find((candidate) => candidate.id === item.groupId)
      if (!group || !group.mapIds.includes(item.parentMapId) || !group.mapIds.includes(item.targetMapId)) {
        throw groupProjectError('이 그룹의 문서 지시가 전달 대기 중입니다. 총괄·대상 문서의 이동이나 그룹 삭제는 전문 전달 뒤에 할 수 있습니다.', 409)
      }
    }
  }
  async function authorizeDelegation(parentMap, parentCardId, targetMap, targetCardId) {
    if (documentRoot(parentMap)?.id !== parentCardId || documentRoot(targetMap)?.id !== targetCardId || documentRoot(targetMap)?.data.reference) return null
    const maps = await listMaps()
    const layout = await readLayout(maps.map((map) => map.id))
    const group = layout.groups.find((item) => item.mapIds.includes(parentMap.id) && item.mapIds.includes(targetMap.id))
    if (!group || (await read(group.id)).coordinatorMapId !== parentMap.id) return null
    return group.id
  }
  return { context, update, find, read, exclusive, validateLayout, authorizeDelegation, authorizeDocumentInstruction: authorizeDelegation,
    async forDocument(mapId) {
      const maps = await listMaps()
      const layout = await readLayout(maps.map((map) => map.id))
      const group = layout.groups.find((item) => item.mapIds.includes(mapId))
      if (!group) return null
      const project = await read(group.id)
      return project.coordinatorMapId ? { groupId: group.id, name: group.name, coordinatorMapId: project.coordinatorMapId, role: project.coordinatorMapId === mapId ? 'coordinator' : 'document', contextTool: 'mindnprogress_get_group_context' } : null
    },
    assertCanTrash(mapId) {
      if ([...delegations.values()].some((item) => item.groupId && active(item) && [item.parentMapId, item.mapId].includes(mapId))) throw groupProjectError('그룹 AI 위임이 진행 중인 문서는 휴지통으로 이동할 수 없습니다.', 409)
      if ([...documentInstructions.values()].some((item) => item.groupId && pendingDocumentInstruction(item) && [item.parentMapId, item.targetMapId].includes(mapId))) throw groupProjectError('그룹 문서 지시가 전달 대기 중인 문서는 휴지통으로 이동할 수 없습니다.', 409)
    },
    createDocument: (id, body, user) => exclusive(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw groupProjectError('문서 생성 정보가 필요합니다.')
      assertVersion(await read(id), body.baseVersion)
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80 || typeof body.description !== 'string' || body.description.length > 100000) throw groupProjectError('문서 이름과 루트 업무 설명을 올바르게 입력하세요.')
      return addDocument(id, body.title.trim(), body.description, user)
    }),
  }
}
