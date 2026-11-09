import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { decodeRevisionText, isCompressedRevisionFileName, selectRevisionFiles } from './revisionFiles.mjs'

const schemaVersion = 1

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fingerprint(info) {
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

function sameFile(record, info) {
  return record?.size === info.size && record?.mtimeMs === info.mtimeMs && record?.ctimeMs === info.ctimeMs
}

function reusableRecord(record, info, dateString) {
  if (!isRecord(record) || !sameFile(record, info)) return false
  if (record.snapshotAt === null) return record.date === null
  return Number.isFinite(record.snapshotAt) && Number.isFinite(new Date(record.snapshotAt).getTime())
    && record.date === dateString(new Date(record.snapshotAt))
}

async function backupExists(file) {
  try {
    if (!(await stat(file)).isFile()) throw new Error('일일 백업 경로가 파일이 아닙니다.')
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

// 인덱스는 재생성할 수 있는 읽기 최적화 자료다. 본문이나 백업의 원본으로 사용하지 않는다.
// 매번 파일 메타데이터를 대조하므로 새 이력·변경된 이력·누락된 백업을 놓치지 않는다.
export async function backfillDailyBackupHistory({
  dataDirectory, map, isValidMapId, isValidRevisionId, isValidMap, dateString,
  writeBackup, writeIndex, readText = readFile,
}) {
  if (!isValidMapId(map?.id) || !isValidMap(map) || map.trashedAt) throw new Error('유효한 문서만 일일 백업을 보정할 수 있습니다.')
  const directory = path.join(dataDirectory, '_history', map.id)
  const indexFile = path.join(dataDirectory, '_migrations', 'daily-backup-history-v1', `${map.id}.json`)
  let previous = null
  try {
    const value = JSON.parse(await readText(indexFile, 'utf8'))
    if (value?.schemaVersion === schemaVersion && value.mapId === map.id
      && isRecord(value.revisions) && typeof value.completedAt === 'string'
      && Number.isFinite(Date.parse(value.completedAt))) previous = value
  } catch (error) {
    // 손상·구버전 인덱스는 원본 이력을 다시 확인한다. 실제 읽기 권한·디스크 오류는 숨기지 않는다.
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    entries = []
  }
  // 원문(.json)과 압축(.json.br) 이력을 모두 읽는다. 같은 이력 ID는 압축본 하나만 쓴다.
  const sources = await Promise.all(selectRevisionFiles(entries.filter(entry => entry.isFile()).map(entry => entry.name), isValidRevisionId)
    .map(async ({ name }) => ({ name, info: await stat(path.join(directory, name)) })))
  const revisions = {}
  const latestByDate = new Map()
  const result = { created: 0, historyReadCount: 0, reusedHistoryCount: 0, indexWritten: false }
  let changed = !previous || Object.keys(previous.revisions).length !== sources.length

  async function readRevision(source) {
    const file = path.join(directory, source.name)
    const text = isCompressedRevisionFileName(source.name)
      ? decodeRevisionText(source.name, await readText(file))
      : await readText(file, 'utf8')
    result.historyReadCount += 1
    if (!sameFile(source.info, await stat(file))) {
      throw new Error('일일 백업 보정 중 이력 파일이 변경됐습니다. 완료 인덱스를 저장하지 않습니다.')
    }
    const revision = JSON.parse(text)
    if (revision?.mapId === map.id && isValidMap(revision.map) && revision.map.id !== map.id) {
      throw new Error('이력의 문서 ID가 원본 문서와 달라 일일 백업 보정을 중단했습니다.')
    }
    return revision
  }

  function includeCandidate(date, candidate) {
    const previousCandidate = latestByDate.get(date)
    if (!previousCandidate || candidate.snapshotAt > previousCandidate.snapshotAt) latestByDate.set(date, candidate)
  }

  for (const source of sources) {
    const cached = previous?.revisions[source.name]
    let record
    if (reusableRecord(cached, source.info, dateString)) {
      record = cached
      result.reusedHistoryCount += 1
    } else {
      const revision = await readRevision(source)
      const timestamp = revision?.mapId === map.id && isValidMap(revision.map)
        ? new Date(revision.map.updatedAt ?? revision.archivedAt).getTime() : NaN
      record = { ...fingerprint(source.info), snapshotAt: null, date: null }
      if (Number.isFinite(timestamp)) {
        record.snapshotAt = timestamp
        record.date = dateString(new Date(timestamp))
      }
      changed = true
    }
    revisions[source.name] = record
    if (record.date) includeCandidate(record.date, { source, snapshotAt: record.snapshotAt })
  }

  const currentTimestamp = new Date(map.updatedAt ?? Date.now()).getTime()
  if (Number.isFinite(currentTimestamp)) includeCandidate(dateString(new Date(currentTimestamp)), { snapshotAt: currentTimestamp })

  for (const [date, candidate] of latestByDate) {
    const backupFile = path.join(dataDirectory, '_daily-backups', map.id, `${date}.json`)
    if (await backupExists(backupFile)) continue
    // 누락된 날짜만 원본을 다시 읽는다. 기존 백업은 최신 이력이 추가돼도 덮어쓰지 않는다.
    const revision = candidate.source ? await readRevision(candidate.source) : { map, archivedBy: map.updatedBy }
    if (!isValidMap(revision?.map) || (candidate.source && revision.mapId !== map.id)) {
      throw new Error('일일 백업을 복원할 이력 원본이 유효하지 않습니다.')
    }
    const backup = await writeBackup(revision.map, revision.archivedBy, date)
    if (!(await backupExists(backupFile))) throw new Error('일일 백업 저장을 확인하지 못해 완료 인덱스를 저장하지 않습니다.')
    if (backup) result.created += 1
  }

  // 문서별로 모든 백업이 확인된 뒤에만 원자적으로 저장한다. 중단 시 완료한 문서는 재사용하고
  // 실패한 문서는 다시 처리한다. 원본 이력과 일일 백업은 인덱스 갱신·복구 중 삭제하지 않는다.
  if (changed || result.created > 0) {
    await writeIndex(indexFile, { schemaVersion, mapId: map.id, completedAt: new Date().toISOString(), revisions })
    result.indexWritten = true
  }
  return result
}
