import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { captureInitialResponses, digest } from '../scripts/capture-guidance-evidence.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('실제 초기 응답과 그룹 전달 경로의 상세 guide는 Git 기준선 원문과 일치한다', async (t) => {
  const temp = await mkdtemp(path.join(root, '.initial-guide-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const evidence = JSON.parse(await readFile(path.join(root, 'docs/ai-guidance-rollback-2026-10-01/initial-response-evidence.json'), 'utf8'))
  const baseline = evidence.runs.find((run) => run.name === 'baseline')
  const actual = await captureInitialResponses(root, temp)
  for (const [index, session] of actual.sessions.entries()) {
    assert.equal(session.guide.text, baseline.sessions[index].guide.text, `${session.name} guide`)
    assert.equal(session.groupGuide?.text, baseline.sessions[index].groupGuide?.text, `${session.name} group guide`)
    assert.equal(session.guide.sha256, digest(session.guide.text))
    const guide = JSON.parse(session.guide.text)
    assert.ok(guide.operationRules.length > 10)
    assert.ok(guide.dataModel)
    assert.equal(guide.contextLifecycle.refresh.repeatGetContext, false)
  }
  assert.match(actual.surface.serverInstructions.text, /Dooray 승인 새 대화.*get_dooray_response_approval/s)
  assert.ok(actual.requests.every((request) => request.method === 'GET'))
  const coordinator = JSON.parse(actual.sessions.find((session) => session.name === 'group-coordinator').response.text)
  assert.match(coordinator.guide.operationRules.join('\n'), /# 사용자 승인과 실행 범위.*# 그룹의 두 단계 사용자 승인/s)
  assert.match(coordinator.nextStep, /미승인.*댓글.*공유 지식.*상태를 변경하지/s)
  assert.equal(coordinator.selection.workflow, undefined)
})
