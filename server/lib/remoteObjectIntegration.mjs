import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { commitId, git, workspaceError } from './remoteWorkspaceProtocol.mjs'

// 원격 Fork 결과를 메인에 통합할 때 메인 서버에서는 작업 트리를 만들지 않는다.
// 통합 저장소의 객체를 빌려 쓰는 bare 저장소에서 Git 객체만으로 후보 커밋을 만들고,
// 메인 작업 트리에는 마지막 fast-forward로 바뀐 파일만 쓴다.
const execute = promisify(execFile)
export const LONG_GIT_TIMEOUT_MS = 600_000
const objectId = (value) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value)) throw workspaceError('REMOTE_INTEGRATION_OBJECT_INVALID')
  return value
}

async function gitRaw(root, args, { env, timeoutMs = 120_000 } = {}) {
  const { stdout } = await execute('git', ['--no-optional-locks', '-C', root, ...args], {
    timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
  })
  return stdout
}

// lease마다 쓰는 작업 트리 없는 저장소를 연다. 통합 저장소의 객체는 복사하지 않고 alternates로 참조한다.
export async function openIntegrationStore(store, integrationRoot) {
  const commonDir = await git(integrationRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const exists = await stat(path.join(store, 'HEAD')).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
  if (!exists) {
    await mkdir(path.dirname(store), { recursive: true })
    await execute('git', ['init', '--bare', '--quiet', store], { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  }
  const alternates = path.join(store, 'objects', 'info', 'alternates')
  await mkdir(path.dirname(alternates), { recursive: true })
  await writeFile(alternates, `${path.join(commonDir, 'objects').replaceAll('\\', '/')}\n`)
  return store
}

// bundle을 검증한 뒤 지정한 ref로 가져온다. 작업 트리와 index는 만들지 않는다.
export async function fetchBundle(store, bundleFile, sourceRef, targetRef) {
  await git(store, ['bundle', 'verify', bundleFile])
  await git(store, ['fetch', '--no-tags', '--force', bundleFile, `+${sourceRef}:${targetRef}`], { timeoutMs: LONG_GIT_TIMEOUT_MS })
  return commitId(await git(store, ['rev-parse', '--verify', `${targetRef}^{commit}`]))
}

// 기준 커밋부터 직선으로 이어진 커밋만 받는다. 병합 커밋이 섞이면 cherry-pick과 같은 재적용을 보장하지 못한다.
export async function linearCommits(store, base, head) {
  commitId(base); commitId(head)
  if (base === head) return []
  try { await git(store, ['merge-base', '--is-ancestor', base, head]) } catch (error) {
    if (error.code === 1) throw workspaceError('REMOTE_INTEGRATION_HISTORY_INVALID', '원격 결과가 기준 커밋에서 이어지지 않아 통합하지 않았습니다.')
    throw error
  }
  const lines = (await git(store, ['rev-list', '--topo-order', '--reverse', '--parents', `${base}..${head}`])).split('\n').filter(Boolean)
  const commits = []
  let previous = base
  for (const line of lines) {
    const [commit, ...parents] = line.trim().split(/\s+/)
    if (parents.length !== 1 || parents[0] !== previous) {
      throw workspaceError('REMOTE_INTEGRATION_HISTORY_INVALID', '원격 결과 이력이 기준 커밋에서 직선으로 이어지지 않아 통합하지 않았습니다.')
    }
    commits.push(commitId(commit)); previous = commit
  }
  if (previous !== head) throw workspaceError('REMOTE_INTEGRATION_HISTORY_INVALID', '원격 결과 이력의 끝이 봉인된 HEAD와 다릅니다.')
  return commits
}

// 통합 저장소에 설정된 신원을 커밋한 사람으로 쓴다. 설정이 없으면 원 커밋의 신원을 그대로 쓴다.
export async function committerIdentity(integrationRoot) {
  const read = (key) => git(integrationRoot, ['config', '--get', key]).catch((error) => { if (error.code === 1) return ''; throw error })
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  return name && email ? { name, email } : null
}

async function mergeTree(store, base, ours, theirs) {
  try {
    const output = await git(store, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs])
    return { conflict: false, tree: objectId(output.split('\n')[0].trim()) }
  } catch (error) {
    if (error.code !== 1) throw error
    const lines = String(error.stdout ?? '').split('\n').map((line) => line.trim())
    objectId(lines[0])
    return { conflict: true, paths: [...new Set(lines.slice(1).filter(Boolean))].sort() }
  }
}

function signature(header, kind) {
  const match = new RegExp(`^${kind} (.*) <([^>]*)> (\\d+ [+-]\\d{4})$`).exec(header ?? '')
  if (!match) throw workspaceError('REMOTE_INTEGRATION_COMMIT_INVALID', '원 커밋의 작성자 정보를 읽지 못했습니다.')
  return { name: match[1], email: match[2], date: match[3] }
}

async function commitTree(store, tree, parent, source, committer) {
  const raw = await gitRaw(store, ['cat-file', 'commit', source])
  const split = raw.indexOf('\n\n')
  const headers = (split < 0 ? raw : raw.slice(0, split)).split('\n')
  const encoding = headers.find((line) => line.startsWith('encoding '))
  if (encoding && !/^encoding utf-?8$/i.test(encoding)) throw workspaceError('REMOTE_INTEGRATION_COMMIT_INVALID', '원 커밋 메시지의 인코딩을 유지할 수 없어 통합하지 않았습니다.')
  const author = signature(headers.find((line) => line.startsWith('author ')), 'author')
  const original = signature(headers.find((line) => line.startsWith('committer ')), 'committer')
  const messageFile = path.join(store, `mnp-message-${randomUUID()}`)
  await writeFile(messageFile, split < 0 ? '' : raw.slice(split + 2))
  try {
    const output = await gitRaw(store, ['commit-tree', tree, '-p', parent, '-F', messageFile], { env: {
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
      GIT_COMMITTER_NAME: committer?.name ?? original.name, GIT_COMMITTER_EMAIL: committer?.email ?? original.email,
    } })
    return commitId(output.trim())
  } finally { await rm(messageFile, { force: true }) }
}

// 각 커밋을 cherry-pick과 같은 3-way tree 병합으로 메인 위에 다시 쌓는다.
// 이미 메인에 같은 변경이 있어 빈 커밋이 되는 경우는 쌓지 않고 기록만 남긴다.
export async function replayCommits(store, commits, onto, { committer = null } = {}) {
  let previous = commitId(onto)
  const created = [], dropped = []
  for (const commit of commits) {
    const parent = await git(store, ['rev-parse', '--verify', `${commit}^`])
    const merged = await mergeTree(store, parent, previous, commit)
    if (merged.conflict) return { conflict: true, commit, unmergedFiles: merged.paths }
    if (merged.tree === await git(store, ['rev-parse', '--verify', `${previous}^{tree}`])) { dropped.push(commit); continue }
    previous = await commitTree(store, merged.tree, previous, commit, committer)
    created.push(previous)
  }
  return { conflict: false, head: previous, commits: created, dropped }
}

// 메인 쪽 커밋 구간을 Fork에 보낼 bundle로 만든다. 임시 ref는 작업 트리 없는 저장소에만 둔다.
export async function createRangeBundle(store, file, base, head, ref) {
  await git(store, ['update-ref', ref, commitId(head)])
  await mkdir(path.dirname(file), { recursive: true })
  await git(store, ['bundle', 'create', file, `${commitId(base)}..${ref}`], { timeoutMs: LONG_GIT_TIMEOUT_MS })
}

export async function isAncestor(root, ancestor, descendant) {
  try { await git(root, ['merge-base', '--is-ancestor', ancestor, descendant]); return true } catch (error) {
    if (error.code === 1) return false
    throw error
  }
}
