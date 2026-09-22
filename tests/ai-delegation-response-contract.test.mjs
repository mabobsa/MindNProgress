import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  ACTIVE_AI_DELEGATION_STATES,
  AI_DELEGATION_TERMINAL_STATES,
  aiDelegationResponseBody,
  aiDelegationStateReason,
} from '../server/lib/aiDelegations.mjs'

function assertReasonMessagePair(value) {
  assert.equal(typeof value.reasonCode, 'string')
  assert.ok(value.reasonCode.trim())
  assert.equal(typeof value.message, 'string')
  assert.ok(value.message.trim())
}

test('AI 위임 HTTP 응답은 성공과 실패 모두 reasonCode와 message를 함께 제공한다', () => {
  const accepted = aiDelegationResponseBody(
    202,
    'AI_DELEGATION_ACCEPTED',
    'AI 작업 위임을 접수했습니다.',
    { delegation: { id: 'delegation-a' } },
  )
  assertReasonMessagePair(accepted)
  assert.equal(accepted.error, undefined)

  const rejected = aiDelegationResponseBody(
    409,
    'AI_DELEGATION_ALREADY_ACTIVE',
    '아직 끝나지 않은 위임이 있습니다.',
    { delegation: { id: 'delegation-a' } },
  )
  assertReasonMessagePair(rejected)
  assert.equal(rejected.error, rejected.message)

  assert.throws(
    () => aiDelegationResponseBody(202, 'AI_DELEGATION_ACCEPTED', ''),
    /reasonCode와 message/,
  )
})

test('모든 공개 AI 위임 상태는 reasonCode와 안내 message를 제공한다', () => {
  const states = new Set([
    ...ACTIVE_AI_DELEGATION_STATES,
    ...AI_DELEGATION_TERMINAL_STATES,
    'parent-wake-failed',
  ])
  for (const state of states) {
    const reason = aiDelegationStateReason({ state })
    assertReasonMessagePair(reason)
    assert.notEqual(reason.reasonCode, 'AI_DELEGATION_STATE_UNKNOWN', state)
  }
})

test('작업공간 배정 전 단계와 실제 용량 부족을 서로 다른 사유로 안내한다', () => {
  const allocating = aiDelegationStateReason({ state: 'waiting-workspace' })
  assert.equal(allocating.reasonCode, 'AI_WORKSPACE_ALLOCATION_PENDING')
  assert.match(allocating.message, /모든 worker가 사용 중이라고 판단하지/)

  const exhausted = aiDelegationStateReason({
    state: 'waiting-workspace',
    workspaceWaitReasonCode: 'CAPACITY_EXHAUSTED',
    workspaceWaitMessage: '실제 배정 시도 결과 사용 가능한 worker가 없습니다.',
  })
  assert.equal(exhausted.reasonCode, 'CAPACITY_EXHAUSTED')
  assert.match(exhausted.message, /실제 배정 시도 결과/)

  const integrationDirty = aiDelegationStateReason({ state: 'waiting-integration-clean' })
  assert.equal(integrationDirty.reasonCode, 'integration-worktree-dirty')
  assert.match(integrationDirty.message, /자동으로 시작/)
})

test('위임 생성 라우트는 모든 명시적 응답을 공통 응답 생성기로 만든다', async () => {
  const source = await readFile(new URL('../server/index.mjs', import.meta.url), 'utf8')
  const start = source.indexOf("if (aiDelegationsRoute && request.method === 'POST')")
  const end = source.indexOf('const cardAiConversationOpenRoute', start)
  assert.ok(start >= 0 && end > start)
  const route = source.slice(start, end)
  assert.doesNotMatch(route, /sendJson\(response/)
  assert.match(route, /sendAiDelegationResponse/)
})

test('통합 정리 대기는 순서 대기와 구분하고 충돌 경로와 자동 재시도를 안내한다', () => {
  const reason = aiDelegationStateReason({ state: 'waiting-integration', workspaceResult: {
    reasonCode: 'integration-untracked-collision',
    waitingReason: '미추적 파일을 정리하면 자동으로 통합됩니다. 재위임하지 마세요.',
    untrackedChanges: ['Assets/번역 자료/I2LanguagesJP.asset', 'Assets/번역 자료/I2LanguagesJP.asset.meta'],
  } })
  assert.equal(reason.reasonCode, 'integration-untracked-collision')
  assert.match(reason.message, /작업 완료 · 통합 정리 대기/)
  assert.match(reason.message, /자동으로 통합/)
  assert.match(reason.message, /I2LanguagesJP.asset.meta/)
  assert.match(aiDelegationStateReason({ state: 'waiting-integration' }).message, /반영 순서/)
})

test('MCP 오류 응답은 reasonCode와 message를 구조화해 보존한다', async () => {
  const source = await readFile(new URL('../mcp/server.mjs', import.meta.url), 'utf8')
  assert.match(source, /error\.reasonCode = body\?\.reasonCode \?\? body\?\.code/)
  assert.match(source, /reasonCode,\s*message,/)
  assert.match(source, /JSON\.stringify\(errorResult\)/)
})
