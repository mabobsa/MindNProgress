import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'

// 문서 변경 이력 파일 형식이다. 새 이력은 brotli로 압축한 JSON(<이력ID>.json.br)으로 저장한다.
// 압축 이전 이력과 예전 백업에서 복원한 이력(<이력ID>.json)도 계속 읽는다. 두 형식이 함께 있으면 압축본을 쓴다.
export const COMPRESSED_REVISION_SUFFIX = '.json.br'
export const RAW_REVISION_SUFFIX = '.json'
// 3MB 문서 기준 압축 약 13ms·해제 약 4ms이며 원문의 약 10~25%가 된다.
const BROTLI_QUALITY = 4

export function revisionFileId(name) {
  const text = String(name)
  if (text.endsWith(COMPRESSED_REVISION_SUFFIX)) return text.slice(0, -COMPRESSED_REVISION_SUFFIX.length)
  if (text.endsWith(RAW_REVISION_SUFFIX)) return text.slice(0, -RAW_REVISION_SUFFIX.length)
  return null
}

export function isCompressedRevisionFileName(name) {
  return String(name).endsWith(COMPRESSED_REVISION_SUFFIX)
}

export function compressedRevisionFileName(revisionId) {
  return `${revisionId}${COMPRESSED_REVISION_SUFFIX}`
}

export function rawRevisionFileName(revisionId) {
  return `${revisionId}${RAW_REVISION_SUFFIX}`
}

/** 이력 폴더의 파일 이름에서 이력 파일만 골라 이력 ID별로 하나씩 돌려준다. 같은 ID의 압축본과 원문이 함께 있으면 압축본을 고른다. */
export function selectRevisionFiles(names, isValidRevisionId = () => true) {
  const selected = new Map()
  for (const name of names) {
    const id = revisionFileId(name)
    if (!id || !isValidRevisionId(id)) continue
    const current = selected.get(id)
    if (!current || (isCompressedRevisionFileName(name) && !isCompressedRevisionFileName(current))) selected.set(id, name)
  }
  return [...selected].map(([id, name]) => ({ id, name }))
}

// 이력 ID는 `${Date.now().toString(36)}-${임의 hex}`라 앞부분이 저장 시각(밀리초)이다.
// 2026-11-09 운영 이력 25,066개에서 이 시각의 순서는 archivedAt 순서와 모두 같았다(차이 최대 1.8초, 역전 0건).
const REVISION_ID_TIME = /^([0-9a-z]{6,12})-[0-9a-f]+$/
const EARLIEST_REVISION_TIME = Date.UTC(2020, 0, 1)
const LATEST_REVISION_TIME = Date.UTC(2100, 0, 1)

/** 이력 ID에서 저장 시각(밀리초)을 읽는다. 규칙에 맞지 않으면 null이다. */
export function revisionIdTime(revisionId) {
  const match = REVISION_ID_TIME.exec(String(revisionId))
  if (!match) return null
  const time = parseInt(match[1], 36)
  return Number.isFinite(time) && time >= EARLIEST_REVISION_TIME && time < LATEST_REVISION_TIME ? time : null
}

/** 최신순 비교. 같은 시각이면 ID로 정해 순서가 항상 같다. */
export function compareRevisionsNewestFirst(first, second) {
  return second.time - first.time || (second.id < first.id ? -1 : second.id > first.id ? 1 : 0)
}

export function encodeRevisionBytes(content) {
  return brotliCompressSync(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
  })
}

/** 파일 이름으로 형식을 판단해 원문 바이트를 돌려준다. 원문 이력은 그대로다. */
export function decodeRevisionBuffer(name, bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return isCompressedRevisionFileName(name) ? brotliDecompressSync(buffer) : buffer
}

export function decodeRevisionText(name, bytes) {
  return decodeRevisionBuffer(name, bytes).toString('utf8')
}
