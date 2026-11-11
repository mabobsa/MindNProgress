import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const limit = 8 * 1024 * 1024
function unsafe(message) {
  throw Object.assign(new Error(message), { code: 'WORKSPACE_POOL_UNAVAILABLE', reasonCode: 'INTEGRATION_RECOVERY_UNSAFE' })
}
async function git(root, args) {
  const { stdout } = await exec('git', ['--no-optional-locks', ...args], {
    cwd: root, windowsHide: true, encoding: 'buffer', maxBuffer: limit, timeout: 30_000,
  })
  return stdout
}
async function gitText(root, args) { return (await git(root, args)).toString('utf8') }

export function normalizeTrackedEolRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['expectedHead', 'files'].includes(key))
    || !/^[a-f0-9]{40}$/.test(value.expectedHead ?? '') || !Array.isArray(value.files)
    || value.files.length < 1 || value.files.length > 64) unsafe('줄바꿈 복구에는 정확한 후보 HEAD와 1~64개 파일 승인이 필요합니다.')
  const files = value.files.map(file => {
    if (!file || Object.keys(file).some(key => !['path', 'expectedSha256'].includes(key))
      || typeof file.path !== 'string' || /[\\:*?[\]<>|]/.test(file.path)
      || [...file.path].some(char => char.charCodeAt(0) < 32)
      || file.path.split('/').some(segment => !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git' || /[. ]$/.test(segment))
      || !/^[a-f0-9]{64}$/.test(file.expectedSha256 ?? '')) unsafe('줄바꿈 복구 파일 경로 또는 원본 SHA-256이 올바르지 않습니다.')
    return { path: file.path, expectedSha256: file.expectedSha256 }
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) unsafe('줄바꿈 복구 경로가 중복됐습니다.')
  return { expectedHead: value.expectedHead, files }
}

async function regularPath(root, relative, allowMissing = false) {
  let current = root
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) unsafe('줄바꿈 복구 루트는 링크가 아닌 디렉터리여야 합니다.')
  const parts = relative.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    let info
    try { info = await lstat(current) } catch (error) {
      if (allowMissing && index === parts.length - 1 && error.code === 'ENOENT') return null
      throw error
    }
    if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) unsafe('줄바꿈 복구 경로에 링크 또는 일반 파일이 아닌 항목이 있습니다.')
    if (index === parts.length - 1 && info.size > limit) unsafe('줄바꿈 복구 파일이 크기 제한을 초과했습니다.')
  }
  return current
}

