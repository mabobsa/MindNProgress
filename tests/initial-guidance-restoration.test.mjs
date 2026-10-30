import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { captureInitialResponses, digest, rebaselineApprovalFromArgs } from '../scripts/capture-guidance-evidence.mjs'
import { AI_CONVERSATION_SELECTION_INSTRUCTION } from '../mcp/aiConversationSelectionPolicy.mjs'
import { AI_USAGE_GUIDE } from '../mcp/aiUsage.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 이 테스트의 실패를 기준선 재생성으로 해소하지 않는다. 지침 차이는 되돌림 목록 없이 전체 원문 비교로 그대로 실패한다.
// 기준선 재생성은 사용자가 승인한 경우에만 실행하고, 그 승인 근거를 --approval-ref·--approved-at 인자로 기록한다.
// 재생성하면 아래 APPROVED_REBASELINE 상수도 함께 바꿔야 하므로 기준선 교체가 diff에 의도적 변경으로 드러난다.
// 이전 기준선 증거는 rebaseline 기록의 previousEvidenceRecovery(Git HEAD)에서 복구한다.
// 2026-10-30 3차 재생성: 위임 대화 문맥 기준 재사용을 다시 켜며 대화 선택 안내 문구만 바뀌었다(전달 필드 4개는 이전 기준선과 같음).
const APPROVED_REBASELINE = Object.freeze({
  approvedAt: '2026-10-30',
  approvalRef: '사용자 승인 2026-10-30(AionUi 대화 19f80b56, Claude Code 세션 5d96caba): "기준선 재생성 승인." 위임 대화 문맥 기준 재사용 재활성화(80% 기본 새 대화·90% 상한·contextOverride 예외, 사유 코드 4개) 구현(브랜치 feat/context-reuse-override)의 대화 선택 안내 문구 변경을 기준선에 반영',
  head: '131eacefa9d15ab6c95414e2cae88ef9bbdaaac4',
  workingTreeDiffSha256: 'bd0aa1648775cd10baa8581205924fa47f8e05f33200863cf8d75e520c5b6e9d',
  capturedTree: 'f00cff4fd2a8d5323416ac4a4a1e8540ed2d73b1',
  previousBaselineCommit: 'c5628e62accddcb6f6811cd75caf0de76a0a4cdb',
  previousWorkingTreeDiffSha256: 'a1796933fe67fe221ac6d67e9c6c1cfe9a16b40344715ace167bc05967155dff',
})
// get_document 개선(2026-10-21 승인)의 검증 지침과 그 제한 절(full 필수 조건, 원문 재사용 조건, 원문 대조 조건)은
// 재생성 기준선에도 남아 있어야 한다. 허용 절만 남기고 뒤쪽 제한 절을 자르지 않도록 원소 전체 문장을 고정한다.
const requiredGuidancePhrases = [
  '변경 후 변경 도구의 응답 또는 대상별 조회 도구(카드는 mindnprogress_get_card, 문서 구조·version은 mindnprogress_get_document의 view=outline 또는 version)로 저장 결과를 검증하고 실제 변경 내용을 요약. 재구성 계획·의미 보존 검토, restore_history 직전 백업, 요구사항 전수 감사와 지식선 전역 점검에는 view를 생략한 mindnprogress_get_document(full)를 사용',
  '이미 받은 문서를 다시 확인할 때는 같은 view·cardIds로 받은 응답의 documentEtag를 get_document의 ifNoneMatch로 전달해 같은 문서 본문의 재전송을 피할 수 있습니다. 이 방법은 그 응답 원문을 끝까지 읽었고 대화 문맥에 원문 그대로 남아 있을 때만 사용하고, 응답이 잘렸거나 일부만 읽었거나 문맥 요약·압축으로 원문 대신 요약만 남았거나 원문이 남아 있는지 확신할 수 없으면 ifNoneMatch 없이 다시 조회합니다.',
  '카드는 mindnprogress_get_card, 문서 구조·version은 mindnprogress_get_document의 view=outline 또는 version으로 확인하고, 문서 전체 원문 대조가 필요할 때만 view를 생략한 full을 사용합니다. 카드 텍스트를 작성·변경했다면 outline의 길이·textIntegrity와 version은 변경 탐지용이며 원문 검증을 대신하지 않으므로, mindnprogress_get_card 또는 outline의 cardIds로 저장된 원문을 읽어 의도와 대조합니다.',
]
// read_me_first 응답 최상위의 전달 목록. 카드 없이 시작한 진입 대화 AI가 이 목록을 기준으로 작업하므로 전문을 비교한다.
const readMeFirstPaths = [['important'], ['recommendedWorkflows']]

