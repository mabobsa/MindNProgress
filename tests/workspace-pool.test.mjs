import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  WorkspacePoolManager,
  WorkspacePoolUnavailableError,
  buildWorkspaceInstruction,
  integrationStatusRetryReasonCode,
  normalizeCheckpointCommitMessage,
} from '../server/lib/workspacePool.mjs'

const execFileAsync = promisify(execFile)
const checkpointCommitMessage = {
  summary: '일본 로그인 IDP 뷰 이중 등록 해소',
  background: '일본 로그인 진입 과정에서 동일 뷰가 중복 등록되어 초기화 순서가 불안정했습니다.',
  cause: '기존 초기화 경로와 일본 전용 진입 경로가 각각 뷰를 등록하고 있었습니다.',
  changes: '일본 전용 진입 경로로 등록 책임을 일원화하고 중복 등록을 제거했습니다.',
  scope: 'JAPAN_SERVICE 로그인 흐름에만 적용됩니다.',
}

async function git(cwd, ...args) {
  const result = await execFileAsync('git', args, { cwd, windowsHide: true })
  return String(result.stdout ?? '').trim()
}

test('작업공간 지침은 기존 대화에도 재배정 정보를 명확하게 전달한다', () => {
  const instruction = buildWorkspaceInstruction({
    workspaceId: 'fork2',
    jobId: 'job-12',
    leaseId: 'lease-12',
    projectRoot: 'C:\\Dev\\Game_Worker02\\client',
    sharedRoot: 'C:\\Dev\\Game_Workspaces',
    branch: 'mnp/job-12',
    baseCommit: 'abc123',
    assetsPath: 'C:/Dev/Game_Worker02/client/Assets',
    unityInstanceHash: '35b9a6e8409bd02a',
  })
  assert.match(instruction, /workspaceId: `fork2`/)
  assert.match(instruction, /projectRoot: `C:\\Dev\\Game_Worker02\\client`/)
  assert.match(instruction, /sharedRoot: `C:\\Dev\\Game_Workspaces`/)
  assert.match(instruction, /다른 등록 작업공간으로 이동하거나/)
  assert.match(instruction, /knowledge-inbox\/job-12\.md/)
  assert.match(instruction, /직접 커밋하지 마세요/)
  assert.match(instruction, /commitMessage/)
  assert.match(instruction, /mindnprogress_confirm_ai_workspace_no_changes/)
})

test('체크포인트 커밋 메시지는 실제 변경 구조와 금지 항목을 검증한다', () => {
  assert.deepEqual(normalizeCheckpointCommitMessage(checkpointCommitMessage), checkpointCommitMessage)
  assert.throws(
    () => normalizeCheckpointCommitMessage({ ...checkpointCommitMessage, summary: '[김용민] 중복 prefix' }),
    /prefix/,
  )
  assert.throws(
    () => normalizeCheckpointCommitMessage({ ...checkpointCommitMessage, changes: '변경\n\nCo-Authored-By: AI' }),
    /Co-Authored-By/,
  )
  assert.throws(
    () => normalizeCheckpointCommitMessage({ summary: '설명 누락' }),
    /background/,
  )
  assert.throws(
    () => normalizeCheckpointCommitMessage({ ...checkpointCommitMessage, legacyText: '호환 필드' }),
    /지원하지 않는 필드/,
  )
})

test('회수 기준 커밋 객체가 없으면 두 번 fetch한 뒤 worker 전환 없이 중단한다', async () => {
  const integrationRoot = path.join(tmpdir(), 'mnp-idle-guard-main')
  const workerRoot = path.join(tmpdir(), 'mnp-idle-guard-fork1')
  const commands = []
  const manager = new WorkspacePoolManager({
    registryFile: path.join(tmpdir(), 'mnp-idle-guard-workspaces.json'),
    stateFile: path.join(tmpdir(), 'mnp-idle-guard-state.json'),
    gitRunner: async (cwd, args) => {
      commands.push({ cwd, args })
      if (cwd === workerRoot && args[0] === 'cat-file') {
        throw new Error('fatal: Not a valid object name main456^{commit}')
      }
      return ''
    },
  })
  manager.registry = { integration: { root: integrationRoot } }

  await assert.rejects(
    () => manager.switchWorkspaceToIdleCommit(
      { id: 'fork1', root: workerRoot },
      'japan-master',
      'main456',
    ),
    /2회 가져온 뒤에도 객체를 확인하거나 전환하지 못했습니다/,
  )
  assert.equal(commands.filter(({ cwd, args }) => cwd === workerRoot && args[0] === 'fetch').length, 2)
  assert.equal(commands.some(({ cwd, args }) => cwd === workerRoot && args[0] === 'switch'), false)
})

