import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

export const storagePhase = channel('mindnprogress.storage.phase')
export const storageHash = (bytes) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex')
export const canonicalStorageValue = (value) => Array.isArray(value) ? value.map(canonicalStorageValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalStorageValue(value[key])])) : value
export const storageDigest = (value) => storageHash(JSON.stringify(canonicalStorageValue(value)))
export const newStorageRequestId = (now = Date.now()) => `mnpw:${now}:${randomBytes(16).toString('hex')}`
const day = 86_400_000
export function storageRequestError(code, status, outcome = 'not-applied') {
  return Object.assign(new Error(code), { code, status, outcome, retryable: false })
}
export function validateStorageRequestId(id, now = Date.now(), known = false) {
  const match = /^mnpw:(\d{13}):([a-f0-9]{32})$/.exec(id ?? '')
  if (!match) throw storageRequestError('REQUEST_ID_INVALID', 400)
  const created = Number(match[1])
  if (!known && created < now - day) throw storageRequestError('REQUEST_EXPIRED', 410, 'unknown')
  if (!known && created > now + 300_000) throw storageRequestError('REQUEST_TIME_INVALID', 400)
  return created
}

// journal이 결과의 원본이다. 메모리 인덱스는 시작 시 journal에서 다시 만든다.
export function createStorageJournal({ root, resources, keyForFile, invalidate = () => {}, io = fs, now = Date.now,
  phase = async (name, detail) => storagePhase.publish({ name, ...detail }) }) {
  const base = path.resolve(root)
  const directory = path.join(base, '_storage-transactions')
  const records = new Map()
  const requests = new Map()
  const inflight = new Map()
  const applying = new Set()
  let visibilityEpoch = 0
  const beginApply = (record) => { for (const entry of record.files) applying.add(entry.key); visibilityEpoch++ }
  const endApply = (record) => { for (const entry of record.files) applying.delete(entry.key); visibilityEpoch++ }
  const transactionId = (requestId) => requestId ? `request-${storageHash(requestId)}` : `transaction-${randomBytes(16).toString('hex')}`
  const effectTransactionId = (id) => `effect-${storageHash(id)}`
  function location(id, file) {
    if (!/^(request|transaction|effect)-[a-f0-9]{32,64}$/.test(id)) throw new Error('INVALID_TRANSACTION_ID')
    return path.join(directory, id, file)
  }
  function target(relative) {
    if (!relative || relative.includes('\\') || relative.split('/').some((part) => !part || part === '..' || part === '.')
      || relative.startsWith('_storage-transactions/') || path.isAbsolute(relative) || relative.includes(':')) throw new Error('INVALID_JOURNAL_PATH')
    const file = path.resolve(base, relative)
    if (path.relative(base, file).startsWith('..')) throw new Error('INVALID_JOURNAL_PATH')
    return file
  }
  async function optional(file) {
    try { return await io.readFile(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  async function readJson(file) { const bytes = await optional(file); return bytes === null ? null : JSON.parse(bytes) }
  async function atomic(file, value) {
    await io.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await io.writeFile(temporary, typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`)
      const handle = await io.open(temporary, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      await replaceFileWithRetry(temporary, file)
    } finally { await io.rm(temporary, { force: true }).catch(() => {}) }
  }
  const register = (record) => {
    records.set(record.transactionId, record)
    if (record.request?.requestId) requests.set(record.request.requestId, record)
    return record
  }
  function pending(record) { return (record?.effects ?? []).filter((effect) => !record.effectsDone?.includes(effect.id)).map((effect) => effect.id) }
  function result(record, replayed = true) {
    if (!record.terminalAt) return { status: record.recoveryRequired ? 503 : 202, body: {
      outcome: 'processing', requestId: record.request?.requestId, transactionId: record.transactionId,
      code: record.recoveryRequired ? 'RECOVERY_REQUIRED' : 'REQUEST_PROCESSING', retryAfterMs: 250,
    } }
    const response = record.response ?? { status: 200, body: {} }
    return { ...response, body: { ...response.body,
      ...(response.body?.requestId && response.body.requestId !== record.request?.requestId ? { proposalRequestId: response.body.requestId } : {}),
      requestId: record.request?.requestId,
      transactionId: record.transactionId, outcome: record.rejected ? 'not-applied' : 'committed', replayed,
      ...(record.rejected ? { reasonCode: response.body?.reasonCode ?? response.body?.code ?? 'REQUEST_REJECTED', retryable: false } : {
        resources: record.resultResources ?? [], sideEffectsPending: pending(record),
      }) } }
  }
  function lookup(request, resultOnly = false) {
    const record = requests.get(request.requestId) ?? inflight.get(request.requestId)
    validateStorageRequestId(request.requestId, now(), Boolean(record))
    if (record) {
      if (storageDigest(record.request.scope) !== storageDigest(request.scope)) throw storageRequestError('REQUEST_NOT_FOUND', 404)
      if (request.intentDigest && record.request.intentDigest !== request.intentDigest) throw storageRequestError('REQUEST_ID_REUSED', 409)
      if (!resultOnly && record.request.digest !== request.digest) throw storageRequestError('REQUEST_ID_REUSED', 409)
      return result(record)
    }
    if (resultOnly) throw storageRequestError('REQUEST_UNKNOWN', 404, 'unknown')
    const reservation = { transactionId: transactionId(request.requestId), request }
    inflight.set(request.requestId, reservation)
    return null
  }
  function release(request) { if (request) inflight.delete(request.requestId) }
  async function apply(record) {
    const files = []
    // 전수 조건 검사 뒤 redo한다. 임의의 다른 정본을 한 파일이라도 발견하면 덮지 않는다.
    for (const entry of record.files) {
      const file = target(entry.path)
      if (keyForFile(file) !== entry.key) throw new Error('JOURNAL_RESOURCE_MISMATCH')
      const actual = storageHash(await optional(file))
      if (actual !== entry.before && actual !== entry.after) throw new Error('JOURNAL_HASH_MISMATCH')
      const bytes = entry.image ? await io.readFile(location(record.transactionId, entry.image)) : null
      if (storageHash(bytes) !== entry.after) throw new Error('JOURNAL_IMAGE_MISMATCH')
      files.push({ entry, file, bytes, actual })
    }
    for (let index = 0; index < files.length; index++) {
      const { entry, file, bytes, actual } = files[index]
      await phase('before-file', { transactionId: record.transactionId, index, file })
      if (actual !== entry.after) {
        if (bytes === null) await io.rm(file, { force: true })
        else await atomic(file, bytes)
      }
      invalidate(file)
      await phase('after-file', { transactionId: record.transactionId, index, file })
    }
    for (const relative of record.directories ?? []) {
      try { await io.rmdir(target(relative)) } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
    }
    await phase('before-applied', { transactionId: record.transactionId })
    const applied = { terminalAt: now() }
    await atomic(location(record.transactionId, 'applied.json'), applied)
    Object.assign(record, applied)
    endApply(record)
    await phase('after-applied', { transactionId: record.transactionId })
  }
  function quarantine(record) {
    record.recoveryRequired = true
    resources.quarantine(record.keys)
    return Object.assign(storageRequestError('RECOVERY_REQUIRED', 503, 'processing'), { transactionId: record.transactionId })
  }
  async function commit(scope) {
    const id = scope.transactionId
    const files = [...scope.files].filter(([, e]) => storageHash(e.before) !== storageHash(e.after))
    const keys = [...new Set([...files.map(([file]) => keyForFile(file)), ...scope.keys])]
    const record = { schemaVersion: 1, transactionId: id, request: scope.request ?? null, createdAt: now(), keys,
      files: [], directories: [...scope.directories].map((file) => path.relative(base, file).replaceAll('\\', '/')),
      response: scope.responseData, effects: scope.durableEffects, resultResources: [] }
    let committed = false
    try {
      await phase('before-intent', { transactionId: id })
      for (let index = 0; index < files.length; index++) {
        const [file, entry] = files[index]
        const relative = path.relative(base, file).replaceAll('\\', '/')
        target(relative)
        const image = entry.after === null ? null : `image-${index}`
        if (image) await atomic(location(id, image), entry.after)
        record.files.push({ path: relative, key: keyForFile(file), before: storageHash(entry.before), after: storageHash(entry.after), image })
        let value
        try { value = JSON.parse(entry.after) } catch { /* 바이너리와 삭제는 해시로 식별한다. */ }
        record.resultResources.push({ resource: keyForFile(file), path: relative, sha256: storageHash(entry.after),
          ...(value?.version === undefined ? {} : { version: value.version }),
          ...(value?.lifecycleVersion === undefined ? {} : { lifecycleVersion: value.lifecycleVersion }) })
        if (relative === '_document-lifecycle.json' && value?.documents) {
          const before = entry.before ? JSON.parse(entry.before).documents ?? {} : {}
          for (const [mapId, metadata] of Object.entries(value.documents)) {
            if (storageDigest(before[mapId] ?? null) === storageDigest(metadata)) continue
            const mapFile = target(`${mapId}.json`)
            const content = scope.files.get(mapFile)?.after ?? await optional(mapFile)
            const map = content ? JSON.parse(content) : null
            record.resultResources.push({ resource: `doc:${mapId}`, path: relative, mapId,
              version: map?.version ?? null, lifecycleVersion: metadata.lifecycleVersion ?? 0, sha256: storageDigest(metadata) })
          }
        }
      }
      const lifecycleFile = path.join(base, '_document-lifecycle.json')
      const lifecycleBytes = scope.files.get(lifecycleFile)?.after ?? await optional(lifecycleFile)
      const lifecycle = lifecycleBytes ? JSON.parse(lifecycleBytes).documents ?? {} : {}
      for (const resource of record.resultResources) if (resource.path === `${resource.resource.slice(4)}.json` && resource.resource.startsWith('doc:')) {
        resource.lifecycleVersion = lifecycle[resource.resource.slice(4)]?.lifecycleVersion ?? 0
      }
      await atomic(location(id, 'intent.json'), record)
      await phase('after-intent', { transactionId: id })
      await phase('before-commit', { transactionId: id })
      const marker = { schemaVersion: 1, intentSha256: storageDigest(record) }
      try { await atomic(location(id, 'commit.json'), marker) }
      catch (error) {
        // rename이 성공한 뒤 오류가 전달될 수도 있다. 유효 marker를 재확인한다.
        let actual
        try { actual = await readJson(location(id, 'commit.json')) } catch { register(record); throw quarantine(record) }
        if (actual?.intentSha256 !== marker.intentSha256) throw error
      }
      committed = true
      register(record)
      beginApply(record)
      await phase('after-commit', { transactionId: id })
      try { await apply(record) }
      catch {
        // 일시 I/O 실패는 잠금을 유지한 채 한 번 redo한다. marker 뒤 rollback은 없다.
        try { await apply(record) } catch { throw quarantine(record) }
      }
      return record
    } catch (error) {
      if (committed) {
        if (record.terminalAt) return record
        throw quarantine(record)
      }
      if (!committed && error.outcome !== 'processing') await io.rm(location(id, ''), { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
  async function reject(scope) {
    const record = { schemaVersion: 1, transactionId: scope.transactionId, request: scope.request,
      response: scope.responseData, rejected: true, terminalAt: now(), effects: [], files: [], keys: scope.keys }
    await atomic(location(record.transactionId, 'terminal.json'), record)
    return register(record)
  }
  async function recover() {
    await io.mkdir(directory, { recursive: true })
    for (const entry of await io.readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      const terminal = await readJson(location(id, 'terminal.json'))
      if (terminal) { register(terminal); continue }
      const marker = await readJson(location(id, 'commit.json'))
      if (!marker) { await io.rm(location(id, ''), { recursive: true, force: true }); continue }
      const record = await readJson(location(id, 'intent.json'))
      if (!record || record.transactionId !== id || marker.intentSha256 !== storageDigest(record)) throw new Error('JOURNAL_CORRUPT')
      register(record)
      const applied = await readJson(location(id, 'applied.json'))
      if (applied) Object.assign(record, applied)
      else { beginApply(record); try { await apply(record) } catch { quarantine(record) } }
      record.effectsDone = (await readJson(location(id, 'effects.json')))?.done ?? []
    }
    return [...records.values()]
  }
  async function effectDone(record, id) {
    const done = [...new Set([...(record.effectsDone ?? []), id])]
    await atomic(location(record.transactionId, 'effects.json'), { done })
    record.effectsDone = done
  }
  async function cleanup() {
    for (const record of records.values()) {
      if (!record.terminalAt || pending(record).length || now() - record.terminalAt < day) continue
      if (record.request && validateStorageRequestId(record.request.requestId, now(), true) >= now() - day) continue
      // 후속 effect 기록은 부모가 사라질 때 함께 정리한다.
      if (record.transactionId.startsWith('effect-')) continue
      await io.rm(location(record.transactionId, ''), { recursive: true, force: true })
      records.delete(record.transactionId)
      if (record.request) requests.delete(record.request.requestId)
      for (const effect of record.effects ?? []) {
        const effectId = effectTransactionId(effect.id)
        await io.rm(location(effectId, ''), { recursive: true, force: true })
        records.delete(effectId)
      }
    }
  }
  return { commit, reject, recover, lookup, release, result, records, pending, effectDone, cleanup, transactionId, effectTransactionId, phase,
    visibilityEpoch: () => visibilityEpoch, isApplying: (key) => applying.has(key) }
}
