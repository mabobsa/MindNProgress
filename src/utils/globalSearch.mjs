export function buildGlobalSearchPath({
  query = '',
  mode = 'ranked',
  cursor = '',
  limit = 25,
  mapIds = [],
  groupIds = [],
  fields = [],
  kinds = [],
  statuses = [],
  assigneeIds = [],
  isWork = null,
  hasWaitingItems = null,
} = {}) {
  const params = new URLSearchParams({ q: String(query), mode: String(mode), limit: String(limit) })
  for (const value of mapIds) params.append('mapId', String(value))
  for (const value of groupIds) params.append('groupId', String(value))
  for (const value of fields) params.append('field', String(value))
  for (const value of kinds) params.append('kind', String(value))
  for (const value of statuses) params.append('status', String(value))
  for (const value of assigneeIds) params.append('assigneeId', String(value))
  if (isWork !== null && isWork !== undefined) params.set('isWork', String(isWork))
  if (hasWaitingItems !== null && hasWaitingItems !== undefined) params.set('hasWaitingItems', String(hasWaitingItems))
  if (cursor) params.set('cursor', String(cursor))
  return `/api/search?${params}`
}

export function mergeGlobalSearchResults(current, incoming) {
  const result = [...current]
  const keys = new Set(current.map((item) => [item.mapId, item.cardId ?? '', item.field, item.commentId ?? '', item.snippet].join('\u0000')))
  for (const item of incoming) {
    const key = [item.mapId, item.cardId ?? '', item.field, item.commentId ?? '', item.snippet].join('\u0000')
    if (keys.has(key)) continue
    keys.add(key)
    result.push(item)
  }
  return result
}

function normalizeHighlightText(source) {
  let normalized = ''
  const normalizedRanges = []
  let sourceOffset = 0
  for (const character of source) {
    const next = (normalized + character).normalize('NFKC')
    let unchanged = 0
    while (unchanged < normalized.length && normalized[unchanged] === next[unchanged]) unchanged += 1
    // … → ... 같은 확장과 한글 자모 결합 모두 원문 범위를 유지한다.
    const range = { start: normalizedRanges[unchanged]?.start ?? sourceOffset, end: sourceOffset + character.length }
    normalizedRanges.splice(unchanged, normalizedRanges.length - unchanged,
      ...Array.from({ length: next.length - unchanged }, () => range))
    normalized = next
    sourceOffset += character.length
  }
  const ranges = []
  let normalizedOffset = 0
  for (const character of normalized) {
    const range = { start: normalizedRanges[normalizedOffset].start,
      end: normalizedRanges[normalizedOffset + character.length - 1].end }
    ranges.push(...Array.from({ length: character.toLocaleLowerCase('ko-KR').length }, () => range))
    normalizedOffset += character.length
  }
  // 소문자 변환은 전체 문자열에 적용해 문맥에 따른 대소문자 규칙을 유지한다.
  return { text: normalized.toLocaleLowerCase('ko-KR'), ranges }
}

export function globalSearchHighlightSegments(text, matchedTerms = []) {
  const source = String(text ?? '')
  const terms = [...new Set(matchedTerms.map((term) => String(term ?? '').trim()).filter(Boolean))]
    .sort((first, second) => second.length - first.length)
  if (!source || terms.length === 0) return [{ text: source, highlighted: false }]
  const { text: lowered, ranges } = normalizeHighlightText(source)
  const matches = []
  for (const term of terms) {
    const normalizedTerm = term.normalize('NFKC').toLocaleLowerCase('ko-KR')
    let offset = 0
    while (normalizedTerm && offset < lowered.length) {
      const index = lowered.indexOf(normalizedTerm, offset)
      if (index < 0) break
      matches.push({ start: ranges[index].start, end: ranges[index + normalizedTerm.length - 1].end })
      offset = index + normalizedTerm.length
    }
  }
  if (matches.length === 0) return [{ text: source, highlighted: false }]
  matches.sort((first, second) => first.start - second.start || second.end - first.end)
  const merged = []
  for (const match of matches) {
    const previous = merged.at(-1)
    if (previous && match.start <= previous.end) previous.end = Math.max(previous.end, match.end)
    else merged.push({ ...match })
  }
  const segments = []
  let offset = 0
  for (const match of merged) {
    if (match.start > offset) segments.push({ text: source.slice(offset, match.start), highlighted: false })
    segments.push({ text: source.slice(match.start, match.end), highlighted: true })
    offset = match.end
  }
  if (offset < source.length) segments.push({ text: source.slice(offset), highlighted: false })
  return segments
}
