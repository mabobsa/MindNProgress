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
  // Windows 경로는 AionUi 폴더 선택과 같은 백슬래시 표기로 맞춘다(사이드바 프로젝트 묶음이 갈라지지 않게).
  assert.equal(aiDelegationNewWorkspace({}, { selection: { workspace: 'C:/Holdem' } }, { workspace: 'C:/MnP' }), 'C:\\Holdem')
  assert.equal(aiDelegationNewWorkspace({}, { selection: { workspace: 'C:/MnP' } }, { workspace: 'C:/Holdem' }), 'C:\\MnP')
  assert.equal(aiDelegationNewWorkspace({ workspace: 'C:/Changed' }, { workspace: 'C:/MnP' }, { workspace: 'C:/Holdem' }), 'C:\\Changed')
})

test('같은 폴더를 다른 표기로 요청하면 기존 대화의 표기를 따르고 macOS 경로는 그대로 둔다', () => {
  // 2026-11-14 인계 19cccf84·aa46029f: 'C:/Git/Holdem/hdtf-client'로 요청돼 다른 대화(C:\Git\Holdem\hdtf-client)와 갈라졌다.
  assert.equal(aiDelegationNewWorkspace({ workspace: 'C:/Git/Holdem/hdtf-client' }, { selection: { workspace: 'C:\\Git\\Holdem\\hdtf-client' } }),
    'C:\\Git\\Holdem\\hdtf-client')
  assert.equal(aiDelegationNewWorkspace({ workspace: 'c:/git/holdem/hdtf-client/' }, null, { workspace: 'C:\\Git\\Holdem\\hdtf-client' }),
    'C:\\Git\\Holdem\\hdtf-client', '대소문자·끝 구분자만 다르면 같은 폴더로 보고 기존 표기를 쓴다')
  assert.equal(aiDelegationNewWorkspace({ workspace: 'D:/Work//Project\\' }), 'D:\\Work\\Project')
  assert.equal(aiDelegationNewWorkspace({ workspace: '//server/share/repo' }), '\\\\server\\share\\repo')
  assert.equal(aiDelegationNewWorkspace({ workspace: 'C:/' }), 'C:\\')
  assert.equal(aiDelegationNewWorkspace({ workspace: '/Users/dev/Holdem//hdtf-client/' }), '/Users/dev/Holdem/hdtf-client')
  assert.equal(aiDelegationNewWorkspace({ workspace: '/Users/dev/Project' }, { selection: { workspace: '/users/dev/project' } }), '/Users/dev/Project',
    'macOS 경로는 대소문자를 구분해 다른 폴더로 본다')
  assert.equal(aiDelegationNewWorkspace({}, null, null), null)
})
