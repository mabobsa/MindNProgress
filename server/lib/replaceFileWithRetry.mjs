import { rename, rm } from 'node:fs/promises'

export async function replaceFileWithRetry(temporaryFile, targetFile, { renameFile = rename } = {}) {
  const retryableCodes = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM'])
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await renameFile(temporaryFile, targetFile)
      return
    } catch (error) {
      if (!retryableCodes.has(error?.code) || attempt === 5) {
        await rm(temporaryFile, { force: true }).catch(() => undefined)
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 15 * (2 ** attempt)))
    }
  }
}
