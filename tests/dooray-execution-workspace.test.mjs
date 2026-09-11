import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDoorayExecutionWorkspace, doorayExecutionWorkspace, sameExecutionWorkspace } from '../server/lib/doorayExecutionWorkspace.mjs'
import { aiDelegationNewWorkspace } from '../server/lib/aiDelegations.mjs'

const registry = { integration: { root: 'C:\\registered-project\\client', role: 'integration' }, workspaces: [
  { root: 'C:\\registered-project\\client', role: 'integration' }, { root: 'C:\\registered-worker\\client', role: 'worker' },
] }
test('승인·인계의 기본값은 폴더명 추측 없이 registry 통합 경로를 사용한다', () => {
  assert.equal(doorayExecutionWorkspace(registry, true, ['C:/registered-worker/client']).defaultWorkspace, registry.integration.root)
  assert.equal(doorayExecutionWorkspace(registry, true, ['C:/MnP']).defaultWorkspace, 'C:/MnP')
  assert.equal(doorayExecutionWorkspace(registry, true, ['C:/custom-project']).defaultWorkspace, 'C:/custom-project')
  assert.equal(doorayExecutionWorkspace(registry, true, ['C:/MnP', registry.integration.root]).defaultWorkspace, '')
  assert.equal(doorayExecutionWorkspace(registry, true, [], 'C:/MnP').defaultWorkspace, '')
  assert.deepEqual(doorayExecutionWorkspace(registry, false).workspaceChoices, [], '서브 머신에는 메인 머신 경로를 기본값으로 넣지 않는다')
  assert.deepEqual(doorayExecutionWorkspace(null, true, [], 'C:/MnP').workspaceChoices, ['C:/MnP'])
})
test('MnP를 포함한 사용자 선택은 허용하고 빈 경로·보관 폴더만 실행하지 않는다', () => {
  for (const workspace of ['', 'relative/path', 'C:/data/_dooray-response-workspaces/user']) {
    assert.throws(() => assertDoorayExecutionWorkspace(workspace))
  }
  for (const workspace of ['C:/MnP', 'C:/explicit-project', registry.integration.root]) assertDoorayExecutionWorkspace(workspace)
  assert.equal(sameExecutionWorkspace('', ''), false)
  assert.equal(sameExecutionWorkspace('C:/work/a/../b', 'c:\\work\\b'), true)
  assert.equal(sameExecutionWorkspace('/project/Root', '/project/root'), process.platform === 'win32')
})

test('새 위임은 과거 하위 폴더보다 새 상위 대화에서 선택한 프로젝트를 우선한다', () => {
  assert.equal(aiDelegationNewWorkspace({}, { selection: { workspace: 'C:/Holdem' } }, { workspace: 'C:/MnP' }), 'C:/Holdem')
  assert.equal(aiDelegationNewWorkspace({}, { selection: { workspace: 'C:/MnP' } }, { workspace: 'C:/Holdem' }), 'C:/MnP')
  assert.equal(aiDelegationNewWorkspace({ workspace: 'C:/Changed' }, { workspace: 'C:/MnP' }, { workspace: 'C:/Holdem' }), 'C:/Changed')
})
