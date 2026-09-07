import assert from 'node:assert/strict'
import test from 'node:test'
import { canTryNextAionUiCandidate, createAionUiCaller } from '../runner/lib/aionUiClient.mjs'

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

test('읽기 요청은 연결 오류 뒤 다음 AionUi 후보를 사용할 수 있다', async () => {
  const calls = []
  const caller = createAionUiCaller({
    candidateBaseUrls: async () => ['http://127.0.0.1:1986', 'http://127.0.0.1:5830'],
    fetchImpl: async (url) => {
      calls.push(url)
      if (calls.length === 1) throw new Error('timeout')
      return response({ data: { items: [] } })
    },
  })

  assert.deepEqual(await caller({ method: 'GET', pathname: '/api/items', timeoutMs: 1_000 }), {
    ok: true,
    data: { items: [] },
  })
  assert.equal(calls.length, 2)
})

test('변경 요청의 시간 초과는 전송 여부가 불명확하므로 다른 후보에서 반복하지 않는다', async () => {
  const calls = []
  const caller = createAionUiCaller({
    candidateBaseUrls: async () => ['http://127.0.0.1:1986', 'http://127.0.0.1:5830'],
    fetchImpl: async (url) => {
      calls.push(url)
      const error = new Error('request timed out')
      error.name = 'TimeoutError'
      throw error
    },
  })

  await assert.rejects(() => caller({ method: 'POST', pathname: '/api/conversations', timeoutMs: 1_000 }), /timed out/)
  assert.equal(calls.length, 1)
})

test('변경 요청도 연결 성립 전 거부된 경우에는 다음 후보를 사용한다', async () => {
  const calls = []
  const caller = createAionUiCaller({
    candidateBaseUrls: async () => ['http://127.0.0.1:1986', 'http://127.0.0.1:5830'],
    fetchImpl: async (url) => {
      calls.push(url)
      if (calls.length === 1) {
        const error = new Error('connect refused', { cause: { code: 'ECONNREFUSED' } })
        throw error
      }
      return response({ data: { id: 'conversation-1' } })
    },
  })

  assert.equal(canTryNextAionUiCandidate(new Error('timeout'), 'POST'), false)
  assert.deepEqual(await caller({ method: 'POST', pathname: '/api/conversations', timeoutMs: 1_000 }), {
    ok: true,
    data: { id: 'conversation-1' },
  })
  assert.equal(calls.length, 2)
})
