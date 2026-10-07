import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { captureInitialResponses, digest } from '../scripts/capture-guidance-evidence.mjs'
import { AI_CONVERSATION_SELECTION_INSTRUCTION } from '../mcp/aiConversationSelectionPolicy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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

test('실제 초기 guide는 대화 연속성 안내 한 건만 추가하고 Git 기준선 원문을 보존한다', async (t) => {
  const temp = await mkdtemp(path.join(root, '.initial-guide-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const evidence = JSON.parse(await readFile(path.join(root, 'docs/ai-guidance-rollback-2026-10-01/initial-response-evidence.json'), 'utf8'))
  const baseline = evidence.runs.find((run) => run.name === 'baseline')
  assert.ok(baseline, 'Git 기준선 응답 존재')
  const actual = await captureInitialResponses(root, temp)
  assertInitialDeliveryFields(baseline, actual)
  for (const [index, session] of actual.sessions.entries()) {
    const guide = JSON.parse(session.guide.text)
    assert.equal(guide.operationRules.filter((rule) => rule === AI_CONVERSATION_SELECTION_INSTRUCTION).length, 1, `${session.name} 대화 선택 안내 한 건`)
    const preservedGuide = {
      ...guide,
      operationRules: guide.operationRules.filter((rule) => rule !== AI_CONVERSATION_SELECTION_INSTRUCTION),
    }
    assert.equal(JSON.stringify(preservedGuide), baseline.sessions[index].guide.text, `${session.name} 기존 guide 전체 보존`)
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
})
