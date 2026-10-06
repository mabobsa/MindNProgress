import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

const fields = new Map([['agentId', 160], ['modelId', 160], ['thoughtLevel', 160], ['mode', 160], ['machineId', 120], ['proposalWorkspace', 2000]])
const invalid = () => Object.assign(new Error('제안 AI 설정의 종류·모델·사고 레벨을 확인해 주세요.'), { status: 400 })

export function validateDoorayResponseSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.has(key))) throw invalid()
  const result = {}
  for (const [key, limit] of fields) {
    if (value[key] == null) continue
    if (typeof value[key] !== 'string' || value[key].length > limit) throw invalid()
    if (value[key].trim()) result[key] = value[key].trim()
  }
  if (!result.agentId || !result.modelId) throw invalid()
  return result
}

export function doorayResponseSettingsFromResolved(settings) {
  return validateDoorayResponseSettings(Object.fromEntries([...fields.keys()].map((key) => [key, settings[key]])))
}

export async function createDoorayResponsePreferences({ dataDirectory, replaceFile = replaceFileWithRetry }) {
  const file = path.join(dataDirectory, '_dooray-response-preferences.json')
  let records = new Map()
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(stored)) throw new Error('제안 AI 설정 파일의 형식을 확인할 수 없습니다.')
    records = new Map(stored.map((entry) => {
      if (typeof entry?.userId !== 'string' || !entry.userId) throw new Error('제안 AI 설정의 계정 정보를 확인할 수 없습니다.')
      return [entry.userId, validateDoorayResponseSettings(entry.settings)]
    }))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let queue = Promise.resolve()
  const get = (userId) => records.has(userId) ? { ...records.get(userId) } : null
  const put = (userId, settings, { onlyIfUnset = false, expectedSettings } = {}) => {
    const checked = validateDoorayResponseSettings(settings)
    const operation = queue.then(async () => {
      if (onlyIfUnset && records.has(userId)) return get(userId)
      // 실행 준비 사이 다른 브라우저에서 저장한 새 선택을 이전 요청이 덮어쓰지 않는다.
      if (expectedSettings !== undefined && JSON.stringify(get(userId)) !== JSON.stringify(expectedSettings)) return get(userId)
      const next = new Map(records).set(userId, checked)
      await mkdir(dataDirectory, { recursive: true })
      const temporaryFile = `${file}.${randomBytes(5).toString('hex')}.tmp`
      try {
        await writeFile(temporaryFile, JSON.stringify([...next].map(([id, value]) => ({ userId: id, settings: value })), null, 2) + '\n', 'utf8')
        await replaceFile(temporaryFile, file)
      } catch (error) { await rm(temporaryFile, { force: true }).catch(() => {}); throw error }
      records = next
      return get(userId)
    })
    queue = operation.catch(() => {})
    return operation
  }
  return { get, put }
}
