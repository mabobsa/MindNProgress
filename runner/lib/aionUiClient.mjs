// AionUi 후보 주소를 순회하되, 전송 여부가 불명확한 변경 요청은 다른 주소에서 반복하지 않는다.
// 연결 자체가 성립하지 않은 오류만 안전하게 다음 후보로 넘긴다.

const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const CONNECTION_NOT_ESTABLISHED_CODES = new Set([
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
])

function errorCode(error) {
  return String(error?.cause?.code ?? error?.code ?? '')
}

export function canTryNextAionUiCandidate(error, method) {
  if (SAFE_RETRY_METHODS.has(String(method ?? 'GET').toUpperCase())) return true
  return CONNECTION_NOT_ESTABLISHED_CODES.has(errorCode(error))
}

export function createAionUiCaller({ candidateBaseUrls, fetchImpl = fetch, onConnected = () => {} } = {}) {
  return async function callAionUi(request) {
    const candidates = await candidateBaseUrls()
    let lastError = null

    for (const baseUrl of candidates) {
      try {
        const response = await fetchImpl(`${baseUrl}${request.pathname}`, {
          method: request.method,
          headers: {
            Accept: 'application/json',
            ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: AbortSignal.timeout(request.timeoutMs),
        })
        const responseBody = await response.json().catch(() => ({}))
        onConnected(baseUrl)

        if (!response.ok || responseBody?.success === false) {
          return {
            ok: false,
            status: response.status,
            code: responseBody?.error?.code ?? responseBody?.code ?? null,
          }
        }
        return { ok: true, data: responseBody?.data ?? responseBody }
      } catch (error) {
        lastError = error
        if (!canTryNextAionUiCandidate(error, request.method)) break
      }
    }

    throw lastError ?? new Error('로컬 AionUi에 연결하지 못했습니다.')
  }
}
