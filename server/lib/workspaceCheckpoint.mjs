import { copyFile, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// Status must use -z and --no-renames: both sides of a rename remain explicit paths.
export function checkpointStatusEntries(status) {
  return String(status).split('\0').filter(Boolean).map((record) => ({
    status: record.slice(0, 2),
    path: record.slice(3),
    record,
  }))
}

export function checkpointPathInScope(file, scopes) {
  let candidate = file
  while (candidate) {
    if (scopes.has(candidate)) return true
    const separator = candidate.lastIndexOf('/')
    if (separator < 0) return false
    candidate = candidate.slice(0, separator)
  }
  return false
}

function checkpointIndexError(message, reasonCode, details = []) {
  return Object.assign(new Error(message), { code: reasonCode, reasonCode, status: 409, details })
}

// Git's real index stays byte-for-byte intact until a successful commit. Its lock
// also prevents another Git writer from staging into the index during this operation.
export async function withCheckpointIndex(root, git, operation) {
  const index = path.resolve(root, await git(root, ['rev-parse', '--git-path', 'index']))
  const lock = `${index}.lock`
  let handle
  try {
    handle = await open(lock, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw checkpointIndexError('Git 인덱스가 다른 작업에서 사용 중입니다. 해당 작업이 끝난 뒤 체크포인트를 다시 시도하세요.', 'AI_WORKSPACE_CHECKPOINT_INDEX_LOCKED')
  }
  let directory
  let beforeHead
  let preserve = false
  let ownsLock = true
  try {
    beforeHead = await git(root, ['rev-parse', 'HEAD'])
    directory = await mkdtemp(path.join(path.dirname(index), 'mnp-checkpoint-'))
    const temporaryIndex = path.join(directory, 'index')
    const execute = (args) => git(root, args, { env: {
      GIT_INDEX_FILE: temporaryIndex,
      GIT_LITERAL_PATHSPECS: '1',
      GIT_GLOB_PATHSPECS: '0',
      GIT_NOGLOB_PATHSPECS: '0',
      GIT_ICASE_PATHSPECS: '0',
    } })
    try { await copyFile(index, temporaryIndex) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await execute(['read-tree', 'HEAD'])
    }
    const stage = async (paths, { tracked = false } = {}) => {
      if (!paths.length) return
      const pathspec = path.join(directory, 'paths')
      await writeFile(pathspec, `${paths.join('\0')}\0`, 'utf8')
      await execute(['add', ...(tracked ? ['-u'] : []), `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul'])
    }
    const result = await operation({ git: execute, stage })
    if (result.checkpoint?.commit) {
      await handle.writeFile(await readFile(temporaryIndex))
      await handle.sync()
      await handle.close()
      handle = null
      // Unlike the generic state-file replacement helper, never delete this lock
      // on publication failure: it contains the committed index for recovery.
      for (let attempt = 0; ; attempt += 1) {
        try { await rename(lock, index); ownsLock = false; break } catch (error) {
          if (attempt >= 5 || !['EACCES', 'EBUSY', 'EEXIST', 'EPERM'].includes(error.code)) throw error
          await new Promise((resolve) => setTimeout(resolve, 15 * (2 ** attempt)))
        }
      }
    }
    return result
  } catch (error) {
    // A commit may already exist if saving its receipt or publishing the index
    // failed. Preserve recovery material instead of restoring a pre-commit index.
    const head = beforeHead ? await git(root, ['rev-parse', 'HEAD']).catch(() => null) : beforeHead
    if (beforeHead && head !== beforeHead) {
      preserve = true
      throw checkpointIndexError(
        `체크포인트 커밋 후 인덱스 또는 기록 저장에 실패했습니다. 재커밋하지 말고 복구 자료를 확인하세요: ${directory}. 원인: ${error.message}`,
        'AI_WORKSPACE_CHECKPOINT_RECOVERY_REQUIRED',
        [{ commit: head, directory, indexLock: lock }],
      )
    }
    throw error
  } finally {
    await handle?.close()
    if (!preserve) {
      if (ownsLock) await rm(lock, { force: true })
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
}