test('실행 중인 풀에서 idle worker만 main 추적 기준으로 동기화한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-idle-sync-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      integrationLeaseId: null,
      workspaces: {
        main: { status: 'integration' },
        fork1: { status: 'idle', idleBranch: 'mnp/idle/fork1', idleCommit: 'old123' },
      },
      leases: {},
    }), 'utf8')

    let workerBranch = 'mnp/idle/fork1'
    let workerCommit = 'old123'
    const commands = []
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        commands.push({ cwd, args })
        if (args[0] === 'status') return ''
        if (args[0] === 'branch') return cwd === integrationRoot ? 'japan-master' : workerBranch
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return cwd === integrationRoot ? 'main456' : workerCommit
        if (args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return 'tree456'
        if (args[0] === 'switch') {
          workerBranch = args[2]
          workerCommit = args[3]
        }
        return ''
      },
    })
    assert.equal(await manager.initialize(), true)
    const result = await manager.synchronizeIdleWorkersToIntegration()
    assert.equal(result.baseBranch, 'japan-master')
    assert.equal(result.baseCommit, 'main456')
    assert.deepEqual(result.workspaces, [{
      workspaceId: 'fork1',
      branch: 'mnp/idle/fork1',
      previousCommit: 'old123',
      commit: 'main456',
      changed: true,
    }])
    assert.equal(manager.state.workspaces.fork1.idleCommit, 'main456')
    assert.equal(commands.some(({ cwd, args }) => cwd === workerRoot && args[0] === 'switch'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('idle이 아닌 worker가 하나라도 있으면 어떤 작업공간도 동기화하지 않는다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-idle-sync-busy-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      integrationLeaseId: null,
      workspaces: {
        main: { status: 'integration' },
        fork1: { status: 'leased', leaseId: 'lease-1' },
      },
      leases: {},
    }), 'utf8')
    const commands = []
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        commands.push({ cwd, args })
        if (args[0] === 'status') return ''
        if (args[0] === 'branch') return 'japan-master'
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'main456'
        if (args[0] === 'rev-parse') return 'tree456'
        return ''
      },
    })
    assert.equal(await manager.initialize(), true)
    await assert.rejects(
      () => manager.synchronizeIdleWorkersToIntegration(),
      (error) => error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === 'AI_WORKSPACE_SYNC_WORKER_BUSY',
    )
    assert.equal(commands.some(({ cwd, args }) => cwd === workerRoot && args[0] === 'switch'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('서버 재시작 후 finalizing lease는 같은 AI 대화에만 다시 연결한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-finalizing-rebind-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork4')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    const lease = {
      poolId: 'holdem',
      workspaceId: 'fork4',
      jobId: 'job-finalizing',
      leaseId: 'lease-finalizing',
      projectRoot: workerRoot,
      assetsPath: `${workerRoot}/Assets`,
      unityInstanceHash: 'hash-fork4',
      branch: 'mnp/job-finalizing',
      baseBranch: 'japan-master',
      baseCommit: 'base123',
      mapId: 'map-a',
      cardId: 'card-b',
      conversationId: 'conversation-c',
      status: 'finalizing',
      startedAt: '2026-08-20T09:00:00.000Z',
      checkpoints: [],
    }
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork4', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      integrationLeaseId: null,
      workspaces: {
        main: { status: 'integration' },
        fork4: { status: 'finalizing', jobId: lease.jobId, leaseId: lease.leaseId },
      },
      leases: { [lease.leaseId]: lease },
    }), 'utf8')
    await writeFile(path.join(workerRoot, '.ai-session.json'), JSON.stringify({
      schemaVersion: 1,
      workspaceId: lease.workspaceId,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      projectRoot: lease.projectRoot,
      conversationId: lease.conversationId,
    }), 'utf8')

    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (_cwd, args) => args[0] === 'branch' ? lease.branch : '',
    })
    assert.equal(await manager.initialize(), true)
    const rebound = await manager.bindConversation(lease.leaseId, lease.conversationId)
    assert.equal(rebound?.leaseId, lease.leaseId)
    assert.equal(await manager.bindConversation(lease.leaseId, 'conversation-other'), null)
    const reused = await manager.reuseLease(lease.leaseId, {
      mapId: lease.mapId,
      cardId: lease.cardId,
      conversationId: lease.conversationId,
    })
    assert.equal(reused?.leaseId, lease.leaseId)
    assert.equal(manager.publicSnapshot({ conversationId: lease.conversationId })
      .workspaces.find((workspace) => workspace.workspaceId === lease.workspaceId)?.status, 'leased')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('registry 작업공간만 풀로 인식하고 유휴 worker에 원자적 lease를 만든다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-pool-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork2')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        {
          id: 'fork2', root: workerRoot, role: 'worker', enabled: true,
          assetsPath: `${workerRoot}/Assets`, unityInstanceHash: 'hash-fork2',
        },
      ],
    }), 'utf8')

    const commands = []
    let workerBranch = 'japan-master'
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        commands.push({ cwd, args })
        if (args[0] === 'status') return ''
        if (args[0] === 'rev-parse') return 'base123'
        if (args[0] === 'branch' && args[1] === '--show-current') return cwd === workerRoot ? workerBranch : 'japan-master'
        if (args[0] === 'remote') return 'https://example.invalid/holdem.git'
        if (args[0] === 'switch') {
          workerBranch = args[1]
          return ''
        }
        return ''
      },
    })
    assert.equal(await manager.initialize(), true)
    assert.equal(manager.poolForWorkspace(workerRoot)?.poolId, 'holdem')
    assert.equal(manager.poolForWorkspace(path.join(root, 'other')), null)
    const initialSnapshot = manager.publicSnapshot({ conversationId: 'conversation-c' })
    assert.equal(initialSnapshot.available, true)
    assert.equal(initialSnapshot.integrationWorkspaceId, 'main')
    assert.deepEqual(initialSnapshot.statusCounts, { idle: 1, integration: 1 })
    assert.deepEqual(initialSnapshot.workspaces.find((workspace) => workspace.workspaceId === 'fork2'), {
      workspaceId: 'fork2',
      role: 'worker',
      enabled: true,
      status: 'idle',
      projectRoot: workerRoot,
      assetsPath: `${workerRoot}/Assets`,
      unityInstanceHash: 'hash-fork2',
      assignedToCurrentConversation: false,
      updatedAt: initialSnapshot.workspaces.find((workspace) => workspace.workspaceId === 'fork2').updatedAt,
    })

    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-b',
      conversationId: '',
      cardLabel: '하위 카드',
    })
    assert.equal(lease.workspaceId, 'fork2')
    assert.equal(lease.baseCommit, 'base123')
    assert.ok(commands.some(({ args }) => args[0] === 'fetch' && args.at(-1) === 'refs/heads/japan-master'))
    assert.ok(commands.some(({ args }) => args[0] === 'switch' && args[1] === lease.branch))

    const session = JSON.parse(await readFile(path.join(workerRoot, '.ai-session.json'), 'utf8'))
    assert.equal(session.leaseId, lease.leaseId)
    assert.equal(session.projectRoot, workerRoot)
    assert.equal(session.conversationId, '')

    await manager.bindConversation(lease.leaseId, 'conversation-c')
    const boundSession = JSON.parse(await readFile(path.join(workerRoot, '.ai-session.json'), 'utf8'))
    assert.equal(boundSession.conversationId, 'conversation-c')
    const assignedSnapshot = manager.publicSnapshot({ conversationId: 'conversation-c' })
    assert.equal(assignedSnapshot.workspaces.find((workspace) => workspace.workspaceId === 'fork2')?.status, 'leased')
    assert.equal(assignedSnapshot.workspaces.find((workspace) => workspace.workspaceId === 'fork2')?.assignedToCurrentConversation, true)
    assert.equal(JSON.stringify(assignedSnapshot).includes(lease.leaseId), false)
    assert.equal(JSON.stringify(assignedSnapshot).includes(lease.jobId), false)

    const reused = await manager.reuseLease(lease.leaseId, {
      mapId: 'map-a',
      cardId: 'card-b',
      conversationId: 'conversation-c',
    })
    assert.equal(reused.leaseId, lease.leaseId)
    assert.equal(reused.workspaceId, 'fork2')

    const noChangesCheckpoint = await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-a',
      cardId: 'card-b',
      conversationId: '',
      paths: [],
      confirmNoChanges: true,
    })
    assert.equal(noChangesCheckpoint.noChanges, true)
    assert.equal(noChangesCheckpoint.checkpoint.noCodeChanges, true)

    await assert.rejects(
      () => manager.checkpoint(lease.leaseId, {
        jobId: lease.jobId,
        mapId: 'map-a',
        cardId: 'card-b',
        conversationId: 'conversation-other',
        paths: [],
        confirmNoChanges: true,
      }),
      (error) => error instanceof WorkspacePoolUnavailableError,
    )

    await assert.rejects(
      () => manager.reuseLease(lease.leaseId, {
        mapId: 'map-a',
        cardId: 'card-b',
        conversationId: 'conversation-other',
      }),
      (error) => error instanceof WorkspacePoolUnavailableError,
    )

    await assert.rejects(
      () => manager.acquire({ workspaceHint: integrationRoot }),
      (error) => error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === 'CAPACITY_EXHAUSTED',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('위임 시작 전 통합 작업공간 변경은 차단 파일을 포함한 대기 사유로 반환한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-integration-clean-wait-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let integrationDirty = false
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        if (args[0] === 'status') return cwd === integrationRoot && integrationDirty ? ' M main.txt' : ''
        if (args[0] === 'diff') return cwd === integrationRoot && integrationDirty ? 'main.txt\nsecond.txt' : ''
        if (args[0] === 'rev-parse') return 'base123'
        if (args[0] === 'branch' && args[1] === '--show-current') return 'japan-master'
        if (args[0] === 'remote') return 'https://example.invalid/holdem.git'
        return ''
      },
    })
    assert.equal(await manager.initialize(), true)
    integrationDirty = true
    await assert.rejects(
      () => manager.acquire({
        workspaceHint: integrationRoot,
        mapId: 'map-a',
        cardId: 'card-a',
        conversationId: 'conversation-a',
        cardLabel: '통합 정리 대기',
      }),
      (error) => error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === 'integration-worktree-dirty'
        && error.message === '통합 작업공간에 커밋되지 않은 추적 파일 변경이 있습니다.'
        && JSON.stringify(error.details) === JSON.stringify(['main.txt', 'second.txt']),
    )
    assert.equal(Object.keys(manager.state.leases).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('통합 작업공간 Git 상태 확인 timeout은 격리가 아닌 재시도 대기로 분류한다', async () => {
  const integrationRoot = path.join(tmpdir(), 'mnp-integration-status-timeout')
  const manager = new WorkspacePoolManager({
    registryFile: path.join(tmpdir(), 'mnp-integration-status-timeout-workspaces.json'),
    stateFile: path.join(tmpdir(), 'mnp-integration-status-timeout-state.json'),
    gitRunner: async (cwd, args, options) => {
      assert.equal(cwd, integrationRoot)
      assert.deepEqual(args, ['status', '--porcelain=v1', '--untracked-files=no'])
      assert.equal(options.timeoutMs >= 1_000, true)
      const error = new Error('timed out')
      error.code = 'GIT_COMMAND_TIMEOUT'
      throw error
    },
  })
  manager.registry = { integration: { root: integrationRoot } }

  await assert.rejects(
    () => manager.integrationTrackedChanges(),
    (error) => error instanceof WorkspacePoolUnavailableError
      && error.reasonCode === integrationStatusRetryReasonCode
      && /다음 폴링/.test(error.message),
  )
})

test('통합 작업공간 변경 경로 확인 timeout도 재시도 대기로 분류한다', async () => {
  const integrationRoot = path.join(tmpdir(), 'mnp-integration-diff-timeout')
  const manager = new WorkspacePoolManager({
    registryFile: path.join(tmpdir(), 'mnp-integration-diff-timeout-workspaces.json'),
    stateFile: path.join(tmpdir(), 'mnp-integration-diff-timeout-state.json'),
    gitRunner: async (cwd, args, options) => {
      assert.equal(cwd, integrationRoot)
      assert.equal(options.timeoutMs >= 1_000, true)
      if (args[0] === 'status') return ' M changed.txt'
      assert.deepEqual(args, ['diff', '--name-only', 'HEAD'])
      const error = new Error('timed out')
      error.code = 'GIT_COMMAND_TIMEOUT'
      throw error
    },
  })
  manager.registry = { integration: { root: integrationRoot } }

  await assert.rejects(
    () => manager.integrationTrackedChanges(),
    (error) => error instanceof WorkspacePoolUnavailableError
      && error.reasonCode === integrationStatusRetryReasonCode,
  )
})

test('lease 발급 전 준비 실패는 가짜 lease 없이 격리하고 재시작 시 깨끗한 기준선만 자동 회수한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-preparation-recovery-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'mnp/idle/fork1'
    let failSwitch = true
    const gitRunner = async (cwd, args) => {
      if (args[0] === 'status') return ''
      if (args[0] === 'rev-parse') return cwd === workerRoot ? 'idle123' : 'base123'
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return cwd === workerRoot ? workerBranch : 'japan-master'
      }
      if (args[0] === 'remote') return 'https://example.invalid/holdem.git'
      if (args[0] === 'switch') {
        if (failSwitch) throw new Error('작업공간 전환 실패')
        workerBranch = args[1]
      }
      return ''
    }
    const manager = new WorkspacePoolManager({ registryFile, stateFile, gitRunner })
    assert.equal(await manager.initialize(), true)
    await assert.rejects(
      () => manager.acquire({ workspaceHint: integrationRoot, cardLabel: '준비 실패 작업' }),
      (error) => error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === 'WORKSPACE_PREPARATION_FAILED',
    )
    const failed = manager.state.workspaces.fork1
    assert.equal(failed.status, 'quarantined')
    assert.equal(failed.leaseId, undefined)
    assert.match(failed.preparationId, /^lease-/)
    assert.equal(failed.idleCommit, 'idle123')
    assert.equal(failed.idleBranch, 'mnp/idle/fork1')
    assert.equal(Object.keys(manager.state.leases).length, 0)

    failSwitch = false
    const restarted = new WorkspacePoolManager({ registryFile, stateFile, gitRunner })
    assert.equal(await restarted.initialize(), true)
    assert.equal(restarted.state.workspaces.fork1.status, 'idle')
    assert.equal(restarted.state.workspaces.fork1.lastPreparationFailure.preparationId, failed.preparationId)
    const lease = await restarted.acquire({ workspaceHint: integrationRoot, cardLabel: '복구 후 작업' })
    assert.equal(lease.workspaceId, 'fork1')
    assert.equal(lease.baseCommit, 'base123')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lease 발급 전 준비 실패에 세션 파일이 남아 있으면 자동 회수하지 않는다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-preparation-session-guard-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork2')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork2', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      integrationLeaseId: null,
      workspaces: {
        main: { status: 'integration' },
        fork2: {
          status: 'quarantined',
          reasonCode: 'WORKSPACE_PREPARATION_FAILED',
          reason: '준비 실패',
          jobId: 'job-failed',
          preparationId: 'lease-never-issued',
          idleCommit: 'idle456',
          idleBranch: 'mnp/idle/fork2',
        },
      },
      leases: {},
    }), 'utf8')
    await writeFile(path.join(workerRoot, '.ai-session.json'), '{}', 'utf8')

    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (_cwd, args) => {
        if (args[0] === 'status') return ''
        if (args[0] === 'rev-parse') return 'idle456'
        if (args[0] === 'branch') return 'mnp/idle/fork2'
        return ''
      },
    })
    assert.equal(await manager.initialize(), true)
    assert.equal(manager.state.workspaces.fork2.status, 'quarantined')
    assert.match(manager.state.workspaces.fork2.recoveryError, /AI 세션 파일/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('같은 AI 대화를 서로 다른 활성 작업공간 lease에 중복 연결하지 않는다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-conversation-lease-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoots = [path.join(root, 'fork1'), path.join(root, 'fork2')]
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(sharedRoot), ...workerRoots.map((workerRoot) => mkdir(workerRoot))])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        ...workerRoots.map((workerRoot, index) => ({
          id: `fork${index + 1}`,
          root: workerRoot,
          role: 'worker',
          enabled: true,
        })),
      ],
    }), 'utf8')

    const branches = Object.fromEntries(workerRoots.map((workerRoot) => [workerRoot, 'japan-master']))
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        if (args[0] === 'status') return ''
        if (args[0] === 'rev-parse') return 'base123'
        if (args[0] === 'branch' && args[1] === '--show-current') return branches[cwd] ?? 'japan-master'
        if (args[0] === 'remote') return 'https://example.invalid/holdem.git'
        if (args[0] === 'switch') {
          branches[cwd] = args[1]
          return ''
        }
        return ''
      },
    })
    assert.equal(await manager.initialize(), true)

    const first = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-a',
      cardLabel: '첫 작업',
    })
    await manager.bindConversation(first.leaseId, 'conversation-shared')
    const second = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-b',
      cardLabel: '둘째 작업',
    })

    for (const operation of [
      () => manager.bindConversation(second.leaseId, 'conversation-shared'),
      () => manager.reuseLease(second.leaseId, {
        mapId: 'map-a',
        cardId: 'card-b',
        conversationId: 'conversation-shared',
      }),
    ]) {
      await assert.rejects(operation, (error) =>
        error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === 'CONVERSATION_ALREADY_LEASED')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('변경과 체크포인트 없이 종료된 하위 AI 작업은 worker를 자동 회수한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-clean-failure-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'japan-master'
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        const worker = cwd === workerRoot
        if (args[0] === 'status') return ''
        if (args[0] === 'remote') return ''
        if (args[0] === 'rev-parse') return 'base123'
        if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
        if (args[0] === 'switch') {
          workerBranch = args[1] === '-C' ? args[2] : args[1]
          return ''
        }
        return ''
      },
    })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      cardLabel: '시작 실패 작업',
    })

    const result = await manager.finalize(lease.leaseId, {
      childStatus: 'failed',
      childError: '에이전트 시작 실패',
    })
    assert.equal(result.status, 'failed-clean')
    assert.equal(result.childStatus, 'failed')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.workspaces.fork1.status, 'idle')
    assert.equal(state.leases[lease.leaseId].status, 'cancelled')
    await assert.rejects(() => readFile(path.join(workerRoot, '.ai-session.json'), 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('외부 한도로 중단된 격리 lease는 동일 세션과 깨끗한 체크포인트 HEAD일 때만 재활성화한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-reactivate-limit-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork2')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    const lease = {
      schemaVersion: 1,
      poolId: 'holdem',
      workspaceId: 'fork2',
      projectRoot: workerRoot,
      jobId: 'job-limit',
      leaseId: 'lease-limit',
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      branch: 'mnp/job-limit',
      baseBranch: 'japan-master',
      baseCommit: 'base123',
      headCommit: 'checkpoint456',
      commits: ['checkpoint456'],
      checkpoints: [{ commit: 'checkpoint456', noCodeChanges: true }],
      status: 'quarantined',
      result: {
        status: 'quarantined',
        childStatus: 'failed',
        childError: 'usage limit exceeded',
        headCommit: 'checkpoint456',
        integrationBranch: null,
        unmergedFiles: [],
      },
    }
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork2', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      integrationLeaseId: null,
      workspaces: {
        main: { status: 'integration' },
        fork2: {
          status: 'quarantined',
          reason: 'usage limit exceeded',
          jobId: lease.jobId,
          leaseId: lease.leaseId,
        },
      },
      leases: { [lease.leaseId]: lease },
    }), 'utf8')
    await writeFile(path.join(workerRoot, '.ai-session.json'), JSON.stringify({
      schemaVersion: 1,
      workspaceId: lease.workspaceId,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      projectRoot: workerRoot,
      conversationId: lease.conversationId,
      branch: lease.branch,
      baseCommit: lease.baseCommit,
    }), 'utf8')

    let dirty = true
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (_cwd, args) => {
        if (args[0] === 'status') return dirty ? ' M Assets/Changed.cs' : ''
        if (args[0] === 'branch') return lease.branch
        if (args[0] === 'rev-parse' && args[1] === '--git-path') return path.join('.git', args[2])
        if (args[0] === 'rev-parse') return 'checkpoint456'
        if (args[0] === 'merge-base') return ''
        return ''
      },
    })
    await manager.initialize()

    await assert.rejects(
      () => manager.reactivateQuarantinedLease(lease.leaseId, {
        mapId: lease.mapId,
        cardId: lease.cardId,
        conversationId: lease.conversationId,
        failureCategory: 'usage-limit',
      }),
      (error) => error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === 'QUARANTINED_LEASE_WORKTREE_DIRTY',
    )
    assert.equal(manager.state.leases[lease.leaseId].status, 'quarantined')

    dirty = false
    const reactivated = await manager.reactivateQuarantinedLease(lease.leaseId, {
      mapId: lease.mapId,
      cardId: lease.cardId,
      conversationId: lease.conversationId,
      failureCategory: 'usage-limit',
    })
    assert.equal(reactivated.leaseId, lease.leaseId)
    assert.equal(manager.state.leases[lease.leaseId].status, 'leased')
    assert.equal(manager.state.leases[lease.leaseId].result, undefined)
    assert.equal(manager.state.leases[lease.leaseId].headCommit, undefined)
    assert.equal(manager.state.leases[lease.leaseId].commits, undefined)
    assert.equal(manager.state.leases[lease.leaseId].recoveryHistory.length, 1)
    assert.equal(manager.state.workspaces.fork2.status, 'leased')
    const session = JSON.parse(await readFile(path.join(workerRoot, '.ai-session.json'), 'utf8'))
    assert.equal(session.recovery.type, 'retryable-child-failure')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('변경 없이 격리된 과거 실패 lease는 다음 배정 전에 안전하게 자동 회수한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-recover-clean-quarantine-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork3')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    const oldLeaseId = 'lease-old'
    const oldJobId = 'job-old'
    const oldBranch = `mnp/${oldJobId}`
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork3', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      workspaces: {
        fork3: {
          status: 'quarantined',
          reason: '하위 AI 작업이 완료되지 않아 변경을 통합하지 않았습니다.',
          jobId: oldJobId,
          leaseId: oldLeaseId,
        },
      },
      leases: {
        [oldLeaseId]: {
          poolId: 'holdem',
          workspaceId: 'fork3',
          jobId: oldJobId,
          leaseId: oldLeaseId,
          branch: oldBranch,
          baseBranch: 'japan-master',
          baseCommit: 'base123',
          startedAt: '2026-08-17T01:00:00.000Z',
          status: 'quarantined',
          commits: [],
          result: {
            status: 'quarantined',
            headCommit: null,
            integrationBranch: null,
            unmergedFiles: [],
            error: '체크포인트 보완 요청을 전달하지 못했습니다.',
          },
        },
      },
    }), 'utf8')
    await writeFile(path.join(workerRoot, '.ai-session.json'), JSON.stringify({
      workspaceId: 'fork3', jobId: oldJobId, leaseId: oldLeaseId,
    }), 'utf8')

    let workerBranch = oldBranch
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        const worker = cwd === workerRoot
        if (args[0] === 'status') return ''
        if (args[0] === 'remote') return ''
        if (args[0] === 'rev-parse') return worker ? 'base123' : 'main456'
        if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
        if (args[0] === 'switch') {
          workerBranch = args[1] === '-C' ? args[2] : args[1]
          return ''
        }
        return ''
      },
    })
    await manager.initialize()
    const recoveredState = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(recoveredState.workspaces.fork3.status, 'idle')
    assert.equal(recoveredState.leases[oldLeaseId].status, 'cancelled')
    assert.equal(recoveredState.leases[oldLeaseId].result.status, 'failed-clean')
    assert.equal(recoveredState.leases[oldLeaseId].result.recoveredFromQuarantine, true)
    const lease = await manager.acquire({ workspaceHint: integrationRoot, cardLabel: '재배정 작업' })

    assert.equal(lease.workspaceId, 'fork3')
    assert.equal(JSON.parse(await readFile(path.join(workerRoot, '.ai-session.json'), 'utf8')).leaseId, lease.leaseId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('유휴 worker는 registry 고정 순서가 아니라 가장 오래 배정되지 않은 순서로 선택한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-fair-allocation-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const sharedRoot = path.join(root, 'shared')
    const workers = ['fork1', 'fork2', 'fork3', 'fork4'].map((id) => ({ id, root: path.join(root, id) }))
    await Promise.all([mkdir(integrationRoot), mkdir(sharedRoot), ...workers.map(({ root: workerRoot }) => mkdir(workerRoot))])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        ...workers.map(({ id, root: workerRoot }) => ({ id, root: workerRoot, role: 'worker', enabled: true })),
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      workspaces: Object.fromEntries(workers.map(({ id }) => [id, { status: 'idle' }])),
      leases: {
        old1: { workspaceId: 'fork1', startedAt: '2026-08-17T04:00:00.000Z', status: 'completed' },
        old2: { workspaceId: 'fork2', startedAt: '2026-08-17T03:00:00.000Z', status: 'completed' },
        old3: { workspaceId: 'fork3', startedAt: '2026-08-17T02:00:00.000Z', status: 'completed' },
      },
    }), 'utf8')

    const branches = Object.fromEntries(workers.map(({ root: workerRoot }) => [workerRoot, 'japan-master']))
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        if (args[0] === 'status') return ''
        if (args[0] === 'remote') return ''
        if (args[0] === 'rev-parse') return 'base123'
        if (args[0] === 'branch' && args[1] === '--show-current') return cwd === integrationRoot ? 'japan-master' : branches[cwd]
        if (args[0] === 'switch') {
          branches[cwd] = args[1]
          return ''
        }
        return ''
      },
    })
    await manager.initialize()
    const lease = await manager.acquire({ workspaceHint: integrationRoot, cardLabel: '공정 배정' })
    assert.equal(lease.workspaceId, 'fork4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('변경 없는 완료도 명시적 no-change 체크포인트 뒤에만 lease를 회수한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-no-change-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'japan-master'
    let integrationHead = 'base123'
    let workerCommitCheckAttempts = 0
    const commands = []
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        commands.push({ cwd, args })
        const worker = cwd === workerRoot
        if (args[0] === 'status') return ''
        if (args[0] === 'remote') return ''
        if (args[0] === 'rev-parse') return worker ? 'base123' : integrationHead
        if (args[0] === 'cat-file') {
          if (worker) {
            workerCommitCheckAttempts += 1
            if (workerCommitCheckAttempts === 1) throw new Error('아직 커밋 객체가 없습니다.')
          }
          return ''
        }
        if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
        if (args[0] === 'switch') {
          workerBranch = args[1] === '-C' ? args[2] : args[1]
          return ''
        }
        return ''
      },
    })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      cardLabel: '조사 전용 작업',
    })

    const checkpointRequired = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(checkpointRequired.status, 'checkpoint-required')
    assert.deepEqual(checkpointRequired.changedFiles, [])

    await assert.rejects(
      () => manager.bindConversation(lease.leaseId, 'conversation-other'),
      /이미 다른 대화에 연결/,
    )
    const rebound = await manager.bindConversation(lease.leaseId, 'conversation-a')
    assert.equal(rebound.leaseId, lease.leaseId)
    assert.equal(
      manager.publicSnapshot({ conversationId: 'conversation-a' })
        .workspaces.find((workspace) => workspace.workspaceId === 'fork1')?.status,
      'checkpoint-required',
    )

    const checkpoint = await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: '',
      paths: [],
      confirmNoChanges: true,
    })
    assert.equal(checkpoint.checkpoint.noCodeChanges, true)

    integrationHead = 'main456'
    const completed = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.integratedCommit, null)
    const reclaimFetches = commands.filter(({ cwd, args }) => cwd === workerRoot
      && args[0] === 'fetch'
      && args[2] === integrationRoot
      && args[3] === 'refs/heads/japan-master')
    assert.equal(reclaimFetches.length, 3)
    assert.equal(workerCommitCheckAttempts, 2)
    const idleSwitchIndex = commands.findIndex(({ cwd, args }) => cwd === workerRoot
      && args[0] === 'switch'
      && args[1] === '-C'
      && args[3] === 'main456')
    const lastCommitCheckIndex = commands.findLastIndex(({ cwd, args }) => cwd === workerRoot
      && args[0] === 'cat-file'
      && args[2] === 'main456^{commit}')
    assert.ok(lastCommitCheckIndex >= 0)
    assert.ok(idleSwitchIndex > lastCommitCheckIndex)
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.workspaces.fork1.status, 'idle')
    assert.equal(state.workspaces.fork1.idleBranch, 'mnp/idle/fork1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('완료된 worker 변경을 체크포인트로 고정하고 main에 직렬 통합한 뒤 lease를 회수한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-finalize-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork2')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork2', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'japan-master'
    let workerHead = 'base123'
    let integrationHead = 'base123'
    let leased = false
    const commands = []
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        commands.push({ cwd, args })
        const worker = cwd === workerRoot
        if (args[0] === 'status') return worker && leased ? ' M Assets/changed.cs' : ''
        if (args[0] === 'remote') return 'https://example.invalid/holdem.git'
        if (args[0] === 'rev-parse') return worker ? workerHead : integrationHead
        if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
        if (args[0] === 'switch') {
          if (args[1] === '-C') {
            workerBranch = args[2]
            workerHead = args[3]
            leased = false
          } else {
            workerBranch = args[1]
            leased = args[1] !== 'japan-master'
          }
          return ''
        }
        if (args[0] === 'commit') {
          workerHead = 'checkpoint456'
          leased = false
          return ''
        }
        if (args[0] === 'rev-list') return 'checkpoint456'
        if (args[0] === 'cherry-pick' && worker) {
          workerHead = 'integrated789'
          return ''
        }
        if (args[0] === 'merge' && !worker) {
          integrationHead = args.at(-1)
          return ''
        }
        return ''
      },
    })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-jp-login',
      cardId: 'node-idp-link',
      cardLabel: '로그인 보완',
    })
    await assert.rejects(
      () => manager.checkpoint(lease.leaseId, {
        jobId: lease.jobId,
        mapId: 'map-jp-login',
        cardId: 'node-idp-link',
        conversationId: '',
        paths: ['Assets/changed.cs'],
      }),
      (error) => error instanceof WorkspacePoolUnavailableError
        && error.reasonCode === 'AI_WORKSPACE_CHECKPOINT_MESSAGE_INVALID',
    )
    const checkpointResult = await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-jp-login',
      cardId: 'node-idp-link',
      conversationId: '',
      paths: ['Assets/changed.cs'],
      commitMessage: checkpointCommitMessage,
      mnpContext: {
        mapId: 'map-jp-login',
        cardId: 'node-idp-link',
        documentTitle: 'JP-로그인 제작',
        cardTitle: 'AOS/iOS 로그인 IDP 실연동·LINE 검증',
      },
    })
    const result = await manager.finalize(lease.leaseId, {
      childStatus: 'completed',
      cardLabel: '로그인 보완',
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.headCommit, 'checkpoint456')
    assert.equal(result.integratedCommit, 'integrated789')
    const commitCommand = commands.find(({ args }) => args[0] === 'commit')?.args ?? []
    assert.ok(commitCommand.includes('[김용민] 일본 로그인 IDP 뷰 이중 등록 해소'))
    assert.match(
      commitCommand.at(-1) ?? '',
      /\[MnP\]\n문서: JP-로그인 제작 \(map-jp-login\)\n카드: AOS\/iOS 로그인 IDP 실연동·LINE 검증 \(node-idp-link\)\n경로: \/mindmap\/map-jp-login\/node-idp-link\n\n\[배경\].*\[원인\].*\[수정\].*\[적용 범위\]/s,
    )
    assert.deepEqual(checkpointResult.checkpoint.mnpContext, {
      mapId: 'map-jp-login',
      cardId: 'node-idp-link',
      documentTitle: 'JP-로그인 제작',
      cardTitle: 'AOS/iOS 로그인 IDP 실연동·LINE 검증',
    })
    assert.doesNotMatch(commitCommand.at(-1) ?? '', /https?:\/\/|127\.0\.0\.1/)
    assert.ok(commands.some(({ cwd, args }) => cwd === workerRoot && args[0] === 'cherry-pick'))
    assert.ok(commands.some(({ cwd, args }) => cwd === integrationRoot && args[0] === 'merge' && args[1] === '--ff-only'))
    assert.equal(workerBranch, 'mnp/idle/fork2')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.workspaces.fork2.status, 'idle')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('main의 일시적 추적 변경은 worker를 격리하지 않고 정리될 때까지 통합을 대기한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-integration-wait-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'japan-master'
    let workerHead = 'base123'
    let integrationHead = 'base123'
    let workerDirty = false
    let integrationDirty = false
    const gitRunner = async (cwd, args) => {
      const worker = cwd === workerRoot
      if (args[0] === 'status') return worker ? (workerDirty ? ' M worker.txt' : '') : (integrationDirty ? ' M main.txt' : '')
      if (args[0] === 'diff') return !worker && integrationDirty ? 'main.txt' : ''
      if (args[0] === 'remote') return ''
      if (args[0] === 'rev-parse') return worker ? workerHead : integrationHead
      if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
      if (args[0] === 'switch') {
        if (args[1] === '-C') {
          workerBranch = args[2]
          workerHead = args[3]
        } else {
          workerBranch = args[1]
        }
        return ''
      }
      if (args[0] === 'commit') {
        workerHead = 'checkpoint456'
        workerDirty = false
        return ''
      }
      if (args[0] === 'rev-list') return 'checkpoint456'
      if (args[0] === 'cherry-pick') {
        workerHead = 'integrated789'
        return ''
      }
      if (args[0] === 'merge' && !worker) {
        integrationHead = args.at(-1)
        return ''
      }
      return ''
    }
    const manager = new WorkspacePoolManager({ registryFile, stateFile, gitRunner })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      cardLabel: '통합 대기',
    })
    workerDirty = true
    await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      paths: ['worker.txt'],
      commitMessage: checkpointCommitMessage,
    })

    integrationDirty = true
    const waiting = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(waiting.status, 'waiting-integration')
    assert.equal(waiting.reasonCode, 'integration-worktree-dirty')
    assert.deepEqual(waiting.trackedChanges, ['main.txt'])
    assert.equal(workerBranch, lease.branch)
    assert.equal(workerHead, 'checkpoint456')
    assert.equal(JSON.parse(await readFile(path.join(workerRoot, '.ai-session.json'), 'utf8')).leaseId, lease.leaseId)
    const waitingState = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(waitingState.integrationLeaseId, null)
    assert.equal(waitingState.workspaces.fork1.status, 'waiting-integration')

    const unchanged = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(unchanged.updatedAt, waiting.updatedAt)

    integrationDirty = false
    integrationHead = 'main456'
    const completed = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.integratedCommit, 'integrated789')
    assert.equal(workerBranch, 'mnp/idle/fork1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('과거 main dirty 격리는 세션·체크포인트·Git 소유권이 일치할 때만 통합 대기로 복구한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-legacy-integration-wait-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'japan-master'
    let workerHead = 'base123'
    let workerDirty = false
    let integrationDirty = false
    const gitRunner = async (cwd, args) => {
      const worker = cwd === workerRoot
      if (args[0] === 'status') return worker ? (workerDirty ? '?? unknown.txt' : '') : (integrationDirty ? ' M main.txt' : '')
      if (args[0] === 'diff') return !worker && integrationDirty ? 'main.txt' : ''
      if (args[0] === 'remote') return ''
      if (args[0] === 'rev-parse') return worker ? workerHead : 'base123'
      if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
      if (args[0] === 'switch') {
        workerBranch = args[1]
        return ''
      }
      if (args[0] === 'commit') {
        workerHead = 'checkpoint456'
        workerDirty = false
        return ''
      }
      if (args[0] === 'rev-list') return 'checkpoint456'
      return ''
    }
    const manager = new WorkspacePoolManager({ registryFile, stateFile, gitRunner })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      cardLabel: '과거 격리 복구',
    })
    workerDirty = true
    await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      paths: ['worker.txt'],
      commitMessage: checkpointCommitMessage,
    })
    integrationDirty = true
    const waiting = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    const storedLease = manager.state.leases[lease.leaseId]
    storedLease.status = 'quarantined'
    storedLease.result = {
      ...waiting,
      status: 'quarantined',
      error: '통합 작업공간에 커밋되지 않은 추적 파일 변경이 있습니다.',
      completedAt: new Date().toISOString(),
    }
    delete storedLease.result.reasonCode
    delete storedLease.result.waitingReason
    delete storedLease.result.trackedChanges
    manager.state.workspaces.fork1 = {
      status: 'quarantined',
      reason: storedLease.result.error,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      updatedAt: storedLease.result.completedAt,
    }
    await manager.persist()

    workerDirty = true
    assert.equal(await manager.recoverLegacyDirtyIntegration(lease.leaseId), null)
    workerDirty = false
    const recovered = await manager.recoverLegacyDirtyIntegration(lease.leaseId)
    assert.equal(recovered.status, 'waiting-integration')
    assert.equal(recovered.reasonCode, 'integration-worktree-dirty')
    assert.equal(recovered.recoveredFromQuarantine, true)
    assert.deepEqual(recovered.trackedChanges, ['main.txt'])
    assert.equal(workerBranch, lease.branch)
    assert.equal(workerHead, 'checkpoint456')
    assert.equal(JSON.parse(await readFile(path.join(workerRoot, '.ai-session.json'), 'utf8')).leaseId, lease.leaseId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('체크포인트 이후 인프라 파일로 격리된 완료 작업은 깨끗한 동일 HEAD에서 통합 대기로 복구한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-recover-checkpointed-finalization-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'japan-master'
    let workerHead = 'base123'
    let workerDirty = false
    let integrationDirty = false
    let revisionList = 'checkpoint456'
    const gitRunner = async (cwd, args) => {
      const worker = cwd === workerRoot
      if (args[0] === 'status') return worker ? (workerDirty ? '?? .claude/skills/tool/SKILL.md' : '') : (integrationDirty ? ' M main.txt' : '')
      if (args[0] === 'diff') return !worker && integrationDirty ? 'main.txt' : ''
      if (args[0] === 'remote') return 'https://example.invalid/holdem.git'
      if (args[0] === 'rev-parse') return worker ? workerHead : 'base123'
      if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
      if (args[0] === 'switch') {
        workerBranch = args[1]
        return ''
      }
      if (args[0] === 'commit') {
        workerHead = 'checkpoint456'
        workerDirty = false
        return ''
      }
      if (args[0] === 'rev-list') return revisionList
      return ''
    }
    const manager = new WorkspacePoolManager({ registryFile, stateFile, gitRunner })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-checkpointed',
      cardId: 'card-checkpointed',
      conversationId: 'conversation-checkpointed',
      cardLabel: '체크포인트 격리 복구',
    })
    workerDirty = true
    await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-checkpointed',
      cardId: 'card-checkpointed',
      conversationId: 'conversation-checkpointed',
      paths: ['worker.txt'],
      commitMessage: checkpointCommitMessage,
    })

    const storedLease = manager.state.leases[lease.leaseId]
    const completedAt = new Date().toISOString()
    storedLease.status = 'quarantined'
    storedLease.result = {
      status: 'quarantined',
      childStatus: 'completed',
      headCommit: null,
      integratedCommit: null,
      error: 'AI 작업공간 인프라 항목은 자동 정리하지 않습니다.',
      completedAt,
    }
    manager.state.workspaces.fork1 = {
      status: 'quarantined',
      reason: storedLease.result.error,
      jobId: lease.jobId,
      leaseId: lease.leaseId,
      updatedAt: completedAt,
    }
    await manager.persist()

    workerDirty = true
    assert.equal(await manager.recoverCheckpointedFinalizationFailure(lease.leaseId), null)
    workerDirty = false
    revisionList = 'manual789\ncheckpoint456'
    assert.equal(await manager.recoverCheckpointedFinalizationFailure(lease.leaseId), null)
    revisionList = 'checkpoint456'
    integrationDirty = true
    const recovered = await manager.recoverCheckpointedFinalizationFailure(lease.leaseId)
    assert.equal(recovered.status, 'waiting-integration')
    assert.equal(recovered.headCommit, 'checkpoint456')
    assert.equal(recovered.reasonCode, 'integration-worktree-dirty')
    assert.equal(recovered.recoveredFromQuarantine, true)
    assert.deepEqual(recovered.trackedChanges, ['main.txt'])
    assert.equal(storedLease.headCommit, 'checkpoint456')
    assert.deepEqual(storedLease.commits, ['checkpoint456'])
    assert.equal(manager.state.workspaces.fork1.status, 'waiting-integration')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('통합 충돌은 main을 건드리지 않고 같은 worker의 AI 해결 후 반영한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-conflict-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([
      mkdir(integrationRoot),
      mkdir(path.join(workerRoot, '.git'), { recursive: true }),
      mkdir(sharedRoot),
    ])
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      originUrl: 'https://example.invalid/holdem.git',
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    let workerBranch = 'japan-master'
    let workerHead = 'base123'
    let integrationHead = 'base123'
    let workerDirty = false
    let unmerged = false
    const commands = []
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        commands.push({ cwd, args })
        const worker = cwd === workerRoot
        if (args[0] === 'status') return worker && workerDirty ? ' M Assets/conflict.cs' : ''
        if (args[0] === 'remote') return 'https://example.invalid/holdem.git'
        if (args[0] === 'rev-parse' && args[1] === '--git-path') return '.git/CHERRY_PICK_HEAD'
        if (args[0] === 'rev-parse') return worker ? workerHead : integrationHead
        if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
        if (args[0] === 'switch') {
          if (args[1] === '-C') {
            workerBranch = args[2]
            workerHead = args[3]
          } else {
            workerBranch = args[1]
          }
          return ''
        }
        if (args[0] === 'commit') {
          workerHead = workerBranch.startsWith('mnp/integrate/') ? 'resolved789' : 'checkpoint456'
          workerDirty = false
          return ''
        }
        if (args[0] === 'rev-list') return 'checkpoint456'
        if (args[0] === 'diff') return unmerged ? 'Assets/conflict.cs' : ''
        if (args[0] === 'cherry-pick' && !args.includes('--continue')) {
          unmerged = true
          workerDirty = true
          await writeFile(path.join(workerRoot, '.git', 'CHERRY_PICK_HEAD'), 'checkpoint456\n', 'utf8')
          throw new Error('CONFLICT')
        }
        if (args[0] === '-c' && args.includes('cherry-pick') && args.includes('--continue')) {
          unmerged = false
          workerDirty = true
          workerHead = 'resolved789'
          await rm(path.join(workerRoot, '.git', 'CHERRY_PICK_HEAD'), { force: true })
          return ''
        }
        if (args[0] === 'merge' && !worker) {
          integrationHead = args.at(-1)
          return ''
        }
        return ''
      },
    })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-conflict',
      cardId: 'node-conflict',
      cardLabel: '충돌 작업',
    })
    workerDirty = true
    await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-conflict',
      cardId: 'node-conflict',
      conversationId: '',
      paths: ['Assets/conflict.cs'],
      commitMessage: checkpointCommitMessage,
      mnpContext: {
        mapId: 'map-conflict',
        cardId: 'node-conflict',
        documentTitle: '충돌 검증 문서',
        cardTitle: '충돌 작업',
      },
    })

    const conflict = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(conflict.status, 'awaiting-conflict-resolution')
    assert.deepEqual(conflict.unmergedFiles, ['Assets/conflict.cs'])
    assert.equal(integrationHead, 'base123')

    unmerged = false
    const completed = await manager.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.conflictResolvedByAi, true)
    assert.equal(completed.integratedCommit, 'resolved789')
    assert.equal(integrationHead, 'resolved789')
    const conflictCommit = commands
      .filter(({ cwd, args }) => cwd === workerRoot && args[0] === 'commit')
      .at(-1)?.args ?? []
    assert.ok(conflictCommit.includes('[김용민] 일본 로그인 IDP 뷰 이중 등록 해소 통합 충돌 해소'))
    assert.match(
      conflictCommit.at(-1) ?? '',
      /\[MnP\]\n문서: 충돌 검증 문서 \(map-conflict\)\n카드: 충돌 작업 \(node-conflict\)\n경로: \/mindmap\/map-conflict\/node-conflict/,
    )
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(state.integrationLeaseId, null)
    assert.equal(state.workspaces.fork1.status, 'idle')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('유휴 worker drift는 파일 종류와 관계없이 보존한 뒤 새 lease 전에 복원한다', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-drift-unit-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork2')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(workerRoot), mkdir(sharedRoot)])
    await writeFile(path.join(workerRoot, 'tracked.txt'), 'runtime drift\n', 'utf8')
    await writeFile(path.join(workerRoot, 'generated.bin'), 'generated\n', 'utf8')
    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork2', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      workspaces: {
        main: { status: 'integration' },
        fork2: {
          status: 'quarantined',
          reason: '작업공간에 소유자를 확정할 수 없는 변경이 있습니다.',
          leaseId: 'missing-lease',
        },
      },
      leases: {},
    }), 'utf8')

    let restoreCount = 0
    let workerBranch = 'japan-master'
    const manager = new WorkspacePoolManager({
      registryFile,
      stateFile,
      gitRunner: async (cwd, args) => {
        const worker = cwd === workerRoot
        if (args[0] === 'status') {
          if (!worker || restoreCount >= 2) return ''
          return restoreCount === 0 ? ' M tracked.txt\0?? generated.bin\0' : ' M tracked.txt\0'
        }
        if (args[0] === 'diff' && args.includes('--cached')) return ''
        if (args[0] === 'diff') return 'diff --git a/tracked.txt b/tracked.txt\n+runtime drift\n'
        if (args[0] === 'ls-files') return worker && restoreCount === 0 ? 'generated.bin\0' : ''
        if (args[0] === 'restore') {
          restoreCount += 1
          await writeFile(path.join(workerRoot, 'tracked.txt'), 'base\n', 'utf8')
          return ''
        }
        if (args[0] === 'branch' && args[1] === '--show-current') return worker ? workerBranch : 'japan-master'
        if (args[0] === 'rev-parse') return 'base123'
        if (args[0] === 'remote') return ''
        if (args[0] === 'switch') {
          workerBranch = args[1]
          return ''
        }
        return ''
      },
    })
    await manager.initialize()
    await manager.acquire({ workspaceHint: integrationRoot, cardLabel: 'drift 복원' })

    assert.equal(await readFile(path.join(workerRoot, 'tracked.txt'), 'utf8'), 'base\n')
    await assert.rejects(() => readFile(path.join(workerRoot, 'generated.bin'), 'utf8'), { code: 'ENOENT' })
    assert.equal(restoreCount, 2)
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const archive = state.workspaces.fork2.lastDriftArchive
    assert.ok(archive)
    const metadata = JSON.parse(await readFile(path.join(archive, 'metadata.json'), 'utf8'))
    assert.equal(metadata.attempt, 2)
    assert.equal(metadata.previousArchives.length, 1)
    assert.equal(await readFile(path.join(metadata.previousArchives[0], 'untracked', 'generated.bin'), 'utf8'), 'generated\n')
    assert.match(await readFile(path.join(archive, 'tracked.diff'), 'utf8'), /runtime drift/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('유휴 worker의 소유자 미확인 변경을 복구 자료로 보존하고 자동 회수한다', {
  skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-drift-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork2')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(sharedRoot)])
    await git(integrationRoot, 'init', '-b', 'japan-master')
    await git(integrationRoot, 'config', 'user.name', 'MNP Test')
    await git(integrationRoot, 'config', 'user.email', 'mnp@example.invalid')
    await writeFile(path.join(integrationRoot, 'tracked.txt'), 'base\n', 'utf8')
    await git(integrationRoot, 'add', 'tracked.txt')
    await git(integrationRoot, 'commit', '-m', 'base')
    await git(root, 'clone', '--branch', 'japan-master', integrationRoot, workerRoot)
    await git(workerRoot, 'config', 'user.name', 'MNP Test')
    await git(workerRoot, 'config', 'user.email', 'mnp@example.invalid')
    await writeFile(path.join(workerRoot, 'tracked.txt'), 'unity drift\n', 'utf8')
    await writeFile(path.join(workerRoot, 'generated.txt'), 'generated\n', 'utf8')

    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork2', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')
    await writeFile(stateFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      workspaces: {
        main: { status: 'integration' },
        fork2: {
          status: 'quarantined',
          reason: '작업공간에 소유자를 확정할 수 없는 변경이 있습니다.',
          leaseId: 'missing-lease',
        },
      },
      leases: {},
    }), 'utf8')

    const manager = new WorkspacePoolManager({ registryFile, stateFile })
    await manager.initialize()
    await manager.acquire({ workspaceHint: integrationRoot, cardLabel: 'drift 복구' })

    assert.equal((await readFile(path.join(workerRoot, 'tracked.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'base\n')
    await assert.rejects(() => readFile(path.join(workerRoot, 'generated.txt'), 'utf8'), { code: 'ENOENT' })
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const archive = state.workspaces.fork2.lastDriftArchive
    assert.ok(archive)
    assert.equal(JSON.parse(await readFile(path.join(archive, 'metadata.json'), 'utf8')).workspaceId, 'fork2')
    assert.equal(await readFile(path.join(archive, 'untracked', 'generated.txt'), 'utf8'), 'generated\n')
    assert.match(await readFile(path.join(archive, 'tracked.diff'), 'utf8'), /unity drift/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('명시적 체크포인트만 main에 통합하고 검증 후 drift는 보존·제거한다', {
  skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-checkpoint-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(sharedRoot)])
    await git(integrationRoot, 'init', '-b', 'japan-master')
    await git(integrationRoot, 'config', 'user.name', 'MNP Test')
    await git(integrationRoot, 'config', 'user.email', 'mnp@example.invalid')
    await writeFile(path.join(integrationRoot, 'intended.txt'), 'base\n', 'utf8')
    await writeFile(path.join(integrationRoot, 'runtime.txt'), 'base\n', 'utf8')
    await git(integrationRoot, 'add', 'intended.txt', 'runtime.txt')
    await git(integrationRoot, 'commit', '-m', 'base')
    await git(root, 'clone', '--branch', 'japan-master', integrationRoot, workerRoot)
    await git(workerRoot, 'config', 'user.name', 'MNP Test')
    await git(workerRoot, 'config', 'user.email', 'mnp@example.invalid')

    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    const manager = new WorkspacePoolManager({ registryFile, stateFile })
    await manager.initialize()
    const lease = await manager.acquire({
      workspaceHint: integrationRoot,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      cardLabel: '명시적 체크포인트',
    })
    await writeFile(path.join(workerRoot, 'intended.txt'), 'intended\n', 'utf8')
    const checkpoint = await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: 'map-a',
      cardId: 'card-a',
      conversationId: 'conversation-a',
      paths: ['intended.txt'],
      commitMessage: checkpointCommitMessage,
      cardLabel: '명시적 체크포인트',
    })
    assert.equal(checkpoint.noChanges, false)

    await writeFile(path.join(workerRoot, 'runtime.txt'), 'play mode drift\n', 'utf8')
    const result = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(result.status, 'completed')
    assert.equal((await readFile(path.join(integrationRoot, 'intended.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'intended\n')
    assert.equal((await readFile(path.join(integrationRoot, 'runtime.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'base\n')
    assert.equal(await git(integrationRoot, 'status', '--porcelain'), '')
    assert.equal(await git(workerRoot, 'status', '--porcelain'), '')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const archive = state.workspaces.fork1.lastDriftArchive
    assert.ok(archive)
    assert.match(await readFile(path.join(archive, 'tracked.diff'), 'utf8'), /play mode drift/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('실제 Git 저장소에서도 충돌을 worker에서 해결한 뒤 main을 fast-forward한다', {
  skip: process.env.MNP_REAL_GIT_TEST !== '1' && 'MNP_REAL_GIT_TEST=1일 때 실행',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mnp-workspace-real-git-'))
  try {
    const integrationRoot = path.join(root, 'main')
    const workerRoot = path.join(root, 'fork1')
    const sharedRoot = path.join(root, 'shared')
    await Promise.all([mkdir(integrationRoot), mkdir(sharedRoot)])
    await git(integrationRoot, 'init', '-b', 'japan-master')
    await git(integrationRoot, 'config', 'user.name', 'MNP Test')
    await git(integrationRoot, 'config', 'user.email', 'mnp@example.invalid')
    await writeFile(path.join(integrationRoot, 'shared.txt'), 'base\n', 'utf8')
    await git(integrationRoot, 'add', 'shared.txt')
    await git(integrationRoot, 'commit', '-m', 'base')
    await git(root, 'clone', '--branch', 'japan-master', integrationRoot, workerRoot)
    await git(workerRoot, 'config', 'user.name', 'MNP Test')
    await git(workerRoot, 'config', 'user.email', 'mnp@example.invalid')
    await writeFile(path.join(workerRoot, '.git', 'info', 'exclude'), '/.ai-session.json\n', { flag: 'a' })

    const registryFile = path.join(sharedRoot, 'workspaces.json')
    const stateFile = path.join(root, 'state.json')
    await writeFile(registryFile, JSON.stringify({
      schemaVersion: 1,
      poolId: 'holdem',
      sharedRoot,
      workspaces: [
        { id: 'main', root: integrationRoot, role: 'integration', enabled: true },
        { id: 'fork1', root: workerRoot, role: 'worker', enabled: true },
      ],
    }), 'utf8')

    const manager = new WorkspacePoolManager({ registryFile, stateFile })
    await manager.initialize()
    const lease = await manager.acquire({ workspaceHint: integrationRoot, cardLabel: '실제 충돌 작업' })
    await writeFile(path.join(workerRoot, 'shared.txt'), 'worker change\n', 'utf8')
    await manager.checkpoint(lease.leaseId, {
      jobId: lease.jobId,
      mapId: '',
      cardId: '',
      conversationId: '',
      paths: ['shared.txt'],
      commitMessage: checkpointCommitMessage,
      cardLabel: '실제 충돌 작업',
    })
    await writeFile(path.join(integrationRoot, 'shared.txt'), 'main change\n', 'utf8')
    await git(integrationRoot, 'add', 'shared.txt')
    await git(integrationRoot, 'commit', '-m', 'main change')

    const conflict = await manager.finalize(lease.leaseId, { childStatus: 'completed' })
    assert.equal(conflict.status, 'awaiting-conflict-resolution')
    assert.deepEqual(conflict.unmergedFiles, ['shared.txt'])
    assert.equal(await readFile(path.join(integrationRoot, 'shared.txt'), 'utf8'), 'main change\n')

    await writeFile(path.join(workerRoot, 'shared.txt'), 'resolved change\n', 'utf8')
    await git(workerRoot, 'add', 'shared.txt')
    const completed = await manager.completeConflictResolution(lease.leaseId, { childStatus: 'completed' })
    assert.equal(completed.status, 'completed')
    assert.equal(completed.conflictResolvedByAi, true)
    assert.equal((await readFile(path.join(integrationRoot, 'shared.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'resolved change\n')
    assert.equal(await git(integrationRoot, 'status', '--porcelain'), '')
    assert.equal(await git(workerRoot, 'status', '--porcelain'), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
