import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createGroupProjects } from '../server/lib/groupProjects.mjs'

test('그룹 문서 조회는 유효한 총괄 문서에서만 역할 정보를 반환한다', async (t) => {
  const dataDirectory = await mkdtemp(path.join(process.cwd(), '.rb05-group-'))
  t.after(() => rm(dataDirectory, { recursive: true, force: true }))
  const projectDirectory = path.join(dataDirectory, '_group-projects')
  await mkdir(projectDirectory)
  const projectPath = path.join(projectDirectory, 'group-one.json')
  const group = { id: 'group-one', name: '검증 그룹', mapIds: ['map-coordinator', 'map-member'] }
  let coordinator = { id: 'map-coordinator', nodes: [{ id: 'root', data: { kind: 'root' } }], edges: [] }
  const service = createGroupProjects({
    dataDirectory,
    replaceFile: async () => {},
    listMaps: async () => [{ id: 'map-coordinator' }, { id: 'map-member' }],
    readMap: async (id) => id === 'map-coordinator' ? coordinator : { id },
    saveMap: async () => {},
    readLayout: async () => ({ groups: [group] }),
    writeLayout: async () => {},
    delegations: new Map(),
    publicDelegation: (item) => item,
    runtimeSnapshot: () => ({}),
  })
  const saveProject = (coordinatorMapId) => writeFile(projectPath, JSON.stringify({ version: 1, coordinatorMapId, sources: [] }))

  await saveProject('map-coordinator')
  assert.equal((await service.forDocument('map-member'))?.coordinatorMapId, 'map-coordinator')
  assert.equal(await service.forDocument('map-outside'), null)
  await saveProject('map-outside')
  assert.equal(await service.forDocument('map-member'), null)
  await saveProject('map-coordinator')
  coordinator = null
  assert.equal(await service.forDocument('map-member'), null)
  coordinator = { id: 'map-coordinator', trashedAt: '2026-10-01T00:00:00.000Z', nodes: [{ id: 'root', data: { kind: 'root' } }], edges: [] }
  assert.equal(await service.forDocument('map-member'), null)
  coordinator = { id: 'map-coordinator', nodes: [], edges: [] }
  assert.equal(await service.forDocument('map-member'), null)
})
