import assert from 'node:assert/strict'
import test from 'node:test'
import { AiDelegationStatusLookupError, readAiDelegationDispatchStatus } from '../server/lib/aiDelegationStatusLookup.mjs'

test('저장된 실행 ID를 지정한 머신에서 한 번만 조회하고 확인 결과를 그대로 반환한다', async () => {
  const result = { state: 'completed', conversationId: 'conversation-a', turnId: 'turn-a' }
  const calls = []
  assert.equal(await readAiDelegationDispatchStatus(async (...args) => { calls.push(args); return result }, {
    machineId: 'assigned-machine', operationId: 'operation/with space',
  }), result)
  assert.deepEqual(calls, [['assigned-machine', '/api/internal/external-conversation-dispatches/operation%2Fwith%20space']])
})

for (const [phase, label] of [['child', '하위 실행 요청'], ['recovery', '복구 요청'], ['report', '상위 AI로의 결과 전달 요청']]) {
  test(`${label}의 404는 조회 불가로 안내하고 재실행하지 않는다`, async () => {
    const original = Object.assign(new Error('AIONUI_REQUEST_FAILED:404'), { status: 404, code: 'EXTERNAL_DISPATCH_NOT_FOUND' })
    const calls = []
    await assert.rejects(readAiDelegationDispatchStatus(async (...args) => { calls.push(args); throw original }, {
      machineId: 'machine-a', operationId: 'original-operation', phase,
    }), (error) => {
      assert.ok(error instanceof AiDelegationStatusLookupError)
      assert.equal(error.cause, original)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'AI_DELEGATION_STATUS_NOT_FOUND')
      assert.ok(error.message.includes(label))
      assert.match(error.message, /저장된 위임 상태와 결과는 그대로 유지/)
      assert.match(error.message, /AI를 재실행하지 않았습니다/)
      if (phase === 'recovery') assert.match(error.message, /전달 여부도 아직 확인되지 않았으므로 새 요청을 만들지/)
      const body = error.responseBody()
      assert.deepEqual(body.statusCheck, { state: 'unavailable', reason: 'operation-not-found', phase })
      assert.equal(body.executionRequested, false)
      assert.equal(body.storedStatePreserved, true)
      assert.equal(body.error, error.message)
      assert.ok(!JSON.stringify(body).includes('AIONUI_REQUEST_FAILED'))
      return true
    })
    assert.deepEqual(calls, [['machine-a', '/api/internal/external-conversation-dispatches/original-operation']])
  })
}

test('코드가 없는 구버전 AionUi의 404도 같은 안내를 사용한다', async () => {
  await assert.rejects(readAiDelegationDispatchStatus(async () => { throw { status: 404 } }, { operationId: 'old-operation', machineId: 'main' }), AiDelegationStatusLookupError)
})

test('다른 HTTP 오류·네트워크 장애·내부 예외를 실행 기록 소실로 오인하지 않는다', async () => {
  for (const original of [Object.assign(new Error('HTTP 오류'), { status: 403 }), Object.assign(new Error('HTTP 오류'), { status: 503 }), new Error('연결 중단'), new TypeError('내부 오류')]) {
    await assert.rejects(readAiDelegationDispatchStatus(async () => { throw original }, { operationId: 'original', machineId: 'main' }), (error) => error === original)
  }
})