// 호출자는 먼저 lease·세션·source·부분 적용·sequencer를 검증한다.
// 명시적 결과 보존 반환 또는 중단된 충돌 해결 재개에만 사용한다. 일반 dirty 자동 정리는 금지한다.
export async function recoverTrackedCheckoutEol({ workerRoot, sharedRoot, lease, request, actor, persist,
  expectedHead = lease.result?.integrationFailureHeadCommit }) {
  let record = lease.trackedEolRecovery
  const plan = normalizeTrackedEolRecovery(request ?? record?.plan)
  if (plan.expectedHead !== expectedHead) unsafe('줄바꿈 복구 HEAD가 확인된 통합 후보와 다릅니다.')
  if (record && (record.leaseId !== lease.leaseId || record.sourceHead !== lease.headCommit
    || record.jobId !== lease.jobId || record.workspaceId !== lease.workspaceId
    || JSON.stringify(record.plan) !== JSON.stringify(plan)
    || !/^workspace-drift\/[a-zA-Z0-9_-]+\/eol-recovery-[a-f0-9]{24}$/.test(record.archiveRelative ?? '')
    || record.archiveRelative.split('/')[1] !== lease.workspaceId)) unsafe('줄바꿈 복구 기록 또는 승인 대상이 변경됐습니다.')
  if (record) {
    const metadataPath = await regularPath(sharedRoot, `${record.archiveRelative}/metadata.json`)
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    for (const key of ['plan', 'leaseId', 'jobId', 'workspaceId', 'sourceHead', 'files', 'actor']) {
      if (JSON.stringify(metadata[key]) !== JSON.stringify(record[key])) unsafe('줄바꿈 백업의 승인·귀속 기록이 변경됐습니다.')
    }
  }
  const assertState = async () => {
    const [head, branch, source] = await Promise.all([
      gitText(workerRoot, ['rev-parse', 'HEAD']), gitText(workerRoot, ['branch', '--show-current']),
      gitText(workerRoot, ['rev-parse', `refs/heads/${lease.branch}`]),
    ])
    if (head.trim() !== plan.expectedHead || branch.trim() !== lease.integrationBranch
      || source.trim() !== lease.headCommit) unsafe('줄바꿈 복구 중 브랜치 또는 HEAD가 변경됐습니다.')
    await Promise.all(['index.lock', 'CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REBASE_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].map(async entry => {
      const file = path.resolve(workerRoot, (await gitText(workerRoot, ['rev-parse', '--git-path', entry])).trim())
      try { await lstat(file); unsafe('줄바꿈 복구 중 Git 잠금 또는 다른 Git 작업을 발견했습니다.') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }))
    const statuses = (await gitText(workerRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0').filter(Boolean)
    if (statuses.some(row => !plan.files.some(file => file.path === row.slice(3))
      || !(row.startsWith(' M ') || (record && row.startsWith(' D '))))) unsafe('승인 대상 외 변경 또는 index 변경이 있어 줄바꿈 복구를 중단합니다.')
    if (!record && statuses.length !== plan.files.length) unsafe('승인한 전체 파일의 로컬 변경을 확인할 수 없습니다.')
  }
  await assertState()
  const inspected = []
  for (let index = 0; index < plan.files.length; index++) {
    const file = plan.files[index]
    const [tree, stage, attr] = await Promise.all([
      gitText(workerRoot, ['ls-tree', '-z', plan.expectedHead, '--', file.path]),
      gitText(workerRoot, ['ls-files', '--stage', '-z', '--', file.path]),
      gitText(workerRoot, ['check-attr', '-z', 'text', '--', file.path]),
    ])
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t/.exec(tree)
    if (!match || stage !== `${match[1]} ${match[2]} 0\t${file.path}\0`) unsafe('줄바꿈 복구 index가 후보의 일반 파일과 일치하지 않습니다.')
    if (attr !== `${file.path}\0text\0unset\0`) unsafe('줄바꿈 복구는 -text 속성이 확인된 파일만 지원합니다.')
    const canonical = await git(workerRoot, ['cat-file', 'blob', match[2]])
    const text = canonical.toString('utf8')
    if (!Buffer.from(text).equals(canonical) || text.includes('\0') || text.includes('\r') || !text.includes('\n')) unsafe('후보 파일은 UTF-8 LF 텍스트여야 합니다.')
    const original = Buffer.from(text.replaceAll('\n', '\r\n'))
    if (sha256(original) !== file.expectedSha256) unsafe('승인한 원문이 후보 파일과 CRLF 줄바꿈만 다른지 확인할 수 없습니다.')
    const target = await regularPath(workerRoot, file.path, Boolean(record))
    const current = target ? await readFile(target) : null
    if ((!record && !current?.equals(original)) || (record && current && !current.equals(original) && !current.equals(canonical))) unsafe('줄바꿈 외 내용 또는 승인한 원본 해시가 변경됐습니다.')
    if (record) {
      const backup = await regularPath(sharedRoot, `${record.archiveRelative}/original-${index}`)
      if (!(await readFile(backup)).equals(original)) unsafe('줄바꿈 복구 원본 백업이 변경됐습니다.')
      if (!current) {
        const removed = await regularPath(sharedRoot, `${record.archiveRelative}/removed-${index}`)
        if (!(await readFile(removed)).equals(original)) unsafe('중단된 줄바꿈 복구의 이동 원문을 확인할 수 없습니다.')
      }
    }
    inspected.push({ ...file, canonical, original, current, index, mode: Number.parseInt(match[1].slice(-3), 8) })
  }
  if (!record) {
    const archiveRelative = `workspace-drift/${lease.workspaceId}/eol-recovery-${randomBytes(12).toString('hex')}`
    await mkdir(path.join(sharedRoot, archiveRelative), { recursive: true })
    for (const file of inspected) {
      await regularPath(sharedRoot, `${archiveRelative}/original-${file.index}`, true)
      await writeFile(path.join(sharedRoot, archiveRelative, `original-${file.index}`), file.original, { flag: 'wx' })
      if (!(await readFile(path.join(sharedRoot, archiveRelative, `original-${file.index}`))).equals(file.original)) unsafe('줄바꿈 원본 백업의 바이트 검증에 실패했습니다.')
    }
    record = { schemaVersion: 1, phase: 'preserved', plan, archiveRelative,
      leaseId: lease.leaseId, jobId: lease.jobId, workspaceId: lease.workspaceId, sourceHead: lease.headCommit,
      actor, preservedAt: new Date().toISOString(),
      files: inspected.map(file => ({ path: file.path, originalSha256: file.expectedSha256, canonicalSha256: sha256(file.canonical) })) }
    await writeFile(path.join(sharedRoot, archiveRelative, 'metadata.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    lease.trackedEolRecovery = record
    await persist()
  }
  await assertState()
  for (const file of inspected) {
    const target = await regularPath(workerRoot, file.path, true)
    const current = target ? await readFile(target) : null
    if (current?.equals(file.canonical)) continue
    if (current && !current.equals(file.original)) unsafe('정리 직전에 원문이 변경되어 중단합니다.')
    if (current) {
      const removed = path.join(sharedRoot, record.archiveRelative, `removed-${file.index}`)
      try { await lstat(removed); unsafe('이미 이동한 원본이 다시 나타나 줄바꿈 복구를 중단합니다.') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      await rename(target, removed)
      await regularPath(sharedRoot, `${record.archiveRelative}/removed-${file.index}`)
      if (!(await readFile(removed)).equals(file.original)) unsafe('이동 경계에서 파일이 변경됐습니다. 이동된 원문을 복구 폴더에 보존했습니다.')
    } else {
      const removed = await regularPath(sharedRoot, `${record.archiveRelative}/removed-${file.index}`)
      if (!(await readFile(removed)).equals(file.original)) unsafe('이동 원문 없이 파일이 없어져 복구를 중단합니다.')
    }
    // 원문 이동 후 새 파일이 생겼다면 덮어쓰지 않는다.
    await writeFile(path.join(workerRoot, file.path), file.canonical, { flag: 'wx', mode: file.mode })
    if (!(await readFile(path.join(workerRoot, file.path))).equals(file.canonical)) unsafe('줄바꿈 복구 결과의 바이트 검증에 실패했습니다.')
  }
  await assertState()
  if (await gitText(workerRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) unsafe('줄바꿈 복구 후에도 로컬 변경이 남아 격리를 유지합니다.')
  record.phase = 'normalized'
  record.normalizedAt = new Date().toISOString()
  await persist()
  return record
}
