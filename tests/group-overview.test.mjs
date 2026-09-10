import assert from 'node:assert/strict'
import test from 'node:test'
import { filterGroupOverviewRows, groupDelegationPresentation, groupOverviewRows } from '../src/utils/groupOverview.mjs'

const document = (id, title = id) => ({ id, title, root: { data: { description: '담당 범위 원문' } }, runtime: null, work: { total: 5, done: 2, waiting: 0 } })
const delegation = (id, mapId, state, createdAt = '2026-09-10T00:00:00Z') => ({ id, mapId, state, createdAt, targetCardLabel: `${mapId} 담당`, result: `${id} 결과 원문` })
const context = (documents, delegations) => ({ project: { coordinatorMapId: 'coordinator' }, documents, delegations })

test('담당 문서는 그룹 순서를 유지하고 총괄 문서는 별도로 둔다', () => {
  const input = context([document('coordinator'), document('b'), document('a')], [])
  assert.deepEqual(groupOverviewRows(input).map((row) => row.mapId), ['b', 'a'])
  assert.deepEqual(groupOverviewRows(null), [])
})

test('문서별 실행 이력은 최신순으로 모으되 원본과 과거 결과를 보존한다', () => {
  const input = context([document('a')], [delegation('old', 'a', 'failed'), delegation('new', 'a', 'completed', '2026-09-10T01:00:00Z')])
  const original = structuredClone(input)
  const [row] = groupOverviewRows(input)
  assert.equal(row.latest.id, 'new')
  assert.equal(row.attention, false, '과거 실패가 최신 완료를 덮지 않는다')
  assert.equal(row.delegations[1].result, 'old 결과 원문')
  assert.deepEqual(input, original)
})

test('그룹에서 제외된 문서의 위임도 이력 행으로 남긴다', () => {
  const rows = groupOverviewRows(context([document('a')], [delegation('past', 'moved', 'completed')]))
  assert.equal(rows.length, 2)
  assert.equal(rows[1].document, null)
  assert.equal(rows[1].delegations[0].result, 'past 결과 원문')
})

test('현재 확인이 필요한 상태와 완료 결과 전달 대기를 구분한다', () => {
  const report = { ...delegation('report', 'a', 'parent-wake-failed'), workCompleted: true, reportPending: true }
  assert.deepEqual(groupDelegationPresentation(report), { label: '작업 완료 · 총괄 보고 대기', tone: 'warning', attention: true })
  assert.equal(groupDelegationPresentation(delegation('limit', 'a', 'waiting-usage-limit')).attention, true)
  assert.equal(groupDelegationPresentation({ state: 'failed', displayState: 'recovery-dispatch-pending' }).tone, 'warning')
  assert.equal(groupDelegationPresentation({ state: 'failed' }).tone, 'danger')
  assert.equal(groupDelegationPresentation(null).label, '위임 없음')
})

test('업무 대기와 AI 확인 대기는 위임 완료 집계와 별도로 필터링한다', () => {
  const waiting = { ...document('wait', '스토리'), work: { total: 5, done: 2, waiting: 1 } }
  const confirmation = { ...document('confirm', '승인'), runtime: { state: 'waiting-confirmation' } }
  const rows = groupOverviewRows(context([document('normal', '로비'), waiting, confirmation], []))
  assert.deepEqual(filterGroupOverviewRows(rows, '', true).map((row) => row.mapId), ['wait', 'confirm'])
  assert.deepEqual(filterGroupOverviewRows(rows, ' 스토리 ', false).map((row) => row.mapId), ['wait'])
  assert.deepEqual(filterGroupOverviewRows(rows, 'CONFIRM', false).map((row) => row.mapId), ['confirm'])
  assert.equal(filterGroupOverviewRows(rows, '없는 문서', false).length, 0)
})
