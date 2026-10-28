import assert from 'node:assert/strict'
import test from 'node:test'
import { createConditionalRefresh } from '../src/utils/conditionalRefresh.mjs'

test('동일 표현은 304로 유지하고 조회 중 변경은 후속 조회하며 오류 후 복구한다', async () => {
  const seen = [], tags = []; let release, fail = false, version = 1
  const refresh = createConditionalRefresh(async (etag) => {
    tags.push(etag)
    const current = version
    if (release === undefined) await new Promise((resolve) => { release = resolve })
    if (fail) return new Response('', { status: 503 })
    return etag === String(current) ? new Response(null, { status: 304 })
      : new Response(JSON.stringify({ version: current }), { headers: { etag: String(current) } })
  }, (value) => seen.push(value.version), 0)
  const first = refresh.request()
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1))
  version = 2
  const second = refresh.request(); release()
  await Promise.all([first, second])
  assert.deepEqual(seen, [1, 2]); assert.deepEqual(tags, [null, '1'])
  await refresh.request(); assert.deepEqual(seen, [1, 2])
  fail = true; await assert.rejects(refresh.request())
  fail = false; version = 3; await refresh.request()
  assert.deepEqual(seen, [1, 2, 3]); refresh.dispose()
  await assert.rejects(refresh.request())
})
