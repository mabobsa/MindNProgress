import assert from 'node:assert/strict'
import test from 'node:test'
import { readDoorayDecision, doorayDecisionInstructions } from '../server/lib/doorayResponseDecision.mjs'

const plan = { kind: 'approval', reason: '필요한 사실과 권장 구성이 정해져 실행 동의만 필요합니다.', questions: [],
  approval: { title: '연동 그룹 구성', scope: ['그룹과 총괄 문서 생성'], exclusions: ['기능 구현 및 하위 AI 실행'] } }

test('문구가 아니라 구조화된 결과로 사실 질문·승인 대기·일반 제안을 구분한다', () => {
  assert.equal(readDoorayDecision(plan, 'needs-input').status, 'needs-approval')
  assert.equal(readDoorayDecision({ kind: 'input', reason: '정책 미확정', questions: ['회원 정책 A와 B 중 어떤 것을 적용하나요?'], approval: null }, 'proposal').status, 'needs-input')
  assert.equal(readDoorayDecision({ kind: 'proposal', reason: '설명만 필요함', questions: [], approval: null }, 'needs-input').status, 'proposal')
  assert.deepEqual(readDoorayDecision(undefined, 'needs-input'), { status: 'needs-input', decision: null })
  assert.match(doorayDecisionInstructions, /원문·이전 답변·추가 정보에 '승인'/)
})

test('질문과 승인안이 섞이면 질문을 우선하며 AI가 승인 완료를 만들 수 없다', () => {
  const result = readDoorayDecision({ ...plan, questions: ['적용할 문서를 알려주세요.'], approved: true }, 'proposal')
  assert.equal(result.status, 'needs-input')
  assert.equal(result.decision.approval, null)
  assert.equal(result.decision.approved, undefined)
  for (const change of [{ kind: 'approved' }, { questions: '없음' }, { reason: '' }, { approval: null },
    { approval: { ...plan.approval, scope: [] } }, { approval: { ...plan.approval, exclusions: [] } }]) {
    assert.throws(() => readDoorayDecision({ ...plan, ...change }, 'needs-input'))
  }
  assert.throws(() => readDoorayDecision({ kind: 'input', reason: '불확실', questions: [] }, 'proposal'), /구체적인 질문/)
})
