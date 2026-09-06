import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

export function documentRoot(map) {
  const targets = new Set((map?.edges ?? []).filter((edge) => edge.data?.relation !== 'knowledge').map((edge) => edge.target))
  return map?.nodes.find((node) => node.data?.kind === 'root' && !targets.has(node.id))
    ?? map?.nodes.find((node) => !targets.has(node.id)) ?? null
}

export function groupProjectError(message, status = 400) {
  return Object.assign(new Error(message), { groupProjectError: true, status })
}

export const GROUP_COORDINATOR_INSTRUCTION = `이 문서는 그룹 전체의 기획과 개발을 총괄합니다.
먼저 mindnprogress_get_group_context로 최신 그룹 원본 기준, 소속 문서와 위임 상태를 확인하세요.
기획서 기반 개발에는 mnp-spec-driven-development 스킬을 사용하세요. 원본 전수 분석, 문서 분할, 전역 요구사항 주 소유권 원장, 공통 계약, 실행 순서와 완료 기준을 관리하세요.
기존 문서의 요구사항과 이력을 보존하고 최신 기획과 대조하세요. 분할안이 결과를 크게 바꾸는 경우 실행 전에 사용자에게 제시하세요.
각 문서 루트에 담당 범위, 분석·기존 구현 감사 순서, 필수 정책 Ref, 완료 조건을 기록한 뒤 문서 담당 AI에 분석·조정을 위임하세요. 분석과 소유권이 확정된 범위부터 하위 구현 업무를 위임하게 하세요.
총괄 문서의 공유 지식과 추적 카드에 전역 소유권 및 현재 결정을 기록하고, 문서 간 중복 소유·누락·대기·검증 증거를 확인하세요. 루트와 묶음은 집계 전용으로 두세요.
코드나 Prefab은 직접 수정하지 않으며 실제 구현은 문서의 하위 업무로 위임하세요. 작업공간 배정은 MindNProgress가 수행합니다.
문서별 완료 보고를 합산하는 것만으로 전체 완료를 선언하지 마세요. 최신 원본 전체에서 독립 검수하고 미분류·미검증, 부분 구현, 외부 대기와 재개 조건을 보고하세요.`

export const DOCUMENT_COORDINATOR_INSTRUCTION = `이 작업은 그룹 총괄이 문서 최상위 카드에 맡긴 분석·조정 업무입니다.
담당 원본을 전수 분석하고 이전 버전 차이와 현재 구현을 감사한 뒤, 요구사항 ID·소유권·정책 Ref·완료 조건을 갖춘 하위 카드를 구성하세요. 발견한 문서 경계 충돌은 그룹 총괄에 보고하세요.
코드·Prefab은 직접 수정하지 마세요. 구현은 이 문서의 하위 업무에 mindnprogress_delegate_ai_work로 위임하여 MindNProgress가 작업공간을 배정하게 하세요. 하위 작업의 결과와 검증 증거를 확인하고 문서 결과를 보고하세요.`

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
      }
    })
    const coordinator = documents.find((map) => map.id === project.coordinatorMapId) ?? null
    return {
      group, project, coordinator, documents,
      delegations: [...delegations.values()].filter((item) => item.groupId === id).map((item) => ({ ...publicDelegation(item), result: item.childResultSnapshot ?? '' }))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      guide: {
        coordinator: GROUP_COORDINATOR_INSTRUCTION,
        documentDelegation: 'mindnprogress_delegate_ai_work의 mapId는 총괄 문서, targetMapId와 targetCardId는 소속 문서와 루트입니다. sourceRevision과 targetRevision은 두 문서의 최신 버전입니다. 그룹→문서 위임은 분석·조정 전용이며 worker를 점유하지 않습니다.',
        membership: '문서 편입은 실행을 시작하지 않습니다. 실행 중인 그룹 위임의 대상이나 총괄 문서는 그룹 이동·휴지통 이동 전에 위임을 마쳐야 합니다.',
        evidence: '업무 카드 완료 수는 요구사항 구현률이 아닙니다. 소유권 원장과 검증 근거는 총괄 문서 및 추적 카드에서 관리하세요.',
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
