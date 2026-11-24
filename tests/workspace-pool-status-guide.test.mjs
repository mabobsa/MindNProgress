import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WORKSPACE_POOL_STATUS_GUIDE, WORKSPACE_POOL_STATUS_REFERENCE } from '../mcp/workspacePoolStatusGuide.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => readFile(path.join(root, file), 'utf8')

function documentedStatuses(markdown, heading) {
  const section = markdown.split(/^## /m).find((part) => part.startsWith(heading))
  assert.ok(section, `${heading} 절 존재`)
  return section.split(/\r?\n/).filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...line.split('|')[1].matchAll(/`([a-z-]+)`/g)].map((match) => match[1]))
}

test('작업공간 풀 statusGuide는 문서화된 모든 작업공간 상태를 설명한다', async () => {
  const doc = await read('docs/ai-workspace-pool-states.md')
  const statuses = documentedStatuses(doc, '작업공간 상태')
  assert.ok(statuses.length >= 12)
  for (const status of statuses) assert.ok(WORKSPACE_POOL_STATUS_GUIDE[status], `${status} 설명 누락`)
  assert.match(WORKSPACE_POOL_STATUS_REFERENCE, /docs\/ai-workspace-pool-states\.md/)
})

test('작업공간 풀 코드가 작업공간·lease에 쓰는 상태 값은 모두 statusGuide에 있다', async () => {
  const sources = await Promise.all(['server/lib/workspacePool.mjs', 'server/lib/remoteWorkspacePool.mjs', 'runner/lib/workspaceAgent.mjs'].map(read))
  const used = new Set(sources.flatMap((source) => [...source.matchAll(/status(?::| =) '([a-z-]+)'/g)].map((match) => match[1])))
  for (const status of ['foreign-owner', 'foreign-session', 'dirty']) {
    assert.ok(sources[2].includes(`'${status}'`), `Runner 보고 상태 ${status}`)
    used.add(status)
  }
  // lease 종료·결과 파일 전용 값은 조회 결과의 작업공간 status로 노출되지 않는다(문서의 lease·결과 파일 상태 표).
  const doc = await read('docs/ai-workspace-pool-states.md')
  // sealed와 candidate-ready는 Runner seal·통합 충돌 명령의 응답 값이며 작업공간 상태가 아니다.
  const nonWorkspace = new Set([...documentedStatuses(doc, 'lease 상태'), ...documentedStatuses(doc, '결과 파일 상태'), 'sealed', 'candidate-ready'])
  for (const status of used) {
    if (nonWorkspace.has(status) && !WORKSPACE_POOL_STATUS_GUIDE[status]) continue
    assert.ok(WORKSPACE_POOL_STATUS_GUIDE[status], `${status} 설명 누락`)
  }
  assert.equal(Object.hasOwn(WORKSPACE_POOL_STATUS_GUIDE, 'reference'), false, '상태가 아닌 키를 섞지 않는다')
})
