import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAiWorkspaceSettings, workspacePath } from '../server/lib/aiWorkspaceSettings.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-settings-'))
  t.after(async () => { assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }) })
  const state = { groups: [{ id: 'group-one', name: '그룹', mapIds: ['map-one', 'map-two'] }],
    maps: { 'map-one': { id: 'map-one' }, 'map-two': { id: 'map-two' } },
    hints: [], unavailable: [], registry: { poolId: 'project', integration: { root: 'C:\\project\\main', enabled: true },
      workspaces: [{ root: 'C:\\project\\main' }, { root: 'C:\\project\\worker' }] } }
  const options = { dataDirectory: directory, readMap: async (id) => state.maps[id], readGroups: async () => state.groups,
    registry: () => state.registry, isMainMachine: (id) => id === 'main', candidates: async () => state.hints,
    checkDirectory: async (value) => { if (state.unavailable.includes(value)) throw Error('없는 경로') } }
  const service = await createAiWorkspaceSettings(options)
  const read = (input = {}) => service.context({ mapId: 'map-one', machineId: 'main', ...input })
  const save = (scope, workspace, extra = {}) => service.save({ scope, id: scope === 'document' ? 'map-one' : 'group-one', machineId: 'main', workspace, baseVersion: 0, ...extra }, { id: 'editor', name: '편집자' })
  return { service, state, read, save, options }
}
test('문서 기준이 그룹·혼합 이력보다 우선하고 해제하면 그룹을 상속한다', async (t) => {
  const { read, save, state } = await fixture(t)
  state.hints = [{ workspace: 'C:\\old', reason: '과거 대화' }]
  assert.equal((await read()).workspace, '')
  await save('group', 'C:\\group')
  assert.equal((await read()).source, 'group')
  await save('document', 'C:\\document')
  const configured = await read()
  assert.equal(configured.source, 'document'); assert.equal(configured.workspace, 'C:\\document')
  assert.equal(configured.needsSelection, false); assert.deepEqual(configured.choices, [])
  await save('document', '', { baseVersion: 1 })
  assert.equal((await read()).workspace, 'C:\\group')
})
test('후보가 하나여도 자동 확정하지 않으며 중복 후보와 worker는 정규화한다', async (t) => {
  const { state, read } = await fixture(t)
  state.hints = [{ workspace: 'C:/project/worker', reason: '문서 대화' }, { workspace: 'c:/project/main/', reason: '그룹 대화' }]
  const value = await read()
  assert.equal(value.workspace, ''); assert.equal(value.needsSelection, true); assert.equal(value.choices.length, 1)
  assert.deepEqual(value.choices[0].reasons, ['문서 대화', '그룹 대화'])
  state.hints.push({ workspace: 'C:\\MnP', reason: '과거 대화' })
  assert.equal((await read()).choices.length, 2)
  state.hints.pop(); assert.equal((await read()).choices.length, 1)
})
test('등록 작업공간은 경로 복사 대신 pool을 기억하고 현재 통합 경로를 해석한다', async (t) => {
  const { save, read, state } = await fixture(t)
  const saved = await save('document', 'C:/project/worker/Assets')
  assert.deepEqual(saved.binding, { poolId: 'project' })
  state.registry.integration.root = 'C:\\moved-main'
  assert.equal((await read()).workspace, 'C:\\moved-main')
  state.registry = null
  assert.equal((await read()).needsSelection, true); assert.match((await read()).error, /통합 작업공간/)
})
test('명시한 경로가 없어져도 그룹이나 MnP로 대체하지 않는다', async (t) => {
  const { save, read, state } = await fixture(t)
  await save('group', 'C:\\group'); await save('document', 'C:\\document')
  state.unavailable.push('C:\\document')
  const value = await read()
  assert.equal(value.source, 'document'); assert.equal(value.workspace, 'C:\\document')
  assert.match(value.error, /접근/); assert.equal(value.needsSelection, true)
})
test('머신별 설정·버전 충돌·서버 재시작 보존을 검증한다', async (t) => {
  const { save, read, service, options } = await fixture(t)
  await save('document', 'C:\\main')
  await save('document', '/remote/project', { machineId: 'sub' })
  assert.equal((await read()).workspace, 'C:\\main')
  assert.equal((await read({ machineId: 'sub' })).workspace, '/remote/project')
  await assert.rejects(save('document', 'C:\\stale'), { status: 409 })
  const restarted = await createAiWorkspaceSettings(options)
  assert.equal((await restarted.context({ mapId: 'map-one', machineId: 'main' })).workspace, 'C:\\main')
  await assert.rejects(service.save({ scope: 'group', id: 'group-other', mapId: 'map-one', machineId: 'main', workspace: 'C:\\bad', baseVersion: 0 }, { id: 'editor' }), { status: 409 })
})
test('시작 전 확인·버전·그룹 이동·명시적 일회성 예외를 검증한다', async (t) => {
  const { service, save, read, state } = await fixture(t)
  const args = { mapId: 'map-one', machineId: 'main', workspace: 'C:\\chosen' }
  await assert.rejects(service.validateLaunch(args), /확인하고/)
  assert.equal(await service.validateLaunch({ ...args, workspaceConfirmed: true }), 'C:\\chosen')
  await save('group', 'C:\\chosen')
  const current = await read()
  assert.equal(await service.validateLaunch({ ...args, workspaceToken: current.token }), args.workspace)
  await save('group', 'C:\\changed', { baseVersion: 1 })
  await assert.rejects(service.validateLaunch({ ...args, workspaceToken: current.token, workspaceConfirmed: true }), /변경/)
  const updated = await read()
  state.groups = []
  await assert.rejects(service.validateLaunch({ ...args, workspaceToken: updated.token, workspaceConfirmed: true }), /변경/)
  state.maps['map-one'].archivedAt = '2026-09-13'
  await assert.rejects(read(), { status: 404 })
})
test('상대 경로·제안 폴더·빈 값은 실행 경로로 허용하지 않는다', () => {
  for (const value of ['', 'relative', 'C:\\x\\_dooray-response-workspaces\\user', 'C:\\bad\npath']) assert.throws(() => workspacePath(value))
  assert.equal(workspacePath(' C:\\project '), 'C:\\project')
})
