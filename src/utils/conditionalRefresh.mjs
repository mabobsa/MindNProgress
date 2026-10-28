import { createCoalescedRefresh } from './coalescedRefresh.mjs'

// 호출 주체와 문서마다 새 인스턴스를 사용한다. 304는 이미 보유한 결과에만 적용한다.
export function createConditionalRefresh(load, onValue, delayMs = 150) {
  let etag = null, hasValue = false
  const refresh = createCoalescedRefresh(async () => {
    const response = await load(hasValue ? etag : null)
    if (response.status === 304 && hasValue) return
    if (!response.ok) throw new Error('조회하지 못했습니다.')
    const value = await response.json()
    onValue(value)
    etag = response.headers.get('etag')
    hasValue = true
  }, delayMs)
  return refresh
}
