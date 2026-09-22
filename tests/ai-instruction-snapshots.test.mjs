import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  AI_EXECUTION_APPROVAL_INSTRUCTION,
  DOCUMENT_COORDINATOR_INSTRUCTION,
  GROUP_APPROVAL_INSTRUCTION,
  GROUP_COORDINATOR_INSTRUCTION,
} from '../src/utils/aiApprovalInstructions.mjs'
import { buildAiInstructionSnapshots, buildOrdinaryRecoverySnapshot } from './helpers/aiInstructionSnapshots.mjs'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const budget = JSON.parse(await readFile(path.join(projectDirectory, 'tests/fixtures/ai-instruction-budget.json'), 'utf8'))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const occurrences = (text, token) => text.split(token).length - 1

test('17개 역할·상태 전문은 고정 snapshot과 문자 예산을 지킨다', () => {
  const snapshots = buildAiInstructionSnapshots()
  assert.equal(snapshots.length, 17)
  assert.deepEqual(snapshots.map(({ name, text }) => ({ name, chars: text.length, sha256: digest(text) })), budget.snapshots)
  assert.equal(snapshots.reduce((sum, snapshot) => sum + snapshot.text.length, 0), budget.dynamicTotalChars)
  assert.equal(Math.max(...snapshots.map((snapshot) => snapshot.text.length)), budget.maxDynamicChars)
  assert.equal(budget.fixedSurfaceChars + budget.maxDynamicChars, budget.maxStartChars)

  const byName = Object.fromEntries(snapshots.map((snapshot) => [snapshot.name, snapshot.text]))
  assert.equal(byName.unselected.length, 0)
  assert.match(snapshots[0].router, /approval-first.*selected.*unselected/s)
  assert.match(byName['leaf-new'], /실행 상태: `new`.*workflow: `card-work`.*writePolicy: `allowed`/s)
  assert.match(byName['group-coordinator-new'], /역할: group coordinator/)
  assert.match(byName['group-coordinator-new'], /writePolicy: `approval-required`/)
  assert.match(byName['group-proposal-only'], /workflow: proposal-only.*writePolicy: forbidden.*지시·AI 위임을 실행하지/s)
  assert.match(byName['document-coordinator-new'], /역할: document coordinator.*guide\.documentCoordinator/s)
  assert.match(byName['document-delivery'], /역할: document coordinator.*get_group_context의 guide\.documentCoordinator 한 곳/s)
  assert.match(byName['worker-new-no-lease'], /# 대화 문맥 초기화/)
  assert.doesNotMatch(byName['worker-new-no-lease'], /# 할당된 작업공간/)
  assert.equal(occurrences(byName['worker-new-lease'], '# 할당된 작업공간'), 1)
  assert.match(byName['worker-resume'], /실행 상태: resume.*get_context를 반복하지/s)
  assert.doesNotMatch(byName['worker-resume'], /# 대화 문맥 초기화/)
  assert.match(byName['shared-knowledge-proposal'], /workflow: `proposal-only`.*writePolicy: `forbidden`/s)
  assert.match(byName['parent-wake'], /실행 상태: parent-wake/)
  assert.match(byName['group-parent-wake'], /역할: group coordinator.*승인 원문을 복제하지/s)
  assert.equal(occurrences(byName['user-stop-recovery'], '# 할당된 작업공간'), 1)
  assert.match(byName['user-stop-recovery'], /실행 상태: recovery.*mindnprogress_complete_ai_delegation/s)
  assert.match(byName.reconstruction, /workflow: `reconstruction`.*writePolicy: `forbidden`/s)
  assert.match(byName.layout, /workflow: `layout`.*writePolicy: `forbidden`/s)
  assert.match(byName['dooray-proposal'], /workflow: dooray-proposal.*writePolicy: forbidden/s)
  assert.match(byName['dooray-approval'], /진입: approval-first.*server-approved-only/s)

  const combined = snapshots.map((snapshot) => snapshot.text).join('\n')
  assert.deepEqual({
    contextBootstrap: occurrences(combined, '# 대화 문맥 초기화'),
    writePolicy: occurrences(combined, 'writePolicy:'),
    workspace: occurrences(combined, '# 할당된 작업공간'),
    completion: occurrences(combined, 'mindnprogress_complete_ai_delegation'),
    doorayProposal: occurrences(combined, 'workflow: dooray-proposal'),
    doorayApproval: occurrences(combined, '진입: approval-first'),
  }, budget.repetitionCounts)
  assert.equal(occurrences(combined, GROUP_COORDINATOR_INSTRUCTION), 0)
  assert.equal(occurrences(combined, DOCUMENT_COORDINATOR_INSTRUCTION), 0)
  assert.equal(occurrences(combined, AI_EXECUTION_APPROVAL_INSTRUCTION), 0)
  assert.equal(occurrences(combined, GROUP_APPROVAL_INSTRUCTION), 0)
  assert.equal(occurrences(combined, 'mindnprogress_complete_ai_delegation'), 1)
  assert.equal(occurrences(buildOrdinaryRecoverySnapshot(), 'mindnprogress_complete_ai_delegation'), 0)
})
