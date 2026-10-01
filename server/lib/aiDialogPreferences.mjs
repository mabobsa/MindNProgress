import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { isAiDialogSectionsPatch, normalizeAiDialogSections } from '../../src/utils/aiDialogSections.mjs'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

export async function createAiDialogPreferences({ dataDirectory, replaceFile = replaceFileWithRetry }) {
  const file = path.join(dataDirectory, '_ai-dialog-preferences.json')
  let records = new Map()
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    records = new Map(stored.filter(item => typeof item?.userId === 'string').map(item => [item.userId, normalizeAiDialogSections(item.sections)]))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let queue = Promise.resolve()
  const get = userId => normalizeAiDialogSections(records.get(userId))
  const patch = (userId, sections) => {
    if (!isAiDialogSectionsPatch(sections)) throw Object.assign(new Error('접힘 상태는 작업공간·MCP 도구·스킬의 참/거짓 값만 저장할 수 있습니다.'), { status: 400 })
    const operation = queue.then(async () => {
      const updated = { ...get(userId), ...sections }
      const next = new Map(records).set(userId, updated)
      await mkdir(dataDirectory, { recursive: true })
      const temporaryFile = `${file}.${randomBytes(5).toString('hex')}.tmp`
      try {
        await writeFile(temporaryFile, JSON.stringify([...next].map(([id, value]) => ({ userId: id, sections: value })), null, 2) + '\n', 'utf8')
        await replaceFile(temporaryFile, file)
      } catch (error) { await rm(temporaryFile, { force: true }).catch(() => {}); throw error }
      records = next
      return get(userId)
    })
    queue = operation.catch(() => {})
    return operation
  }
  return { get, patch }
}
