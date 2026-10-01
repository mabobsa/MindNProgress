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
import { MNP_CONTEXT_BOOTSTRAP_INSTRUCTION } from '../src/utils/aiContextInstructions.mjs'
import { buildAiInstructionSnapshots, buildOrdinaryRecoverySnapshot } from './helpers/aiInstructionSnapshots.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const budget = JSON.parse(await readFile(path.join(root, 'tests/fixtures/ai-instruction-budget.json'), 'utf8'))
const digest = (text) => createHash('sha256').update(text).digest('hex')
const count = (text, part) => text.split(part).length - 1

test('17개 실제 전달 전문은 복구한 조립 경로의 전문·해시와 일치한다', async () => {
  const snapshots = await buildAiInstructionSnapshots()
  assert.equal(snapshots.length, 17)
  assert.deepEqual(snapshots.map(({ name, text }) => ({ name, chars: text.length, sha256: digest(text) })), budget.snapshots)
  assert.equal(snapshots.reduce((sum, item) => sum + item.text.length, 0), budget.dynamicTotalChars)
  assert.equal(Math.max(...snapshots.map((item) => item.text.length)), budget.maxDynamicChars)

  const byName = Object.fromEntries(snapshots.map(({ name, text }) => [name, text]))
  assert.equal(byName.unselected, '')
  assert.match(snapshots[0].router, /read_me_first.*get_context.*guide.*nextStep/s)
  assert.match(byName['leaf-new'], /최초 `get_context` 응답과 이후 대상별 최신 조회 결과/)
  assert.match(byName['group-coordinator-new'], /# 사용자 승인과 실행 범위/)
  assert.match(byName['group-coordinator-new'], /# 그룹의 두 단계 사용자 승인/)
  assert.ok(byName['group-coordinator-new'].includes(GROUP_COORDINATOR_INSTRUCTION))
  assert.match(byName['group-proposal-only'], /문서별 사용자 승인 전에는 루트 수정, 지시 전달이나 AI 위임을 하지 마세요/)
  assert.ok(byName['document-coordinator-new'].includes(DOCUMENT_COORDINATOR_INSTRUCTION))
  assert.match(byName['document-delivery'], /완료 보고 라우팅.*현재 지시의 명시적 대체 대상.*자동 재개된 턴에서도/s)
  assert.match(byName['document-delivery'], /이 작업은 그룹 문서 최상위 카드의 분석·조정 업무/)
  assert.ok(byName['worker-new-no-lease'].includes(MNP_CONTEXT_BOOTSTRAP_INSTRUCTION))
  assert.equal(count(byName['worker-new-lease'], '# 할당된 작업공간'), 1)
  assert.equal(byName['worker-new-no-lease'], byName['worker-resume'])
  assert.match(byName['worker-resume'], /사용자의 중지로 끊긴 뒤 같은 대화에서 직접 이어진 경우/)
  assert.match(byName['parent-wake'], /하위 AI의 마지막 응답.*완료 결과가 보고 대기이면/s)
  assert.ok(byName['group-parent-wake'].includes(AI_EXECUTION_APPROVAL_INSTRUCTION))
  assert.ok(byName['group-parent-wake'].includes(GROUP_APPROVAL_INSTRUCTION))
  assert.equal([...byName['user-stop-recovery'].matchAll(/^# 할당된 작업공간$/gm)].length, 1)
  assert.match(byName['user-stop-recovery'], /복구 후 수행 지시/)
  assert.match(byName['user-stop-recovery'], /mindnprogress_complete_ai_delegation/)
  assert.match(byName.reconstruction, /재구성 제안만/)
  assert.match(byName.layout, /배치 제안/)
  assert.match(byName['dooray-proposal'], /파일·카드·Dooray를 수정하거나 댓글을 등록하지 마세요/)
  assert.match(byName['dooray-approval'], /가장 먼저 mindnprogress_get_dooray_response_approval/)

  const combined = snapshots.map(({ text }) => text).join('\n')
  assert.deepEqual({
    contextBootstrap: count(combined, '# 대화 문맥 초기화'),
    workspace: count(combined, '# 할당된 작업공간'),
    completion: count(combined, 'mindnprogress_complete_ai_delegation'),
  }, budget.repetitionCounts)
  assert.equal(count(combined, 'writePolicy:'), 0)
  assert.equal(count(combined, 'workflow:'), 0)
  assert.ok(count(combined, GROUP_COORDINATOR_INSTRUCTION) >= 1)
  assert.ok(count(buildOrdinaryRecoverySnapshot(), 'mindnprogress_complete_ai_delegation') >= 1)
})
