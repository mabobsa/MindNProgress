// 격리 API fixture가 discovery/default 후보로 실제 Core에 접근하지 못하게 한다.
const allowed = new Set(JSON.parse(process.env.MNP_TEST_ALLOWED_FETCH_ORIGINS ?? '[]'))
if (!allowed.size) throw new Error('격리 fetch origin이 필요합니다.')
const originalFetch = globalThis.fetch
let rejectedRequests = 0
const observedOrigins = new Set()
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!allowed.has(url.origin)) {
    if (++rejectedRequests === 1) process.stderr.write('# isolated-fetch: rejected before fetch\n')
    return Promise.reject(new Error('ISOLATED_FIXTURE_FETCH_ORIGIN_REJECTED'))
  }
  if (!observedOrigins.has(url.origin)) {
    observedOrigins.add(url.origin); process.stderr.write(`# isolated-fetch: allowed origin=${url.origin}\n`)
  }
  return originalFetch(input, options)
}
