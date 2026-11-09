import assert from 'node:assert/strict'
import test from 'node:test'
import { notificationTitle } from '../src/utils/notificationTitles.mjs'

test('AI 위임 알림은 현재 상태가 없으면 차단으로 단정하지 않는다', () => {
  assert.equal(notificationTitle({ type: 'ai-delegation', actor: { name: 'Mind & Progress' } }), 'AI 위임 알림')
  assert.equal(notificationTitle({ type: 'ai-delegation-completed', actor: { name: 'Mind & Progress' } }), '✅ AI 위임 완료 알림')
  assert.notEqual(notificationTitle({ type: 'ai-delegation' }), notificationTitle({ type: 'ai-delegation-completed' }))
})

test('사람 행위 알림 제목은 행위자 이름을 포함하고 알 수 없는 타입은 댓글 알림으로 표시한다', () => {
  const actor = { name: '김용민' }
  assert.equal(notificationTitle({ type: 'assignment', actor }), '김용민님이 담당자로 지정했습니다.')
  assert.equal(notificationTitle({ type: 'schedule', actor }), '담당 업무 일정 알림')
  assert.equal(notificationTitle({ type: 'waiting-released', actor }), '김용민님이 외부 대기를 해제했습니다.')
  assert.equal(notificationTitle({ type: 'mention', actor }), '김용민님이 회원님을 멘션했습니다.')
  assert.equal(notificationTitle({ type: 'reply', actor }), '김용민님이 답글을 남겼습니다.')
  assert.equal(notificationTitle({ type: 'comment', actor }), '김용민님이 댓글을 남겼습니다.')
  assert.equal(notificationTitle({ type: 'unknown-future-type', actor }), '김용민님이 댓글을 남겼습니다.')
  assert.equal(notificationTitle(null), '님이 댓글을 남겼습니다.')
})
