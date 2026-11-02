import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WorkspacePoolManager } from '../server/lib/workspacePool.mjs'

const message = { summary: '검증 기록 정리', background: '누적된 실행 기록을 별도 보관합니다.', cause: '대량 삭제도 하나의 체크포인트로 고정해야 합니다.', changes: '의도된 삭제·수정·추가를 함께 기록했습니다.' }
const initialMessage = '[김용민] 체크포인트 검증 기준선\n\n[배경]\n격리된 Git 테스트가 필요합니다.\n\n[원인]\n삭제와 무시 규칙의 회귀를 검증합니다.\n\n[수정]\n테스트 기준 파일을 구성했습니다.'

function git(root, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(args.includes('-z') ? stdout : stdout.trim())
    })
    child.stdin.end(input)
  })
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mnp-checkpoint-test-')))
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('mnp-checkpoint-test-'))
    assert.equal(path.dirname(root), await realpath(tmpdir()))
    await rm(root, { recursive: true, force: true })
  })
  const worker = path.join(root, 'worker')
  await mkdir(worker)
  const run = (args, input) => git(worker, args, input)
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(worker, file)), { recursive: true })
    await writeFile(path.join(worker, file), text)
  }
  await run(['init', '-b', 'checkpoint-test'])
  await run(['config', 'user.name', 'MnP test'])
  await run(['config', 'user.email', 'mnp@example.invalid'])
  await run(['config', 'core.autocrlf', 'false'])
  await run(['config', 'core.hooksPath', path.join(root, 'no-hooks')])
  await put('.gitignore', '/Documentation/\n/ignored/\n')
  await put('ordinary.txt', 'baseline\n')
  await put('outside.txt', 'outside baseline\n')
  await put('Documentation/old.txt', 'archived\n')
  await put('preparation/old.txt', 'before move\n')
  await run(['add', '-f', '--', '.gitignore', 'ordinary.txt', 'outside.txt', 'Documentation/old.txt', 'preparation/old.txt'])
  await run(['commit', '-q', '-m', initialMessage])
  const manager = new WorkspacePoolManager({ registryFile: path.join(root, 'registry.json'), stateFile: path.join(root, 'state.json') })
  manager.registry = { poolId: 'test', commitPrefix: '[김용민]', workspaces: [{ id: 'worker', root: worker, role: 'worker' }] }
  manager.state = { leases: { test: { leaseId: 'test', jobId: 'test', mapId: 'test', cardId: 'test', conversationId: 'test', workspaceId: 'worker', branch: 'checkpoint-test', status: 'checkpoint-required', checkpoints: [] } }, workspaces: {} }
  const checkpoint = (paths) => manager.checkpoint('test', { jobId: 'test', mapId: 'test', cardId: 'test', conversationId: 'test', paths, commitMessage: message })
  const index = () => readFile(path.join(worker, '.git', 'index'))
  const cleanTemporaryFiles = async () => assert.deepEqual((await readdir(path.join(worker, '.git'))).filter((file) => file === 'index.lock' || file.startsWith('mnp-checkpoint-')), [])
  return { root, worker, manager, run, put, checkpoint, index, cleanTemporaryFiles }
}

test('실제 Git: 삭제만 있는 체크포인트는 무시된 추적 파일도 한 번에 커밋한다', async (t) => {
  const f = await fixture(t)
  const before = await f.run(['rev-parse', 'HEAD'])
  await unlink(path.join(f.worker, 'ordinary.txt'))
  await unlink(path.join(f.worker, 'Documentation/old.txt'))
  const result = await f.checkpoint(['ordinary.txt', 'Documentation/'])
  assert.equal(result.noChanges, false)
  assert.deepEqual(result.checkpoint.paths, ['Documentation/old.txt', 'ordinary.txt'])
  assert.equal(await f.run(['rev-list', '--count', `${before}..HEAD`]), '1')
  assert.equal(await f.run(['status', '--porcelain']), '')
  assert.equal(f.manager.state.leases.test.status, 'leased')
  await f.cleanTemporaryFiles()
})