const scenarioNames = ['read-me-first', 'leaf', 'group-coordinator', 'document-coordinator']
const deliveryPaths = [
  ['selection', 'taskLinks', 'startupInspection'],
  ['nextStep'],
  ['groupProject', 'instruction'],
  ['selection', 'aiWorkCoordination', 'childDelegation'],
]

function requiredField(response, keys, label) {
  let value = response
  for (const key of keys) {
    assert.ok(value !== null && typeof value === 'object' && Object.hasOwn(value, key), `${label}: ${keys.join('.')} 필드 누락`)
    value = value[key]
  }
  assert.ok(value !== undefined && value !== null, `${label}: ${keys.join('.')} 값 누락`)
  if (keys.at(-1) === 'nextStep' || keys.at(-1) === 'instruction') {
    assert.equal(typeof value, 'string', `${label}: ${keys.join('.')} 문자열`)
    assert.ok(value.length > 0, `${label}: ${keys.join('.')} 빈 문자열`)
  } else {
    assert.equal(typeof value, 'object', `${label}: ${keys.join('.')} 객체`)
    assert.ok(!Array.isArray(value) && Object.keys(value).length > 0, `${label}: ${keys.join('.')} 빈 객체`)
  }
  return value
}

function assertInitialDeliveryFields(baseline, actual) {
  for (const [label, run] of [['baseline', baseline], ['actual', actual]]) {
    assert.deepEqual(run.sessions.map((session) => session.name), scenarioNames, `${label} 시나리오 이름·수·순서`)
  }
  for (const [index, session] of actual.sessions.entries()) {
    const expected = JSON.parse(baseline.sessions[index].response.text)
    const response = JSON.parse(session.response.text)
    if (session.name === 'read-me-first') {
      for (const keys of readMeFirstPaths) {
        const original = keys.reduce((parent, key) => parent?.[key], expected)
        assert.ok(original !== undefined && original !== null, `baseline read-me-first ${keys.join('.')} 누락`)
        assert.deepEqual(keys.reduce((parent, key) => parent?.[key], response), original, `read-me-first ${keys.join('.')} 전체 원문`)
      }
    }
    for (const keys of deliveryPaths) {
      if (session.name === 'read-me-first') {
        for (const [label, value] of [['baseline', expected], ['actual', response]]) {
          assert.equal(keys.reduce((parent, key) => parent?.[key], value), undefined, `${label} read-me-first에는 ${keys.join('.')} 없음`)
        }
      } else {
        const original = requiredField(expected, keys, `baseline ${session.name}`)
        const current = requiredField(response, keys, `actual ${session.name}`)
        assert.deepEqual(current, original, `${session.name} ${keys.join('.')} 전체 원문`)
      }
    }
  }
}

function mutateResponse(run, name, keys, change) {
  const session = run.sessions.find((item) => item.name === name)
  const response = JSON.parse(session.response.text)
  const parent = keys.slice(0, -1).reduce((value, key) => value[key], response)
  change(parent, keys.at(-1))
  session.response.text = JSON.stringify(response)
}

