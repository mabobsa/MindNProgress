import assert from 'node:assert/strict'
import test from 'node:test'
import { createStartupTiming } from '../server/lib/startupTiming.mjs'

test('기동 단계 시간은 직전 mark부터의 경과로 기록하고 가장 오래 걸린 단계를 앞에 요약한다', () => {
  const clock = [120, 150, 1_150, 1_160, 4_160, 4_200]
  const timing = createStartupTiming({ now: () => clock.shift() })
  timing.mark('storageJournalRecover')
  timing.mark('loadAiDelegations')
  timing.mark('loadGroupInstructions')
  timing.mark('workspacePoolReconcile')
  const summary = timing.summary()
  assert.equal(summary.importMs, 120)
  assert.equal(summary.totalMs, 4_080)
  assert.equal(summary.processUptimeMs, 4_200)
  assert.deepEqual(summary.phases, [
    { name: 'storageJournalRecover', ms: 30 },
    { name: 'loadAiDelegations', ms: 1_000 },
    { name: 'loadGroupInstructions', ms: 10 },
    { name: 'workspacePoolReconcile', ms: 3_000 },
  ])
  assert.deepEqual(summary.slowest.slice(0, 2), ['workspacePoolReconcile', 'loadAiDelegations'])
})
