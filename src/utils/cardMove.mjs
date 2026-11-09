export function cutCardSelection(nodes, edges, clickedId) {
  const clicked = nodes.find((node) => node.id === clickedId)
  if (!clicked) throw new Error('잘라낼 카드를 찾을 수 없습니다.')
  const selected = clicked.selected ? nodes.filter((node) => node.selected) : [clicked]
  if (selected.some((node) => node.data.kind === 'root')) throw new Error('문서의 최상위 카드는 잘라낼 수 없습니다.')
  const children = new Map()
  for (const edge of edges) {
    if (edge.data?.relation === 'knowledge') continue
    children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target])
  }
  const moved = new Set(), pending = selected.map((node) => node.id)
  while (pending.length) {
    const id = pending.pop()
    if (moved.has(id)) continue
    moved.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  const roots = selected.filter((node) => !edges.some((edge) => edge.data?.relation !== 'knowledge'
    && edge.target === node.id && moved.has(edge.source))).map((node) => node.id)
  if (!roots.length) throw new Error('카드 계층이 순환하여 잘라낼 수 없습니다.')
  return { cardIds: roots, movedCardIds: nodes.filter((node) => moved.has(node.id)).map((node) => node.id) }
}

export function cardMoveRequestId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return `mnpw:${Date.now()}:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

// 응답이 끊기면 같은 키로 결과만 조회한다. 미접수가 확인된 경우에만 원래 요청을 재전송한다.
export async function resolveCardMove(request, { fetchImpl = fetch, resultOnly = false, attempts = 8,
  timeoutMs = 15000, delay = () => new Promise((resolve) => setTimeout(resolve, 1000)) } = {}) {
  let query = resultOnly, resent = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(query ? '/api/maps'
        : `/api/maps/${encodeURIComponent(request.sourceMapId)}/cards/${encodeURIComponent(request.body.cardIds[0])}/move`, {
        method: query ? 'GET' : 'POST', credentials: 'include', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.requestId,
          'X-MNP-Write-Map-Id': request.sourceMapId, 'X-MNP-Write-Card-Id': request.body.cardIds[0],
          ...(query ? { 'X-MNP-Result-Only': '1' } : {}) },
        ...(query ? {} : { body: JSON.stringify(request.body) }),
      })
      const body = await response.json()
      if (body.outcome === 'committed' && body.operation) return { state: 'committed', body }
      if (body.outcome === 'not-applied') return { state: 'rejected', body }
      if (query && body.code === 'REQUEST_UNKNOWN' && !resent) { query = false; resent = true }
      else {
        // 인증 실패나 프록시 오류만으로 서버의 미반영을 단정하지 않는다.
        query = true
      }
    } catch { query = true }
    if (attempt + 1 < attempts) await delay()
  }
  return { state: 'pending', body: { error: '이동 결과를 확인하지 못했습니다. 연결이 복구되면 상태를 다시 확인해 주세요.' } }
}
