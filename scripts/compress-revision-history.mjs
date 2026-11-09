// 기존 문서 변경 이력(<이력ID>.json)을 압축본(<이력ID>.json.br)으로 바꾼다. 기본은 시험 실행이며 --apply일 때만 바꾼다.
// 원문 바이트를 그대로 압축하고, 디스크의 압축본을 다시 읽어 풀었을 때 원문과 바이트 단위로 같을 때만 원문을 지운다(손실 없음).
// 변환 중 새 이력이 쓰이지 않도록 서버가 응답하면 --apply를 거부한다.
// 사용법: node scripts/compress-revision-history.mjs --data-dir <server/data> [--apply] [--server-url http://127.0.0.1:4176]
import { open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compressedRevisionFileName, decodeRevisionBuffer, encodeRevisionBytes, RAW_REVISION_SUFFIX, revisionFileId } from '../server/lib/revisionFiles.mjs'

const REVISION_ID = /^[a-z0-9-]{8,80}$/
const MAP_ID = /^[a-z0-9][a-z0-9-]{0,79}$/

async function serverResponds(serverUrl) {
  try {
    const response = await fetch(new URL('/api/health', serverUrl), { signal: AbortSignal.timeout(3_000) })
    return response.ok
  } catch {
    return false
  }
}

async function writeDurable(file, bytes) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const handle = await open(temporary, 'wx')
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}

export async function compressRevisionHistory({ dataDirectory, apply = false, serverUrl = 'http://127.0.0.1:4176', log = () => {} }) {
  if (!dataDirectory) throw new Error('--data-dir가 필요합니다.')
  if (apply && await serverResponds(serverUrl)) {
    throw Object.assign(new Error(`서버가 실행 중입니다(${serverUrl}). 서버를 멈춘 뒤 다시 실행하세요.`), { code: 'SERVER_RUNNING' })
  }
  const historyDirectory = path.join(path.resolve(dataDirectory), '_history')
  const summary = { apply, documents: 0, rawFiles: 0, rawBytes: 0, packedBytes: 0, converted: 0, resumed: 0, skipped: [] }
  let documents
  try { documents = await readdir(historyDirectory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return summary; throw error }
  for (const documentEntry of documents) {
    if (!documentEntry.isDirectory() || !MAP_ID.test(documentEntry.name)) continue
    summary.documents++
    const directory = path.join(historyDirectory, documentEntry.name)
    const names = new Set(await readdir(directory))
    for (const name of names) {
      if (!name.endsWith(RAW_REVISION_SUFFIX)) continue
      const id = revisionFileId(name)
      if (!REVISION_ID.test(id)) continue
      const rawFile = path.join(directory, name)
      const bytes = await readFile(rawFile)
      const info = await stat(rawFile)
      summary.rawFiles++
      summary.rawBytes += bytes.length
      try { JSON.parse(bytes.toString('utf8')) } catch {
        summary.skipped.push({ file: path.join(documentEntry.name, name), reason: 'JSON이 아니어서 그대로 둠' })
        continue
      }
      const packedFile = path.join(directory, compressedRevisionFileName(id))
      if (names.has(compressedRevisionFileName(id))) {
        // 이전 실행이 압축본을 쓰고 원문을 지우기 전에 끊긴 경우다. 내용이 같을 때만 원문을 정리한다.
        const existing = decodeRevisionBuffer(packedFile, await readFile(packedFile))
        if (!existing.equals(bytes)) {
          summary.skipped.push({ file: path.join(documentEntry.name, name), reason: '같은 ID의 압축본 내용이 달라 그대로 둠' })
          continue
        }
        summary.packedBytes += (await stat(packedFile)).size
        if (apply) { await rm(rawFile); summary.resumed++ }
        continue
      }
      const packed = encodeRevisionBytes(bytes)
      if (!decodeRevisionBuffer(packedFile, packed).equals(bytes)) {
        summary.skipped.push({ file: path.join(documentEntry.name, name), reason: '압축 검증 실패로 그대로 둠' })
        continue
      }
      summary.packedBytes += packed.length
      if (!apply) continue
      await writeDurable(packedFile, packed)
      // 디스크에 쓴 압축본을 다시 읽어 확인한 뒤에만 원문을 지운다.
      if (!decodeRevisionBuffer(packedFile, await readFile(packedFile)).equals(bytes)) {
        await rm(packedFile, { force: true })
        summary.skipped.push({ file: path.join(documentEntry.name, name), reason: '저장한 압축본 확인 실패로 원문 유지' })
        continue
      }
      await utimes(packedFile, info.atime, info.mtime)
      await rm(rawFile)
      summary.converted++
      if (summary.converted % 1000 === 0) log(`${summary.converted}개 변환`)
    }
  }
  return summary
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
  const dataDirectory = option('--data-dir')
  const serverUrl = option('--server-url') ?? process.env.MNP_API_URL ?? 'http://127.0.0.1:4176'
  try {
    const summary = await compressRevisionHistory({ dataDirectory, apply: args.includes('--apply'), serverUrl, log: (line) => console.error(line) })
    console.log(JSON.stringify({ ...summary, rawMB: Math.round(summary.rawBytes / 1e6), packedMB: Math.round(summary.packedBytes / 1e6) }, null, 2))
    if (summary.skipped.length) process.exitCode = 2
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
