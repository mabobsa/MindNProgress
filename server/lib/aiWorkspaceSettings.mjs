import { createHash, randomBytes } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, stat, access } from 'node:fs/promises'
import path from 'node:path'
import { sameExecutionWorkspace } from './doorayExecutionWorkspace.mjs'

const fail = (message, status = 400) => Object.assign(new Error(message), { status, workspaceSettingsError: true })
const key = (scope, id, machineId) => JSON.stringify([scope, id, machineId])
const empty = () => ({ version: 0, workspace: '', binding: null })

export function workspacePath(value) {
  if (typeof value !== 'string') throw fail('작업공간 경로를 입력해 주세요.')
  const result = value.trim()
  if (!result || result.length > 1000 || [...result].some((character) => character.charCodeAt(0) < 32)
    || (!path.isAbsolute(result) && !path.win32.isAbsolute(result))
    || /(^|[\\/])_dooray-response-workspaces([\\/]|$)/i.test(result)) throw fail('제안 보관 폴더가 아닌 실제 작업공간의 절대 경로를 선택해 주세요.')
  return result
}

// 문서 본문·그룹 목록 저장과 분리한다. 각 대상·머신의 버전으로 동시 편집을 검사한다.
export async function createAiWorkspaceSettings({ dataDirectory, readMap, readGroups, registry, isMainMachine, candidates,
  checkDirectory = async (workspace) => { if (!(await stat(workspace)).isDirectory()) throw Error('폴더가 아닙니다.'); await access(workspace) },
  replaceFile = rename,
}) {
  const file = path.join(dataDirectory, '_ai-workspace-settings.json')
  let records = {}
  try { records = JSON.parse(await readFile(file, 'utf8')).records ?? {} } catch (error) { if (error.code !== 'ENOENT') throw error }
  let queue = Promise.resolve()
  const exclusive = (action) => { const result = queue.then(action); queue = result.catch(() => {}); return result }
  const record = (scope, id, machine) => records[key(scope, id, machine)] ?? empty()
  const pool = (machine) => isMainMachine(machine) ? registry() : null
  function normalize(value, machine) {
    const workspace = workspacePath(value)
    const current = pool(machine)
    const registered = current?.workspaces?.find((entry) => {
      const paths = /^[a-z]:[\\/]|^\\\\/i.test(entry.root) ? path.win32 : path
      const relative = paths.relative(entry.root, workspace)
      return sameExecutionWorkspace(entry.root, workspace) || (relative && !relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative))
    })
    if (registered) {
      if (!current.integration?.root || current.integration.enabled === false) throw fail('등록된 통합 작업공간을 확인할 수 없습니다.', 409)
      return { workspace: current.integration.root, binding: { poolId: current.poolId } }
    }
    return { workspace, binding: null }
  }
  function resolveRecord(value, machine) {
    if (!value.binding) return value.workspace
    const current = pool(machine)
    if (!current || current.poolId !== value.binding.poolId || !current.integration?.root || current.integration.enabled === false) throw fail('설정된 프로젝트의 통합 작업공간을 확인할 수 없습니다. 설정을 다시 확인해 주세요.', 409)
    return current.integration.root
  }
  async function check(value, machine) {
    const normalized = normalize(value, machine)
    if (isMainMachine(machine)) {
      try { await checkDirectory(normalized.workspace) }
      catch { throw fail('설정된 작업공간 폴더가 없거나 접근할 수 없습니다. 경로를 다시 선택해 주세요.', 409) }
    }
    return normalized
  }
  async function target(mapId, groupId) {
    const groups = await readGroups()
    const map = mapId ? await readMap(mapId) : null
    if (mapId && (!map || map.trashedAt || map.archivedAt)) throw fail('활성 문서를 찾을 수 없습니다.', 404)
    const group = map ? groups.find((g) => g.mapIds.includes(mapId)) : groups.find((g) => g.id === groupId)
    if (groupId && (!group || group.id !== groupId)) throw fail('문서의 그룹 소속이 변경되었습니다. 다시 확인해 주세요.', 409)
    return { map, group }
  }
  async function context({ mapId = '', groupId = '', machineId }) {
    const { map, group } = await target(mapId, groupId)
    const documentSetting = map ? record('document', map.id, machineId) : empty()
    const groupSetting = group ? record('group', group.id, machineId) : empty()
    const selected = documentSetting.workspace ? documentSetting : groupSetting.workspace ? groupSetting : null
    const source = documentSetting.workspace ? 'document' : groupSetting.workspace ? 'group' : 'none'
    let workspace = '', error = ''
    if (selected) {
      try { workspace = resolveRecord(selected, machineId); await check(workspace, machineId) }
      catch (reason) { error = reason.message }
    }
    const choices = []
    if (!selected || error) {
      for (const candidate of await candidates({ map, group, machineId })) {
        try {
          const value = normalize(candidate.workspace, machineId).workspace
          const existing = choices.find((entry) => sameExecutionWorkspace(entry.workspace, value))
          if (existing) { if (!existing.reasons.includes(candidate.reason)) existing.reasons.push(candidate.reason) }
          else choices.push({ workspace: value, reasons: [candidate.reason] })
        } catch { /* 잘못된 과거 경로는 추천하지 않는다. */ }
      }
    }
    const token = createHash('sha256').update(JSON.stringify([mapId, group?.id ?? '', machineId, documentSetting, groupSetting, workspace])).digest('hex')
    return { mapId, groupId: group?.id ?? null, groupName: group?.name ?? '', machineId, documentSetting, groupSetting,
      workspace, source, error, choices, token, needsSelection: !selected || Boolean(error), remotePathUnchecked: !isMainMachine(machineId) }
  }
  return {
    context,
    async save({ scope, id, mapId = '', machineId, workspace, baseVersion }, actor) {
      return exclusive(async () => {
        if (!['document', 'group'].includes(scope) || typeof id !== 'string' || !id) throw fail('작업공간을 설정할 문서 또는 그룹을 선택해 주세요.')
        await target(scope === 'document' ? id : mapId, scope === 'group' ? id : '')
        const previous = record(scope, id, machineId)
        if (!Number.isInteger(baseVersion) || baseVersion !== previous.version) throw fail('다른 편집자가 작업공간 설정을 변경했습니다. 다시 열어 확인해 주세요.', 409)
        const value = typeof workspace === 'string' && !workspace.trim() ? { workspace: '', binding: null } : await check(workspace, machineId)
        const updated = { ...value, version: previous.version + 1, updatedAt: new Date().toISOString(), updatedBy: { id: actor.id, name: actor.name } }
        const next = { ...records, [key(scope, id, machineId)]: updated }
        await mkdir(dataDirectory, { recursive: true })
        const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
        await writeFile(temporary, JSON.stringify({ version: 1, records: next }) + '\n', 'utf8')
        await replaceFile(temporary, file)
        records = next
        return updated
      })
    },
    async validateLaunch({ mapId, machineId, workspace, workspaceToken, workspaceConfirmed }) {
      const current = await context({ mapId, machineId })
      if (workspaceToken && workspaceToken !== current.token) throw fail('문서·그룹의 작업공간 기준이 변경되었습니다. 다시 확인한 뒤 시작해 주세요.', 409)
      if (!workspaceConfirmed && (current.needsSelection || !sameExecutionWorkspace(current.workspace, workspace))) throw fail('작업공간을 확인하고 이번 대화·문서·그룹 중 적용 범위를 선택해 주세요.', 409)
      return (await check(workspace, machineId)).workspace
    },
  }
}
