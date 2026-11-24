import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rm, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

const execute = promisify(execFile)
export const REMOTE_WORKSPACE_VERSION = 2
export const ARTIFACT_CHUNK_BYTES = 256 * 1024
export const REMOTE_WORKSPACE_ACTIONS = new Set(['prepare', 'bind', 'reuse', 'checkpoint', 'seal', 'release', 'quarantine', 'recover',
  'integrate-prepare', 'integrate-complete'])
// 원격 통합 충돌 해결 회차별 산출물이다. integration은 메인 → Fork, candidate는 Fork → 메인 방향으로만 쓴다.
export const REMOTE_INTEGRATION_ROUND_LIMIT = 99
export function remoteArtifactKind(kind) {
  if (['baseline', 'result', 'release'].includes(kind)) return { kind, base: kind, round: null }
  const match = /^(integration|candidate)-([1-9][0-9]?)$/.exec(String(kind ?? ''))
  if (!match) throw workspaceError('REMOTE_ARTIFACT_KIND_INVALID')
  return { kind, base: match[1], round: Number(match[2]) }
}

export function workspaceError(code, message = code) {
  return Object.assign(new Error(message), { code, reasonCode: code, status: 409 })
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) throw workspaceError('REMOTE_WORKSPACE_ID_INVALID')
  return value
}

export function commitId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw workspaceError('REMOTE_WORKSPACE_COMMIT_INVALID')
  return value
}

export function stableHash(value) {
  const canonical = (item) => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export async function jsonFile(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
  await replaceFileWithRetry(temporary, file)
  if (process.platform !== 'win32') {
    const directory = await open(path.dirname(file), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}

export async function git(root, args, { timeoutMs = 120_000 } = {}) {
  const { stdout } = await execute('git', ['--no-optional-locks', '-C', root, ...args], {
    timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return stdout.trimEnd()
}

export async function hasCommit(root, value) {
  commitId(value)
  try { await git(root, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]); return true } catch (error) {
    if (error.code === 1) return false
    throw error
  }
}

// This lock is intentionally never stolen after a timeout or process restart.
// An interrupted mutation requires inspection of its durable receipt and Git state.
export async function acquireWorkspaceLock(root) {
  const directory = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'mnp-workspace-lock']))
  if (path.basename(directory) !== 'mnp-workspace-lock') throw workspaceError('REMOTE_WORKSPACE_LOCK_PATH_INVALID')
  try { await mkdir(directory) } catch (error) {
    if (error.code === 'EEXIST') throw workspaceError('REMOTE_WORKSPACE_LOCKED')
    throw error
  }
  return () => rm(directory, { recursive: true, force: true })
}
export async function workspaceLock(root, operation) {
  const release = await acquireWorkspaceLock(root)
  try { return await operation() } finally { await release() }
}

export async function workerRoot(root) {
  const resolved = await realpath(root)
  if (await realpath(await git(resolved, ['rev-parse', '--show-toplevel'])) !== resolved) {
    throw workspaceError('REMOTE_WORKSPACE_ROOT_INVALID')
  }
  return resolved
}

export function ownershipMatches(expected, actual) {
  return Boolean(expected && actual) && ['coordinatorId', 'machineId', 'poolId', 'generation']
    .every((key) => expected[key] === actual[key])
}

export function assignmentMatches(expected, actual) {
  return ownershipMatches(expected?.ownership, actual?.ownership)
    && ['workspaceId', 'jobId', 'leaseId', 'projectRoot', 'branch', 'baseCommit', 'baselineCommit', 'baselineMode']
      .every((key) => expected?.[key] === actual?.[key])
}