test('실제 Git: 21,521개 삭제 경로를 폴더 하나로 지정해 단일 체크포인트를 만든다', async (t) => {
  const f = await fixture(t)
  const blob = await f.run(['rev-parse', 'HEAD:ordinary.txt'])
  const count = 21_520
  const prefix = `Documentation/${'execution-record-'.repeat(6)}`
  const entries = Array.from({ length: count }, (_, index) => `100644 ${blob}\t${prefix}/${index}-기록.txt\0`).join('')
  await f.run(['update-index', '-z', '--index-info'], entries)
  await f.run(['commit', '-q', '-m', initialMessage])
  await unlink(path.join(f.worker, 'Documentation/old.txt'))
  const before = await f.run(['rev-parse', 'HEAD'])
  const result = await f.checkpoint(['Documentation'])
  assert.equal(result.checkpoint.paths.length, count + 1)
  assert.deepEqual(result.checkpoint.requestedPaths, ['Documentation'])
  assert.equal(await f.run(['rev-list', '--count', `${before}..HEAD`]), '1')
  assert.equal(await f.run(['status', '--porcelain']), '')
  await f.cleanTemporaryFiles()
})

test('실제 Git: 이동·추가·수정과 특수문자 파일을 처리하며 인접 폴더는 포함하지 않는다', async (t) => {
  const f = await fixture(t)
  await unlink(path.join(f.worker, 'preparation/old.txt'))
  await f.put('preparation/새 위치 [1].txt', 'before move\n')
  await f.put('preparation/추가.txt', 'new content\n')
  await f.put('preparation-other/남김.txt', 'outside scope\n')
  await f.put('ordinary.txt', 'modified\n')
  const result = await f.checkpoint(['preparation', 'ordinary.txt'])
  assert.deepEqual(new Set(result.checkpoint.paths), new Set(['ordinary.txt', 'preparation/old.txt', 'preparation/새 위치 [1].txt', 'preparation/추가.txt']))
  assert.match(await f.run(['status', '--porcelain']), /preparation-other/)
  assert.equal(await f.run(['ls-files', 'preparation-other']), '')
  await f.put('preparation/새 위치 [1].txt', 'literal path changed\n')
  await f.put('preparation/새 위치 1.txt', 'must stay untracked\n')
  const literal = await f.checkpoint(['preparation/새 위치 [1].txt'])
  assert.deepEqual(literal.checkpoint.paths, ['preparation/새 위치 [1].txt'])
  await f.cleanTemporaryFiles()
})

test('실제 Git: 이미 스테이징한 삭제와 이동도 경로 양쪽을 확인한다', async (t) => {
  const f = await fixture(t)
  await f.run(['rm', '--', 'Documentation/old.txt'])
  await f.run(['mv', 'preparation/old.txt', 'preparation/moved.txt'])
  const result = await f.checkpoint(['Documentation', 'preparation'])
  assert.deepEqual(new Set(result.checkpoint.paths), new Set(['Documentation/old.txt', 'preparation/old.txt', 'preparation/moved.txt']))
  assert.equal(await f.run(['status', '--porcelain']), '')
})

test('실제 Git: 범위 밖 staged 변경을 거부해도 기존 인덱스와 파일은 보존된다', async (t) => {
  const f = await fixture(t)
  await f.put('outside.txt', 'staged outside\n')
  await f.run(['add', '--', 'outside.txt'])
  await f.put('outside.txt', 'unstaged outside\n')
  await f.put('ordinary.txt', 'intended change\n')
  const before = await f.index()
  const head = await f.run(['rev-parse', 'HEAD'])
  await assert.rejects(f.checkpoint(['ordinary.txt']), { reasonCode: 'AI_WORKSPACE_CHECKPOINT_STAGED_OUT_OF_SCOPE' })
  assert.deepEqual(await f.index(), before)
  assert.equal(await f.run(['rev-parse', 'HEAD']), head)
  assert.equal(await f.run(['show', ':outside.txt']), 'staged outside')
  assert.equal(await readFile(path.join(f.worker, 'outside.txt'), 'utf8'), 'unstaged outside\n')
  assert.equal(f.manager.state.leases.test.checkpoints.length, 0)
  await f.cleanTemporaryFiles()
})

