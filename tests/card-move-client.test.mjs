import assert from 'node:assert/strict'
import test from 'node:test'
import { cutCardSelection, cardMoveRequestId, resolveCardMove } from '../src/utils/cardMove.mjs'

const request = () => ({ requestId: cardMoveRequestId(), sourceMapId: 'source', body: {
  cardIds: ['a', 'b'], targetMapId: 'target', targetParentCardId: 'root', sourceVersion: 1, targetVersion: 2, responseMode: 'full' } })
const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
test('잘라내기는 다중 선택·자식 포함·루트 보호를 적용하고 원본을 수정하지 않는다', () => {
  const nodes = ['root', 'a', 'b', 'c'].map((id) => ({ id, selected: ['a', 'b'].includes(id), data: { kind: id === 'root' ? 'root' : 'branch' } }))
  const edges = [{ source: 'root', target: 'a' }, { source: 'a', target: 'b' }, { source: 'root', target: 'c' }]
  const before = structuredClone(nodes)
  assert.deepEqual(cutCardSelection(nodes, edges, 'b'), { cardIds: ['a'], movedCardIds: ['a', 'b'] })
  assert.deepEqual(cutCardSelection(nodes, edges, 'c'), { cardIds: ['c'], movedCardIds: ['c'] })
  assert.throws(() => cutCardSelection(nodes, edges, 'root'), /최상위/)
  assert.deepEqual(nodes, before)
})
test('응답 유실 후 결과만 조회하여 이동을 중복 실행하지 않는다', async () => {
  const req = request(), calls = []
  assert.match(req.requestId, /^mnpw:\d+:[a-f0-9]{32}$/)
  const result = await resolveCardMove(req, { delay: async () => {}, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    if (calls.length === 1) throw Error('응답 유실')
    return response({ outcome: 'committed', operation: { id: 'operation-1' } })
  } })
  assert.equal(result.state, 'committed')
  assert.deepEqual(calls.map((c) => c.init.method), ['POST', 'GET'])
  assert.equal(calls[1].init.headers['X-MNP-Result-Only'], '1')
  assert.equal(calls[0].init.headers['X-MNP-Write-Map-Id'], calls[1].init.headers['X-MNP-Write-Map-Id'])
  assert.equal(calls[1].init.headers['Idempotency-Key'], req.requestId)
})
test('미접수 확인 뒤에만 같은 요청·키로 한 번 재전송한다', async () => {
  const calls = []
  const result = await resolveCardMove(request(), { resultOnly: true, delay: async () => {}, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    return calls.length === 1 ? response({ code: 'REQUEST_UNKNOWN', outcome: 'unknown' }, 404)
      : response({ outcome: 'committed', operation: { id: 'operation-1' } })
  } })
  assert.equal(result.state, 'committed')
  assert.deepEqual(calls.map((c) => c.init.method), ['GET', 'POST'])
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key'])
})
test('처리 중·통신 실패는 대기 상태를 보존하고 확정된 거절만 실패로 반환한다', async () => {
  assert.equal((await resolveCardMove(request(), { attempts: 2, delay: async () => {}, fetchImpl: async () => response({ outcome: 'processing' }, 202) })).state, 'pending')
  assert.equal((await resolveCardMove(request(), { fetchImpl: async () => response({ outcome: 'not-applied', code: 'VERSION_CONFLICT' }, 409) })).state, 'rejected')
})
