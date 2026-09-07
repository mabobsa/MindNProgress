import { createHash } from 'node:crypto'
import { sharedKnowledgeMaxLength } from '../src/utils/sharedKnowledgePolicy.mjs'

export { sharedKnowledgeMaxLength }

export function textIntegrity(value) {
  const text = typeof value === 'string' ? value : ''
  return {
    length: text.length,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  }
}

export function cardTextIntegrity(data) {
  return {
    description: textIntegrity(data?.description),
    sharedKnowledge: textIntegrity(data?.sharedKnowledge),
  }
}

function matchIndices(text, needle) {
  const indices = []
  let offset = 0
  while (offset <= text.length - needle.length) {
    const index = text.indexOf(needle, offset)
    if (index < 0) break
    indices.push(index)
    offset = index + 1
  }
  return indices
}

function requireSingleMatch(text, needle, name) {
  const indices = matchIndices(text, needle)
  if (indices.length !== 1) {
    throw new Error(`TEXT_PATCH_MATCH_COUNT: ${name} 문자열은 원문에 정확히 한 번 있어야 합니다. (일치 ${indices.length}개)`)
  }
  return indices[0]
}

export function applyCardTextPatch(currentText, operation) {
  const text = typeof currentText === 'string' ? currentText : ''
  if (operation.type === 'replace_once') {
    const index = requireSingleMatch(text, operation.find, 'find')
    return `${text.slice(0, index)}${operation.replace}${text.slice(index + operation.find.length)}`
  }

  if (operation.type === 'replace_between') {
    const startIndex = requireSingleMatch(text, operation.startMarker, 'startMarker')
    const endIndex = requireSingleMatch(text, operation.endMarker, 'endMarker')
    const contentStart = startIndex + operation.startMarker.length
    if (endIndex < contentStart) {
      throw new Error('TEXT_PATCH_MARKER_ORDER: endMarker는 startMarker 뒤에 있어야 합니다.')
    }
    return `${text.slice(0, contentStart)}${operation.replacement}${text.slice(endIndex)}`
  }

  if (operation.type === 'append') {
    if (!text || !operation.text) return `${text}${operation.text}`
    const separator = {
      none: '',
      newline: '\n',
      'blank-line': '\n\n',
    }[operation.separator]
    return `${text}${separator}${operation.text}`
  }

  throw new Error(`TEXT_PATCH_OPERATION: 지원하지 않는 부분 수정 연산입니다: ${operation.type}`)
}
