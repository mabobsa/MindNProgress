import { AsyncLocalStorage } from 'node:async_hooks'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

// 02의 프로세스 내 prepare/commit/rollback 경계. 04의 영속 journal은 이 경계에 연결한다.
// 권위 파일을 모두 준비한 뒤 교체하고, 겹치는 읽기/쓰기는 같은 자원 잠금으로 차단한다.
export function createStorageChanges({ root, resources, keyForFile, invalidate = () => {}, io = fs, beforeApply = async () => {} }) {
  const context = new AsyncLocalStorage()
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
  async function run(operation) {
    if (current()) return operation(current())
    const scope = { active: true, files: new Map(), directories: new Set(), undo: [], effects: [], response: null, rejected: false }
    return context.run(scope, async () => {
      let result
      const prepared = []
      const applied = []
      try {
        result = await operation(scope)
        if (scope.rejected) { for (const undo of scope.undo.reverse()) undo(); return result }
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
      } catch (error) {
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
      for (const effect of scope.effects) {
        try { await effect() } catch (error) { console.error('[Storage after commit]', error) }
      }
      return result
    })
  }
  return { run, current, stage, readFile, writeFile, readdir, stat, rm, replaceFile,
    has: (file) => current()?.files.has(path.resolve(file)) ?? false,
    onRollback: (undo) => { current()?.undo.push(undo) },
    afterCommit: (effect) => { const scope = current(); if (!scope) return false; scope.effects.push(effect); return true },
    deferResponse: (status, effect) => { const scope = current(); if (!scope) return false; scope.rejected ||= status >= 400; scope.response = effect; return true },
    detached: (operation) => context.run(null, operation),
  }
}