for (const failingCommand of ['add', 'commit']) {
  test(`실제 Git: ${failingCommand} 실패 후 부분 스테이징을 남기지 않고 재시도할 수 있다`, async (t) => {
    const f = await fixture(t)
    await f.put('ordinary.txt', 'staged version\n')
    await f.run(['add', 'ordinary.txt'])
    await f.put('ordinary.txt', 'final version\n')
    await unlink(path.join(f.worker, 'Documentation/old.txt'))
    const before = await f.index()
    const head = await f.run(['rev-parse', 'HEAD'])
    const originalGit = f.manager.git
    f.manager.git = async (cwd, args, options) => {
      if (args[0] === failingCommand) {
        assert.ok(options.env.GIT_INDEX_FILE.includes('mnp-checkpoint-'))
        await assert.rejects(f.run(['add', 'outside.txt']), /index.lock/)
        if (failingCommand === 'add') await originalGit(cwd, args, options)
        throw new Error('검증용 중간 실패')
      }
      return originalGit(cwd, args, options)
    }
    await assert.rejects(f.checkpoint(['ordinary.txt', 'Documentation']), /검증용 중간 실패/)
    assert.deepEqual(await f.index(), before)
    assert.equal(await f.run(['rev-parse', 'HEAD']), head)
    assert.equal(f.manager.state.leases.test.checkpoints.length, 0)
    await f.cleanTemporaryFiles()
    f.manager.git = originalGit
    const result = await f.checkpoint(['ordinary.txt', 'Documentation'])
    assert.ok(result.checkpoint.commit)
    assert.equal(await f.run(['show', 'HEAD:ordinary.txt']), 'final version')
    assert.equal(await f.run(['status', '--porcelain']), '')
  })
}

test('실제 Git: 경로 방어와 기존 인덱스 잠금을 유지한다', async (t) => {
  const f = await fixture(t)
  await f.put('ordinary.txt', 'changed\n')
  for (const paths of [['../outside'], ['.'], ['C:/outside'], ['ordinary.txt', '../outside']]) {
    await assert.rejects(f.checkpoint(paths), { reasonCode: 'AI_WORKSPACE_CHECKPOINT_INPUT_INVALID' })
  }
  await f.put('knowledge-inbox/proposal.md', 'blocked\n')
  await assert.rejects(f.checkpoint(['knowledge-inbox']), { reasonCode: 'AI_WORKSPACE_CHECKPOINT_PATH_REJECTED' })
  const before = await f.index()
  await f.put('.git/index.lock', 'other writer')
  await assert.rejects(f.checkpoint(['ordinary.txt']), { reasonCode: 'AI_WORKSPACE_CHECKPOINT_INDEX_LOCKED' })
  assert.equal(await readFile(path.join(f.worker, '.git/index.lock'), 'utf8'), 'other writer')
  assert.deepEqual(await f.index(), before)
})

test('실제 Git: 커밋 후 기록 저장 실패 시 커밋과 복구 인덱스를 보존한다', async (t) => {
  const f = await fixture(t)
  const before = await f.index()
  const head = await f.run(['rev-parse', 'HEAD'])
  await f.put('ordinary.txt', 'committed result\n')
  f.manager.persist = async () => { throw new Error('검증용 기록 저장 실패') }
  let recovery
  await assert.rejects(f.checkpoint(['ordinary.txt']), (error) => {
    recovery = error.details[0]
    return error.reasonCode === 'AI_WORKSPACE_CHECKPOINT_RECOVERY_REQUIRED'
  })
  assert.notEqual(await f.run(['rev-parse', 'HEAD']), head)
  assert.equal(recovery.commit, await f.run(['rev-parse', 'HEAD']))
  assert.equal(await f.run(['show', 'HEAD:ordinary.txt']), 'committed result')
  assert.deepEqual(await f.index(), before)
  assert.ok((await readFile(path.join(recovery.directory, 'index'))).length)
  assert.ok((await readdir(path.join(f.worker, '.git'))).includes('index.lock'))
  assert.equal(f.manager.state.leases.test.status, 'quarantined')
  assert.equal(f.manager.state.workspaces.worker.status, 'quarantined')
})
