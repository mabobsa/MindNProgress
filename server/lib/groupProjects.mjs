import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { GROUP_COORDINATOR_INSTRUCTION, GROUP_APPROVAL_INSTRUCTION, DOCUMENT_COORDINATOR_INSTRUCTION } from '../../src/utils/aiApprovalInstructions.mjs'
import { applyGroupWaitingReview, groupWaitingDetails } from './groupWaitingReviews.mjs'

export { GROUP_COORDINATOR_INSTRUCTION, DOCUMENT_COORDINATOR_INSTRUCTION }

export function documentRoot(map) {
  const targets = new Set((map?.edges ?? []).filter((edge) => edge.data?.relation !== 'knowledge').map((edge) => edge.target))
  return map?.nodes.find((node) => node.data?.kind === 'root' && !targets.has(node.id))
    ?? map?.nodes.find((node) => !targets.has(node.id)) ?? null
}

export function groupProjectError(message, status = 400) {
  return Object.assign(new Error(message), { groupProjectError: true, status })
}

// 그룹 설정은 목록 배치와 분리해 보관한다. 이전 클라이언트의 정렬 저장이 설정을 지우지 않는다.
export function createGroupProjects({ dataDirectory, replaceFile, listMaps, readMap, saveMap, readLayout, writeLayout, delegations, publicDelegation, runtimeSnapshot }) {
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
    try { return JSON.parse(await readFile(fileFor(id), 'utf8')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { version: 0, coordinatorMapId: null, source: '', sourceVersion: '', objective: '', instructions: '' }
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
  async function context(id) {
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
    return {
      group, project, coordinator, documents, waitingReviewSupported: true,
      delegations: [...delegations.values()].filter((item) => item.groupId === id).map((item) => ({ ...publicDelegation(item), result: item.childResultSnapshot ?? '' }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      guide: {
        coordinator: GROUP_COORDINATOR_INSTRUCTION,
        documentCoordinator: DOCUMENT_COORDINATOR_INSTRUCTION,
        approval: GROUP_APPROVAL_INSTRUCTION,
        documentDelegation: 'mindnprogress_delegate_ai_work의 mapId는 총괄 문서, targetMapId와 targetCardId는 소속 문서와 루트입니다. sourceRevision과 targetRevision은 두 문서의 최신 버전입니다. 그룹→문서 위임은 분석·조정 전용이며 worker를 점유하지 않습니다.',
        membership: '문서 편입은 실행을 시작하지 않습니다. 실행 중인 그룹 위임의 대상이나 총괄 문서는 그룹 이동·휴지통 이동 전에 위임을 마쳐야 합니다.',
        evidence: '업무 카드 완료 수는 요구사항 구현률이 아닙니다. 소유권 원장과 검증 근거는 총괄 문서 및 추적 카드에서 관리하세요.',
        waiting: 'waitingDetails는 최상위 카드와 하위 업무의 대기 원문·재개 조건입니다. 분류 기록의 valid=false는 기준이나 대기 내용 변경으로 재확인이 필요하다는 뜻입니다. 분류·현재 범위 차단·예정된 외부 대기는 탐색용 표시이며 사용자 실행 승인, 대기 해제 또는 업무 완료가 아닙니다. 분류 기록만으로 실행하거나 기존 대기를 삭제하지 마세요.',
      },
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
      const next = { ...current }
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
      for (const [key, limit] of Object.entries({ source: 4096, sourceVersion: 240, objective: 10000, instructions: 20000 })) {
        if (body[key] === undefined) continue
        if (typeof body[key] !== 'string' || body[key].length > limit) throw groupProjectError(`${key} 값의 형식 또는 길이가 올바르지 않습니다.`)
        next[key] = body[key]
      }
      if (body.coordinatorMapId !== undefined && body.coordinatorMapId !== current.coordinatorMapId) {
        if (hasActive(id)) throw groupProjectError('그룹 위임이 진행 중이므로 총괄 문서를 변경할 수 없습니다.', 409)
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
  const terminalStates = new Set(['completed', 'failed', 'superseded'])
  const active = (item) => !terminalStates.has(item.state)
  const hasActive = (id) => [...delegations.values()].some((item) => item.groupId === id && active(item))
  async function validateLayout(nextLayout) {
    for (const item of delegations.values()) {
      if (!item.groupId || !active(item)) continue
      const group = nextLayout.groups.find((candidate) => candidate.id === item.groupId)
      if (!group || !group.mapIds.includes(item.parentMapId) || !group.mapIds.includes(item.mapId)) {
        throw groupProjectError('이 그룹의 AI 위임이 진행 중입니다. 총괄·대상 문서의 이동이나 그룹 삭제는 위임이 끝난 뒤에 할 수 있습니다.', 409)
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
  return { context, update, find, read, exclusive, validateLayout, authorizeDelegation,
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
    },
    createDocument: (id, body, user) => exclusive(async () => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw groupProjectError('문서 생성 정보가 필요합니다.')
      assertVersion(await read(id), body.baseVersion)
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80 || typeof body.description !== 'string' || body.description.length > 100000) throw groupProjectError('문서 이름과 루트 업무 설명을 올바르게 입력하세요.')
      return addDocument(id, body.title.trim(), body.description, user)
    }),
  }
}
