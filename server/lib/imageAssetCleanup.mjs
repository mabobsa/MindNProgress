import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isValidImageAssetId } from './imageAssets.mjs'
import { decodeRevisionText, isCompressedRevisionFileName } from './revisionFiles.mjs'

const MAP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/
export const DEFAULT_IMAGE_ASSET_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000

function imageAssetIdsFromMap(map) {
  if (!map || !Array.isArray(map.nodes)) throw new Error('IMAGE_ASSET_REFERENCE_MAP_INVALID')
  return map.nodes.flatMap((node) => {
    const assetId = node?.data?.image?.assetId
    return isValidImageAssetId(assetId) ? [assetId] : []
  })
}

// 압축 이력(.json.br)을 빠뜨리면 그 이력에서만 참조하는 이미지를 미참조로 보고 지운다. 이력 폴더는 두 형식을 모두 읽는다.
async function jsonFilesIn(directory, { includeCompressedRevisions = false } = {}) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith('.json') || (includeCompressedRevisions && isCompressedRevisionFileName(entry.name))))
      .map((entry) => path.join(directory, entry.name))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function referenceSnapshotFiles(dataDirectory, mapId) {
  const currentMapFile = path.join(dataDirectory, `${mapId}.json`)
  const files = [
    currentMapFile,
    ...await jsonFilesIn(path.join(dataDirectory, '_history', mapId), { includeCompressedRevisions: true }),
    ...await jsonFilesIn(path.join(dataDirectory, '_daily-backups', mapId)),
  ]
  try {
    await stat(currentMapFile)
  } catch (error) {
    if (error?.code === 'ENOENT') files.shift()
    else throw error
  }
  return files
}

async function referencedImageAssetIds(dataDirectory, mapId) {
  const assetIds = new Set()
  for (const file of await referenceSnapshotFiles(dataDirectory, mapId)) {
    const stored = JSON.parse(decodeRevisionText(path.basename(file), await readFile(file)))
    const map = stored?.map ?? stored
    for (const assetId of imageAssetIdsFromMap(map)) assetIds.add(assetId)
  }
  return assetIds
}

async function assetMapDirectories(assetsDirectory) {
  try {
    const entries = await readdir(assetsDirectory, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && MAP_ID_PATTERN.test(entry.name))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

export async function cleanupUnreferencedImageAssets({
  dataDirectory,
  minimumAgeMs = DEFAULT_IMAGE_ASSET_MINIMUM_AGE_MS,
  now = Date.now(),
  dryRun = false,
} = {}) {
  if (!dataDirectory) throw new Error('IMAGE_ASSET_CLEANUP_DATA_DIRECTORY_REQUIRED')
  const resolvedDataDirectory = path.resolve(dataDirectory)
  const assetsDirectory = path.join(resolvedDataDirectory, '_assets')
  const effectiveMinimumAgeMs = Number.isFinite(minimumAgeMs)
    ? Math.max(0, minimumAgeMs)
    : DEFAULT_IMAGE_ASSET_MINIMUM_AGE_MS
  const effectiveNow = Number.isFinite(now) ? now : Date.now()
  const summary = {
    mapsScanned: 0,
    assetsScanned: 0,
    referencedAssets: 0,
    recentUnreferencedAssets: 0,
    deletedAssets: 0,
    skippedMaps: [],
  }

  for (const mapDirectory of await assetMapDirectories(assetsDirectory)) {
    const mapId = mapDirectory.name
    let referencedAssetIds
    try {
      referencedAssetIds = await referencedImageAssetIds(resolvedDataDirectory, mapId)
    } catch (error) {
      summary.skippedMaps.push({ mapId, reason: error instanceof Error ? error.message : String(error) })
      continue
    }

    summary.mapsScanned += 1
    const mapAssetsDirectory = path.join(assetsDirectory, mapId)
    const entries = await readdir(mapAssetsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !isValidImageAssetId(entry.name)) continue
      summary.assetsScanned += 1
      if (referencedAssetIds.has(entry.name)) {
        summary.referencedAssets += 1
        continue
      }

      const assetFile = path.join(mapAssetsDirectory, entry.name)
      const assetStat = await stat(assetFile)
      if (effectiveNow - assetStat.mtimeMs < effectiveMinimumAgeMs) {
        summary.recentUnreferencedAssets += 1
        continue
      }
      if (!dryRun) await rm(assetFile, { force: true })
      summary.deletedAssets += 1
    }
  }

  return summary
}