test('실제 초기 guide와 네 전달 필드는 2026-10-30 재생성 기준선 원문을 보존한다', async (t) => {
  const temp = await mkdtemp(path.join(root, '.initial-guide-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const evidence = JSON.parse(await readFile(path.join(root, 'docs/ai-guidance-rollback-2026-10-01/initial-response-evidence.json'), 'utf8'))
  assert.equal(evidence.schemaVersion, 2)
  const rebaseline = evidence.rebaseline
  assert.equal(rebaseline?.approvedAt, APPROVED_REBASELINE.approvedAt, '승인되지 않은 기준선 재생성')
  assert.equal(rebaseline?.approvalRef, APPROVED_REBASELINE.approvalRef, '승인되지 않은 기준선 재생성')
  assert.equal(rebaseline?.head, APPROVED_REBASELINE.head, '승인되지 않은 기준선 재생성')
  assert.equal(rebaseline?.workingTreeDiffSha256, APPROVED_REBASELINE.workingTreeDiffSha256, '승인되지 않은 기준선 재생성')
  assert.equal(rebaseline?.capturedTree?.tree, APPROVED_REBASELINE.capturedTree, '승인되지 않은 기준선 재생성')
  assert.equal(rebaseline?.previousBaselineCommit, APPROVED_REBASELINE.previousBaselineCommit)
  assert.equal(rebaseline?.previousRebaseline?.head, APPROVED_REBASELINE.previousBaselineCommit)
  assert.equal(rebaseline?.previousRebaseline?.workingTreeDiffSha256, APPROVED_REBASELINE.previousWorkingTreeDiffSha256)
  const sourcesRecord = JSON.parse(await readFile(path.join(root, 'docs/ai-guidance-rollback-2026-10-01/baseline-guide-sources.json'), 'utf8'))
  assert.deepEqual(sourcesRecord.rebaseline, rebaseline, '기준선 증거와 소스 원문은 같은 재생성 기록을 가진다')
  const baseline = evidence.runs.find((run) => run.name === 'baseline')
  assert.ok(baseline, '기준선 응답 존재')
  const actual = await captureInitialResponses(root, temp)
  assertInitialDeliveryFields(baseline, actual)
  for (const [index, session] of actual.sessions.entries()) {
    const guide = JSON.parse(session.guide.text)
    assert.equal(guide.version, '4.26')
    assert.equal(guide.version, JSON.parse(baseline.sessions[index].guide.text).version, `${session.name} guide version`)
    assert.deepEqual(guide.aiUsage, AI_USAGE_GUIDE)
    assert.equal(guide.operationRules.filter((rule) => rule === AI_CONVERSATION_SELECTION_INSTRUCTION).length, 1, `${session.name} 대화 선택 안내 한 건`)
    assert.equal(session.guide.text, baseline.sessions[index].guide.text, `${session.name} 기존 guide 전체 보존`)
    for (const phrase of requiredGuidancePhrases) {
      assert.ok(session.guide.text.includes(phrase), `${session.name} get_document 검증 지침 문구가 실제 guide에 있음`)
    }
    assert.equal(session.groupGuide?.text, baseline.sessions[index].groupGuide?.text, `${session.name} group guide`)
    assert.equal(session.guide.sha256, digest(session.guide.text))
    assert.ok(guide.operationRules.length > 10)
    assert.ok(guide.dataModel)
    assert.equal(guide.contextLifecycle.refresh.repeatGetContext, false)
  }
  assert.match(actual.surface.serverInstructions.text, /Dooray 승인 새 대화.*get_dooray_response_approval/s)
  assert.ok(actual.requests.every((request) => request.method === 'GET'))
  const first = JSON.parse(actual.sessions.find((session) => session.name === 'read-me-first').response.text)
  assert.ok(first.important.includes(AI_CONVERSATION_SELECTION_INSTRUCTION))
  assert.doesNotMatch(first.important.join('\n'), /caution·saturated·unknown 또는 독립 검수·새 범위는 새 대화를 선택/)
  const coordinator = JSON.parse(actual.sessions.find((session) => session.name === 'group-coordinator').response.text)
  assert.match(coordinator.guide.operationRules.join('\n'), /# 사용자 승인과 실행 범위.*# 그룹의 두 단계 사용자 승인/s)
  assert.match(coordinator.nextStep, /미승인.*댓글.*공유 지식.*상태를 변경하지/s)
  assert.equal(coordinator.selection.workflow, undefined)

  // 실제 호출 결과의 복제본만 바꾼 의도적 반례다. 저장된 기준선을 재생성하지 않는다.
  await t.test('네 필드의 actual·baseline 누락과 양쪽 동시 누락을 모두 거부한다', () => {
    for (const name of scenarioNames.slice(1)) {
      for (const keys of deliveryPaths) {
        for (const side of ['actual', 'baseline', 'both']) {
          const old = structuredClone(baseline), current = structuredClone(actual)
          if (side !== 'actual') mutateResponse(old, name, keys, (parent, key) => { delete parent[key] })
          if (side !== 'baseline') mutateResponse(current, name, keys, (parent, key) => { delete parent[key] })
          assert.throws(() => assertInitialDeliveryFields(old, current), { code: 'ERR_ASSERTION' }, `${name} ${keys.join('.')} ${side} 누락`)
        }
      }
    }
  })
  await t.test('네 필드의 문구 변경은 전체 equality로 검출한다', () => {
    for (const name of scenarioNames.slice(1)) {
      for (const keys of deliveryPaths) {
        const current = structuredClone(actual)
        mutateResponse(current, name, keys, (parent, key) => {
          if (typeof parent[key] === 'string') parent[key] += ' 의도적 변경'
          else parent[key].instruction += ' 의도적 변경'
        })
        assert.throws(() => assertInitialDeliveryFields(baseline, current), { code: 'ERR_ASSERTION' }, `${name} ${keys.join('.')} 문구 변경`)
      }
    }
  })
  await t.test('시나리오 누락·이름·순서 변경 및 read-me-first 필드 추가를 거부한다', () => {
    for (const side of ['baseline', 'actual']) {
      for (const change of [
        (run) => run.sessions.pop(),
        (run) => { run.sessions[1].name = '다른 시나리오' },
        (run) => run.sessions.reverse(),
        (run) => mutateResponse(run, 'read-me-first', ['nextStep'], (parent, key) => { parent[key] = '의도적 추가' }),
      ]) {
        const old = structuredClone(baseline), current = structuredClone(actual)
        change(side === 'baseline' ? old : current)
        assert.throws(() => assertInitialDeliveryFields(old, current), { code: 'ERR_ASSERTION' })
      }
    }
  })
  await t.test('read-me-first의 important·recommendedWorkflows 변경과 누락을 거부한다', () => {
    for (const keys of readMeFirstPaths) {
      for (const change of [
        (parent, key) => { delete parent[key] },
        (parent, key) => {
          if (Array.isArray(parent[key])) parent[key] = parent[key].slice(0, -1)
          else {
            // 검증 단계 문장 끝의 제한 절이 잘린 경우를 흉내 낸다.
            const [name] = Object.keys(parent[key])
            const steps = parent[key][name]
            parent[key][name] = Array.isArray(steps) ? steps.map((step, index) => index === steps.length - 1 ? String(step).slice(0, -5) : step) : String(steps).slice(0, -5)
          }
        },
      ]) {
        for (const side of ['baseline', 'actual']) {
          const old = structuredClone(baseline), current = structuredClone(actual)
          mutateResponse(side === 'baseline' ? old : current, 'read-me-first', keys, change)
          assert.throws(() => assertInitialDeliveryFields(old, current), { code: 'ERR_ASSERTION' }, `read-me-first ${keys.join('.')} ${side} 변경`)
        }
      }
    }
  })
})

test('기준선 재생성은 새 사용자 승인 근거와 승인 날짜 없이는 실행하지 않는다', () => {
  const base = ['node', 'scripts/capture-guidance-evidence.mjs', '--rebaseline-working-tree']
  assert.throws(() => rebaselineApprovalFromArgs(base, undefined), /--approval-ref.*테스트 실패를 해소하려고 재생성하지 마세요/s)
  assert.throws(() => rebaselineApprovalFromArgs([...base, '--approval-ref', '짧음', '--approved-at', '2026-10-22'], undefined), /--approval-ref/)
  assert.throws(() => rebaselineApprovalFromArgs([...base, '--approval-ref', '--approved-at', '2026-10-22'], undefined), /--approval-ref/)
  assert.throws(() => rebaselineApprovalFromArgs([...base, '--approval-ref', '사용자 결정 기록 4차 1번'], undefined), /--approved-at/)
  assert.throws(() => rebaselineApprovalFromArgs([...base, '--approval-ref', '사용자 결정 기록 4차 1번', '--approved-at', '2026/10/22'], undefined), /--approved-at/)
  const approved = [...base, '--approval-ref', '사용자 결정 기록 4차 1번', '--approved-at', '2026-10-22']
  assert.deepEqual(rebaselineApprovalFromArgs(approved, undefined), { approvalRef: '사용자 결정 기록 4차 1번', approvedAt: '2026-10-22' })
  // 이미 사용한 승인 근거(직전 또는 그 이전 재생성)는 다시 쓸 수 없다.
  const chain = { approvalRef: '다른 승인 근거 기록', previousRebaseline: { approval: '사용자 결정 기록 4차 1번', previousRebaseline: null } }
  assert.throws(() => rebaselineApprovalFromArgs(approved, chain), /이미 기준선 재생성에 사용한 승인 근거/)
  assert.throws(() => rebaselineApprovalFromArgs([...base, '--approval-ref', '다른 승인 근거 기록', '--approved-at', '2026-10-22'], chain), /이미 기준선 재생성에 사용한 승인 근거/)
})

test('이미 승인된 재생성 기준선은 기록된 head를 정확히 지정한 교체 인자 없이는 덮어쓰지 않는다', () => {
  const head = 'a'.repeat(40)
  const existing = { approvalRef: '이전 재생성 승인 근거 기록', head, previousRebaseline: null }
  const fresh = ['node', 'scripts/capture-guidance-evidence.mjs', '--rebaseline-working-tree', '--approval-ref', '새 사용자 승인 근거 기록', '--approved-at', '2026-10-23']
  // 새 승인 근거만으로는 거부한다. 거부 메시지는 승인 조건과 테스트 실패 해소 금지를 함께 안내한다.
  assert.throws(() => rebaselineApprovalFromArgs(fresh, existing), /이미 승인된 재생성 기준선.*사용자가 기준선 교체를 승인한 경우에만.*테스트 실패를 해소하려고 재생성하지 마세요/s)
  assert.throws(() => rebaselineApprovalFromArgs([...fresh, '--replace-rebaseline-head'], existing), /--replace-rebaseline-head가 기록된 재생성 기준선 head/)
  assert.throws(() => rebaselineApprovalFromArgs([...fresh, '--replace-rebaseline-head', 'b'.repeat(40)], existing), /--replace-rebaseline-head가 기록된 재생성 기준선 head/)
  assert.throws(() => rebaselineApprovalFromArgs([...fresh, '--replace-rebaseline-head', head.slice(0, 7)], existing), /--replace-rebaseline-head가 기록된 재생성 기준선 head/)
  assert.deepEqual(rebaselineApprovalFromArgs([...fresh, '--replace-rebaseline-head', head], existing), { approvalRef: '새 사용자 승인 근거 기록', approvedAt: '2026-10-23' })
  // 교체 인자가 맞아도 이미 사용한 승인 근거는 거부한다.
  assert.throws(() => rebaselineApprovalFromArgs(['node', 'x', '--approval-ref', '이전 재생성 승인 근거 기록', '--approved-at', '2026-10-23', '--replace-rebaseline-head', head], existing), /이미 기준선 재생성에 사용한 승인 근거/)
})
