import { readFile, stat } from 'node:fs/promises'

// 파일 교체와 외부 편집을 stat으로 확인한다. 호출자는 캐시 원문을 수정할 수 없다.
export function createDocumentReadStore({ fileForId, maxBytes = 64 * 1024 * 1024, read = readFile, inspect = stat }) {
  const cache = new Map()
  const pending = new Map()
  const generations = new Map()
  let bytes = 0
  const signature = (info) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')
  const remove = (id) => {
    const previous = cache.get(id)
    if (previous) bytes -= previous.accountedBytes
    cache.delete(id)
  }
  const invalidate = (id) => {
    const token = generations.get(id)
    if (token) token.revision++
    remove(id)
    // 삭제된 ID의 세대 표를 영구 보관하지 않는다. 진행 중 읽기가 있을 때만 필요하다.
    if (![...pending.keys()].some((key) => key.startsWith(`${id}:`))) generations.delete(id)
  }
  const retain = (id, entry) => {
    remove(id)
    if (entry.bytes > maxBytes) {
      if (![...pending.keys()].some((key) => key.startsWith(`${id}:`))) generations.delete(id)
      return
    }
    while (cache.size && bytes + entry.bytes > maxBytes) {
      const oldest = cache.keys().next().value
      remove(oldest)
      if (![...pending.keys()].some((key) => key.startsWith(`${oldest}:`))) generations.delete(oldest)
    }
    entry.accountedBytes = entry.bytes
    generations.set(id, entry.token)
    cache.set(id, entry); bytes += entry.bytes
  }
  async function load(id, attempts = 0) {
    const file = fileForId(id)
    let info
    try { info = await inspect(file) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      invalidate(id)
      return null
    }
    const stamp = signature(info)
    const token = generations.get(id) ?? { revision: 0 }
    generations.set(id, token)
    const generation = token.revision
    const existing = cache.get(id)
    if (existing?.stamp === stamp && existing.generation === generation) {
      cache.delete(id); cache.set(id, existing)
      return existing
    }
    const key = `${id}:${generation}:${stamp}`
    if (pending.has(key)) {
      const shared = await pending.get(key)
      if (shared && shared.generation !== shared.token.revision) return load(id, attempts + 1)
      return shared
    }
    const operation = (async () => {
      let text, after
      try { text = await read(file, 'utf8'); after = await inspect(file) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        invalidate(id)
        return null
      }
      if (signature(after) !== stamp || token.revision !== generation) {
        if (attempts >= 3) throw Object.assign(new Error('문서 변경 중입니다. 다시 조회하세요.'), { code: 'DOCUMENT_READ_CHANGED' })
        return load(id, attempts + 1)
      }
      const entry = { stamp, generation, token, bytes: Buffer.byteLength(text), rawBytes: Buffer.byteLength(text), value: JSON.parse(text), projectionKey: null, projection: null, selections: new Map() }
      retain(id, entry)
      return entry
    })().finally(() => {
      pending.delete(key)
      if (!cache.has(id) && ![...pending.keys()].some((item) => item.startsWith(`${id}:`))) generations.delete(id)
    })
    pending.set(key, operation)
    return operation
  }
  return {
    invalidate,
    async select(id, key, project, select = (value) => value, selectionKey) {
      let entry = await load(id)
      // 완료된 공유 promise에서 깨어나는 사이 확정된 변경도 재검증한다.
      for (let retry = 0; entry && entry.generation !== entry.token.revision; retry++) {
        if (retry >= 3) throw Object.assign(new Error('문서 변경 중입니다. 다시 조회하세요.'), { code: 'DOCUMENT_READ_CHANGED' })
        entry = await load(id)
      }
      if (!entry) return null
      if (entry.projectionKey !== key || !entry.projection) {
        entry.projection = project(structuredClone(entry.value))
        entry.projectionKey = key
        entry.selections.clear()
        entry.baseBytes = entry.rawBytes + Buffer.byteLength(JSON.stringify(entry.projection))
        entry.bytes = entry.baseBytes
        retain(id, entry)
      }
      if (selectionKey !== undefined && entry.selections.has(selectionKey)) return structuredClone(entry.selections.get(selectionKey).value)
      const value = select(entry.projection, `${entry.stamp}:${entry.generation}:${key}`)
      if (selectionKey !== undefined) {
        const size = Buffer.byteLength(JSON.stringify(value) ?? '')
        // 표현별 항목 수와 원문+정규화+표현의 총 bytes를 함께 제한한다.
        while (entry.selections.size && (entry.selections.size >= 8 || entry.bytes + size > maxBytes)) {
          const first = entry.selections.keys().next().value
          entry.bytes -= entry.selections.get(first).bytes
          entry.selections.delete(first)
        }
        if (entry.bytes + size <= maxBytes) {
          entry.selections.set(selectionKey, { value, bytes: size }); entry.bytes += size
        }
        retain(id, entry)
      }
      return structuredClone(value)
    },
    usage: () => ({ bytes, entries: cache.size, pending: pending.size, generations: generations.size }),
  }
}
