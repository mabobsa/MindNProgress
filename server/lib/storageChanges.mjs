import { AsyncLocalStorage } from 'node:async_hooks'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

// 후보 집합과 메모리 복구를 소유한다. journal을 사용하면 marker 이후에는 redo만 허용한다.
export function createStorageChanges({ root, resources, keyForFile, invalidate = () => {}, io = fs, beforeApply = async () => {}, journal = null }) {
  const context = new AsyncLocalStorage()
  const effectHandlers = new Map()
  const effectRuns = new Set()
  const base = path.resolve(root)
  const current = () => { const value = context.getStore(); return value?.active ? value : null }
  function checked(file) {
    const absolute = path.resolve(file)
    const relative = path.relative(base, absolute)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('STORAGE_PATH_OUTSIDE_ROOT')
    resources.assert(keyForFile(absolute))
    return absolute
  }
  async function optional(file) {
    try { return await io.readFile(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  function missing(file) { return Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }) }
  async function readFile(file, options) {
    const entry = current()?.files.get(path.resolve(file))
    if (!entry) return io.readFile(file, options)
    if (entry.after === null) throw missing(file)
    const encoding = typeof options === 'string' ? options : options?.encoding
    return encoding ? entry.after.toString(encoding) : Buffer.from(entry.after)
  }
  async function stage(file, content) {
    const scope = current()
    if (!scope) throw new Error('STORAGE_CHANGE_REQUIRED')
    const absolute = checked(file)
    const previous = scope.files.get(absolute)
    const before = previous ? previous.before : await optional(absolute)
    scope.files.set(absolute, { before, after: content === null ? null : Buffer.from(content) })
    invalidate(absolute)
  }
  async function replaceFile(temporary, target) {
    if (!current()) return replaceFileWithRetry(temporary, target)
    try { await stage(target, await io.readFile(temporary)) } finally { await io.rm(temporary, { force: true }) }
  }
  async function writeFile(file, content, options) {
    // 일반 임시 파일은 후보 생성용이다. 자산의 wx 생성도 공동 변경 후보에 포함한다.
    if (!current() || String(file).endsWith('.tmp')) return io.writeFile(file, content, options)
    if ((typeof options === 'object' ? options.flag : '')?.includes('x')) {
      try { await readFile(file); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return stage(file, Buffer.isBuffer(content) ? content : Buffer.from(content, typeof options === 'string' ? options : options?.encoding ?? 'utf8'))
  }
  async function readdir(directory, options) {
    let entries
    try { entries = await io.readdir(directory, { withFileTypes: true }) }
    catch (error) { if (error.code !== 'ENOENT' || !current()) throw error; entries = [] }
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    for (const [file, entry] of current()?.files ?? []) {
      if (path.dirname(file) !== path.resolve(directory)) continue
      const name = path.basename(file)
      if (entry.after === null) byName.delete(name)
      else if (!byName.has(name)) byName.set(name, { name, isFile: () => true, isDirectory: () => false })
    }
    return options?.withFileTypes ? [...byName.values()] : [...byName.keys()]
  }
  async function stat(file, options) {
    const entry = current()?.files.get(path.resolve(file))
    if (!entry) return io.stat(file, options)
    if (entry.after === null) throw missing(file)
    return { size: entry.after.length, isFile: () => true, isDirectory: () => false }
  }
  async function rm(file, options = {}) {
    if (!current() || String(file).endsWith('.tmp')) return io.rm(file, options)
    if (options.recursive) {
      const directory = checked(file)
      const entries = await readdir(file, { withFileTypes: true })
      for (const entry of entries) await rm(path.join(file, entry.name), { ...options, recursive: entry.isDirectory() })
      current().directories.add(directory)
    } else await stage(file, null)
  }
  async function restore(file, content) {
    if (content === null) return io.rm(file, { force: true })
    await io.mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
    await io.writeFile(temporary, content)
    await replaceFileWithRetry(temporary, file)
  }
  async function resumeEffects(record) {
    if (!record?.terminalAt || record.rejected || effectRuns.has(record.transactionId)) return
    effectRuns.add(record.transactionId)
    try {
    for (const effect of record.effects ?? []) {
      if (record.effectsDone?.includes(effect.id)) continue
      try {
        const handler = effectHandlers.get(effect.kind)
        if (!handler) throw new Error(`UNKNOWN_STORAGE_EFFECT: ${effect.kind}`)
        // SSE는 데이터 RMW가 아니다. 재발행할 수 있는 안정 ID와 부모의 완료 기록만 필요하다.
        if (effect.kind === 'sse') {
          await handler.run(effect.payload, effect.id)
          await journal.effectDone(record, effect.id)
          continue
        }
        const transactionId = journal.effectTransactionId(effect.id)
        const existing = journal.records.get(transactionId)
        if (existing && !existing.terminalAt) throw new Error('EFFECT_RECOVERY_REQUIRED')
        if (!existing) {
          const keys = handler.keys(effect.payload)
          // 잠금 문맥은 재사용하되 부모의 보유 키를 후속 효과의 복구 범위에 넣지 않는다.
          await resources.withResources(keys, () => run(() => handler.run(effect.payload, effect.id), {
            transactionId, effectKind: effect.kind, effectId: effect.id,
            keys: keys.map((item) => typeof item === 'string' ? item : item.key),
          }))
        }
        else await resumeEffects(existing)
        if (journal.pending(journal.records.get(transactionId)).length) throw new Error('NESTED_EFFECT_PENDING')
        await journal.effectDone(record, effect.id)
      } catch (error) { console.error('[Storage durable effect]', effect.id, error.code ?? error.message) }
    }
    } finally { effectRuns.delete(record.transactionId) }
  }
  async function run(operation, options = {}) {
    if (current()) return operation(current())
    const scope = { active: true, files: new Map(), directories: new Set(), undo: [], effects: [], durableEffects: [], response: null,
      responseData: null, rejected: false, keys: [...(resources.current()?.held.keys() ?? [])],
      transactionId: options.transactionId ?? journal?.transactionId(options.request?.requestId), ...options }
    return context.run(scope, async () => {
      let result
      const prepared = []
      const applied = []
      try {
        result = await operation(scope)
        if (scope.rejected) {
          for (const undo of scope.undo.reverse()) undo()
          if (journal && scope.request && scope.responseData?.status < 500) scope.record = await journal.reject(scope)
          return result
        }
        if (journal) {
          if (scope.files.size || scope.durableEffects.length || scope.request || scope.effectId) scope.record = await journal.commit(scope)
        } else {
        for (const [file, entry] of scope.files) {
          if (entry.after !== null && entry.before?.equals(entry.after) || entry.before === null && entry.after === null) continue
          let temporary = null
          if (entry.after !== null) {
            await io.mkdir(path.dirname(file), { recursive: true })
            temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
            prepared.push({ file, temporary, ...entry })
            await io.writeFile(temporary, entry.after)
          } else prepared.push({ file, temporary, ...entry })
        }
        for (let index = 0; index < prepared.length; index++) {
          const entry = prepared[index]
          await beforeApply({ index, file: entry.file, count: prepared.length })
          applied.push(entry)
          if (entry.after === null) await io.rm(entry.file, { force: true })
          else await replaceFileWithRetry(entry.temporary, entry.file)
        }
        for (const directory of scope.directories) {
          try { await io.rmdir(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
        }
        }
      } catch (error) {
        if (error.outcome === 'processing') throw error
        const failures = []
        for (const entry of applied.reverse()) {
          try { await restore(entry.file, entry.before) } catch (failure) { failures.push(failure) }
        }
        for (const undo of scope.undo.reverse()) undo()
        if (failures.length) {
          resources.quarantine([...scope.files.keys()].map(keyForFile))
          throw Object.assign(new AggregateError([error, ...failures], '저장 실패 후 복구가 완료되지 않았습니다.'), { code: 'RECOVERY_REQUIRED', status: 503, storageResourceError: true })
        }
        throw error
      } finally {
        scope.active = false
        for (const { temporary } of prepared) if (temporary) await io.rm(temporary, { force: true }).catch(() => {})
        for (const file of scope.files.keys()) invalidate(file)
      }
      if (journal && scope.record) await resumeEffects(scope.record)
      for (const effect of scope.effects) {
        try { await effect() } catch (error) { console.error('[Storage after commit]', error) }
      }
      return result
    })
  }
  return { run, current, stage, readFile, writeFile, readdir, stat, rm, replaceFile, resumeEffects,
    registerEffect: (kind, handler) => effectHandlers.set(kind, handler),
    effect: (kind, resource, payload) => {
      const scope = current()
      if (!journal || !scope || scope.effectKind === kind) return false
      const id = `${scope.transactionId}/${kind}/${resource}/${scope.durableEffects.length}`
      scope.durableEffects.push({ id, kind, payload: structuredClone(payload) })
      return true
    },
    has: (file) => current()?.files.has(path.resolve(file)) ?? false,
    onRollback: (undo) => { current()?.undo.push(undo) },
    afterCommit: (effect) => { const scope = current(); if (!scope) return false; scope.effects.push(effect); return true },
    deferResponse: (status, effect, body, headers) => { const scope = current(); if (!scope) return false; scope.rejected ||= status >= 400;
      scope.responseData = { status, body, headers }; scope.response = () => effect(scope.request && scope.record ? journal.result(scope.record, false) : null); return true },
    detached: (operation) => context.run(null, operation),
  }
}
