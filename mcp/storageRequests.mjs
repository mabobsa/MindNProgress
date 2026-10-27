import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, writeFile, rename, link, rm } from 'node:fs/promises'
import path from 'node:path'
import { newStorageRequestId, storageDigest, validateStorageRequestId } from '../server/lib/storageJournal.mjs'
import { createStorageBudget } from '../server/lib/storageBudget.mjs'

export const storageWriteTools = new Set([
  'set_document_archive', 'submit_card_layout_proposal', 'submit_reconstruction_proposal', 'apply_reconstruction',
  'rollback_reconstruction', 'update_group_project', 'create_group_document', 'create_mindmap', 'add_card', 'update_card',
  'patch_card_text', 'apply_shared_knowledge_review', 'move_card', 'delete_card', 'manage_knowledge_line',
  'update_document_info', 'reorder_documents', 'save_document_layout', 'set_document_trash_state',
  'delete_trashed_documents', 'restore_history', 'manage_comment', 'mark_notifications_read',
].map((name) => `mindnprogress_${name}`))

// 첫 HTTP 전송 전에 실제 payload/read-set을 저장한다. 같은 논리 호출에서 최신 조건을 다시 만들지 않는다.
export function createMcpStorageRequests(directory) {
  const context = new AsyncLocalStorage()
  const current = () => context.getStore()
  const queues = new Map()
  async function save(scope) {
    await mkdir(directory, { recursive: true })
    const temporary = `${scope.file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(scope.record), 'utf8')
    await rename(temporary, scope.file)
  }
  async function run(name, input, identity, operation) {
    const startedAt = Date.now()
    const totalMs = /reconstruction|move_card/.test(name) ? 60_000 : 30_000
    const requestId = input.requestId ?? newStorageRequestId()
    validateStorageRequestId(requestId, Date.now(), true)
    if (input.resultOnly && !input.requestId) throw new Error('resultOnly에는 requestId가 필요합니다.')
    const { requestId: _id, resultOnly: _only, ...intent } = input
    const intentDigest = storageDigest({ name, intent })
    const file = path.join(directory, `${storageDigest({ requestId, identity })}.json`)
    const previous = queues.get(file) ?? Promise.resolve()
    let release
    const done = new Promise((resolve) => { release = resolve })
    const queued = previous.then(() => done)
    queues.set(file, queued)
    const waiting = createStorageBudget({ totalMs })
    try {
      await waiting.wait(() => previous, 'join')
      let record
      try { record = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!record) {
        try { record = JSON.parse(await readFile(`${file}.prepared`, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      const intentMismatch = !input.resultOnly && record && record.intentDigest !== intentDigest
      record ??= { requestId, intentDigest }
      record.deadlineAt ??= startedAt + totalMs
      const scope = { requestId, intentDigest: input.resultOnly ? '' : intentDigest, intentMismatch, file, record, identity, receipt: null,
        deadlineAt: input.resultOnly ? Date.now() + totalMs : record.deadlineAt, retries: 0 }
      return await context.run(scope, () => operation(scope))
    } finally {
      release()
      if (queues.get(file) === queued) void queued.then(() => { if (queues.get(file) === queued) queues.delete(file) })
      waiting.finish('joined')
    }
  }
  async function prepare(pathname, init) {
    const scope = current()
    if (!scope) return { pathname, init }
    const prepared = { pathname, method: init.method, body: init.body, aiMapId: init.aiMapId, aiCardId: init.aiCardId }
    if (scope.record.prepared) return { pathname: scope.record.prepared.pathname, init: { ...init, ...scope.record.prepared } }
    scope.record.prepared = prepared
    await mkdir(directory, { recursive: true })
    const temporary = `${scope.file}.${process.pid}.prepare.tmp`
    try {
      await writeFile(temporary, JSON.stringify(scope.record), { encoding: 'utf8', mode: 0o600 })
      try { await link(temporary, `${scope.file}.prepared`) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        const winner = JSON.parse(await readFile(`${scope.file}.prepared`, 'utf8'))
        if (winner.intentDigest !== scope.intentDigest) throw Object.assign(new Error('REQUEST_ID_REUSED'), { code: 'REQUEST_ID_REUSED', reasonCode: 'REQUEST_ID_REUSED' })
        scope.record = winner
        scope.deadlineAt = winner.deadlineAt ?? scope.deadlineAt
        scope.canonicalResponse = true
      }
    } finally { await rm(temporary, { force: true }) }
    return { pathname: scope.record.prepared.pathname, init: { ...init, ...scope.record.prepared } }
  }
  return { current, run, prepare, save }
}
