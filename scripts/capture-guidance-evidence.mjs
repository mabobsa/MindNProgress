import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'docs/ai-guidance-rollback-2026-10-01')
export const digest = (text) => createHash('sha256').update(text).digest('hex')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const record = (text) => ({ text, length: text.length, sha256: digest(text) })
const baseline = '11a5079d62a9493e55548fe5b1ccbe0ffa3eb94c'
const startHead = 'eaa7eeda712c76e59c19ed771cbba077b72ada1e'

// 실제 Git 모듈과 MCP 핸들러를 실행한다. API 데이터만 결정적 fixture로 제공한다.
// 운영 연결을 상속하지 않으며 모의 API는 GET 이외 요청과 미등록 경로를 거부한다.
export async function captureInitialResponses(codeRoot, stateRoot) {
  const { createGroupProjects } = await import(pathToFileURL(path.join(codeRoot, 'server/lib/groupProjects.mjs')))
  // 요약 모듈이 없는 과거 커밋을 재현할 때는 전체 응답을 그대로 쓴다.
  const { summarizeGroupContext } = await import(pathToFileURL(path.join(codeRoot, 'server/lib/groupContextSummary.mjs'))).catch(() => ({}))
  const { MNP_MCP_SERVER_INSTRUCTIONS } = await import(pathToFileURL(path.join(codeRoot, 'src/utils/aiContextInstructions.mjs')))
  const maps = ['map-coordinator', 'map-member'].map((id) => ({
    id, title: id, version: 1, color: 'cyan', updatedAt: '2026-10-01T00:00:00.000Z',
    nodes: [
      { id: 'root', type: 'mind', position: { x: 0, y: 0 }, data: { label: '검증 루트', kind: 'root', isWork: false, status: 'in-progress', progress: 0, description: '승인된 검증 범위', sharedKnowledge: '' } },
      { id: 'task', type: 'mind', position: { x: 240, y: 0 }, data: { label: '검증 업무', kind: 'task', isWork: true, status: 'planned', progress: 0, description: '검증 업무 요구사항', sharedKnowledge: '', waitingItems: [] } },
    ], edges: [{ id: 'hierarchy', source: 'root', target: 'task', type: 'default' }],
  }))
  const group = { id: 'group-fixture', name: '격리 검증 그룹', mapIds: maps.map((map) => map.id) }
  await mkdir(path.join(stateRoot, '_group-projects'), { recursive: true })
  await writeFile(path.join(stateRoot, '_group-projects/group-fixture.json'), JSON.stringify({ version: 1, coordinatorMapId: maps[0].id, sources: [] }))
  const tokenFile = path.join(stateRoot, 'token')
  await writeFile(tokenFile, 'fixture-token-for-isolated-guidance-evidence-only')
  const service = createGroupProjects({
    dataDirectory: stateRoot, replaceFile: async () => { throw new Error('읽기 전용 검증입니다.') },
    listMaps: async () => maps, readMap: async (id) => maps.find((map) => map.id === id),
    saveMap: async () => { throw new Error('읽기 전용 검증입니다.') },
    readLayout: async () => ({ groups: [group] }), writeLayout: async () => { throw new Error('읽기 전용 검증입니다.') },
    delegations: new Map(), publicDelegation: (item) => item, runtimeSnapshot: () => [],
  })
  let roleMapId = ''
  const requests = []
  const api = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({ method: request.method, path: url.pathname, query: url.search })
    try {
      assert.equal(request.method, 'GET', '격리 API에 쓰기 요청이 도착했습니다.')
      let value
      if (url.pathname === '/api/health') value = { status: 'ok', publicBaseUrl: 'https://guidance-fixture.test' }
      else if (url.pathname === '/api/assignees') value = { users: [] }
      else if (url.pathname === '/api/groups/group-fixture') {
        value = await service.context(group.id, roleMapId)
        if (summarizeGroupContext && url.searchParams.get('view') === 'summary') value = summarizeGroupContext(value, { mapId: url.searchParams.get('mapId') ?? '' })
      }
      else if (url.pathname === '/api/document-groups') value = { documentGroups: await Promise.all(url.searchParams.getAll('mapId').map(async (mapId) => ({ mapId, group, groupMembership: 'grouped', groupProject: await service.forDocument(mapId) }))) }
      else if (/^\/api\/maps\/[^/]+\/comments$/.test(url.pathname)) value = { comments: [] }
      else if (/^\/api\/maps\/[^/]+\/ai-delegations$/.test(url.pathname)) value = { delegations: [] }
      else if (/^\/api\/maps\/[^/]+$/.test(url.pathname)) {
        const map = maps.find((item) => item.id === url.pathname.split('/').at(-1))
        assert.ok(map, 'fixture 문서가 없습니다.')
        value = { map, group, groupProject: await service.forDocument(map.id) }
      } else throw new Error(`미등록 fixture 경로: ${url.pathname}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ message: error.message }))
    }
  })
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
  const env = {
    ...process.env, MNP_API_URL: `http://127.0.0.1:${api.address().port}`, MNP_TOKEN_FILE: tokenFile,
    MNP_DATA_DIR: stateRoot, MNP_MCP_USAGE_DISABLED: '1', AIONUI_CONVERSATION_ID: '',
    MNP_RUNNER_MCP_RELAY_FILE: path.join(stateRoot, 'no-relay.json'),
  }
  const sessions = []
  let surface
  try {
    for (const [name, mapId, cardId] of [
      ['read-me-first', '', ''], ['leaf', 'map-member', 'task'],
      ['group-coordinator', 'map-coordinator', 'root'], ['document-coordinator', 'map-member', 'root'],
    ]) {
      roleMapId = mapId
      const client = new Client({ name: 'isolated-guidance-evidence', version: '1.0.0' })
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(codeRoot, 'mcp/server.mjs')], env, stderr: 'pipe' })
      try {
        await client.connect(transport)
        if (!surface) {
          const tools = [...(await client.listTools()).tools].sort((a, b) => a.name.localeCompare(b.name))
          surface = {
            sourceConstant: record(MNP_MCP_SERVER_INSTRUCTIONS),
            serverInstructions: { origin: 'SDK Client.getInstructions(): initialize 응답', ...record(client.getInstructions()) },
            tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          }
        }
        const tool = name === 'read-me-first' ? 'mindnprogress_read_me_first' : 'mindnprogress_get_context'
        const args = mapId ? { mapId, cardId } : {}
        const result = await client.callTool({ name: tool, arguments: args })
        assert.ok(!result.isError, JSON.stringify(result))
        const text = result.content.find((part) => part.type === 'text').text
        const response = JSON.parse(text)
        const session = { name, firstTool: tool, arguments: args, response: record(text), guide: record(JSON.stringify(response.guide)) }
        if (mapId) {
          const grouped = await client.callTool({ name: 'mindnprogress_get_group_context', arguments: { groupId: group.id } })
          assert.ok(!grouped.isError, JSON.stringify(grouped))
          session.groupResponse = record(grouped.content.find((part) => part.type === 'text').text)
          session.groupGuide = record(JSON.stringify(JSON.parse(session.groupResponse.text).guide))
        }
        sessions.push(session)
      } finally { await client.close() }
    }
  } finally {
    api.closeAllConnections()
    await new Promise((resolve) => api.close(resolve))
  }
  const sources = {}
  for (const file of ['mcp/server.mjs', 'src/utils/aiContextInstructions.mjs', 'src/utils/aiApprovalInstructions.mjs', 'server/lib/groupProjects.mjs']) {
    const text = await readFile(path.join(codeRoot, file), 'utf8')
    sources[file] = record(text)
  }
  return { surface, sessions, sources, requests, fixture: { maps, group } }
}

// The rollback baseline can be re-captured from the working tree only after a user approval.
// Each re-capture must name its own approval with --approval-ref and --approved-at; a failing guidance test
// is never a reason to re-capture. An existing approved rebaseline is refused unless --replace-rebaseline-head
// names its exact recorded head. Earlier evidence stays recoverable from Git history at the recorded HEAD.
const BASELINE_SOURCE_FILES = [
  'src/utils/aiContextInstructions.mjs', 'src/utils/aiApprovalInstructions.mjs', 'src/utils/aiConversationLaunch.mjs',
  'mcp/server.mjs', 'server/index.mjs', 'server/lib/groupDocumentInstructions.mjs', 'server/lib/groupProjects.mjs',
  'server/lib/doorayResponses.mjs', 'server/lib/workspacePool.mjs',
]
const CAPTURED_TREE_PATHS = ['mcp', 'server', 'src']
const EVIDENCE_PATH = 'docs/ai-guidance-rollback-2026-10-01/initial-response-evidence.json'
const SOURCES_PATH = 'docs/ai-guidance-rollback-2026-10-01/baseline-guide-sources.json'
const REBASELINE_USAGE = '기준선 재생성은 사용자가 승인한 경우에만 실행합니다. 테스트 실패를 해소하려고 재생성하지 마세요. 사용법: node scripts/capture-guidance-evidence.mjs --rebaseline-working-tree --approval-ref "<사용자 승인 위치와 내용>" --approved-at YYYY-MM-DD. 이미 승인된 재생성 기준선이 있으면 사용자가 기준선 교체를 승인한 경우에만 --replace-rebaseline-head <기록된 rebaseline.head 전체 SHA>를 함께 지정합니다.'
const REBASELINE_SHA_PATTERN = /^[0-9a-f]{40}$/

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index < 0) return undefined
  const value = argv[index + 1]
  return typeof value === 'string' && !value.startsWith('--') ? value.trim() : ''
}

/**
 * Validate the approval arguments of a working-tree re-capture.
 * A new approval reference is required every time, so an earlier approval cannot be reused.
 * When an approved rebaseline already exists, --replace-rebaseline-head must equal its recorded head.
 */
export function rebaselineApprovalFromArgs(argv, existingRebaseline) {
  const approvalRef = optionValue(argv, '--approval-ref')
  if (!approvalRef || approvalRef.length < 10) throw new Error(`--approval-ref에 사용자 승인 근거(위치와 내용, 10자 이상)를 지정하세요. ${REBASELINE_USAGE}`)
  const approvedAt = optionValue(argv, '--approved-at')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(approvedAt ?? '') || Number.isNaN(Date.parse(`${approvedAt}T00:00:00Z`))) {
    throw new Error(`--approved-at에 사용자 승인 날짜(YYYY-MM-DD)를 지정하세요. ${REBASELINE_USAGE}`)
  }
  const usedApprovals = []
  for (let record = existingRebaseline; record; record = record.previousRebaseline) usedApprovals.push(record.approvalRef, record.approval)
  if (usedApprovals.includes(approvalRef)) throw new Error(`이미 기준선 재생성에 사용한 승인 근거입니다. 새 재생성에는 새 사용자 승인이 필요합니다. ${REBASELINE_USAGE}`)
  if (existingRebaseline) {
    // An approved rebaseline is replaced only when the caller names the exact recorded head it replaces.
    const replaceHead = optionValue(argv, '--replace-rebaseline-head')
    if (replaceHead === undefined) {
      throw new Error(`이미 승인된 재생성 기준선(head ${existingRebaseline.head})이 있어 기본으로 거부합니다. 사용자가 기준선 교체를 승인한 경우에만 --replace-rebaseline-head에 기록된 head 전체 SHA를 지정하세요. ${REBASELINE_USAGE}`)
    }
    if (!REBASELINE_SHA_PATTERN.test(replaceHead) || replaceHead !== existingRebaseline.head) {
      throw new Error(`--replace-rebaseline-head가 기록된 재생성 기준선 head(${existingRebaseline.head}) 전체 SHA와 정확히 일치하지 않습니다. 사용자가 기준선 교체를 승인한 경우에만 지정하세요. ${REBASELINE_USAGE}`)
    }
  }
  return { approvalRef, approvedAt }
}

/** Tree hashes of the captured working tree, comparable with `git rev-parse <commit>:<path>` after committing it. */
async function capturedWorkingTree(temp) {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'capture-index') }
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim()
  run('read-tree', 'HEAD')
  run('add', '-A', '--', ...CAPTURED_TREE_PATHS)
  const tree = run('write-tree')
  return { tree, paths: Object.fromEntries(CAPTURED_TREE_PATHS.map((item) => [item, run('rev-parse', `${tree}:${item}`)])) }
}

function previousRebaselineSummary(record) {
  if (!record) return null
  const { approvedAt, approval, approvalRef, head, workingTreeDiffSha256, capturedTree, previousRebaseline } = record
  return {
    approvedAt, approval, ...(approvalRef ? { approvalRef } : {}), head, workingTreeDiffSha256,
    ...(capturedTree ? { capturedTree } : {}), previousRebaseline: previousRebaselineSummary(previousRebaseline),
  }
}

async function rebaselineWorkingTree() {
  const evidenceFile = path.join(root, EVIDENCE_PATH)
  const sourcesFile = path.join(root, SOURCES_PATH)
  const existing = JSON.parse(await readFile(evidenceFile, 'utf8'))
  const { approvalRef, approvedAt } = rebaselineApprovalFromArgs(process.argv, existing.rebaseline)
  if (git('status', '--porcelain', '--', EVIDENCE_PATH, SOURCES_PATH).trim()) {
    throw new Error('기준선 파일에 커밋되지 않은 변경이 있습니다. 직전 기준선을 Git에서 복구할 수 있도록 먼저 원인을 확인하세요.')
  }
  const head = git('rev-parse', 'HEAD').trim()
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'mcp', 'server/lib', 'src').split('\n').filter(Boolean).sort()
  const temp = await mkdtemp(path.join(root, '.guidance-evidence-'))
  try {
    const rebaseline = {
      approvedAt,
      approval: approvalRef,
      approvalRef,
      head,
      headTree: git('rev-parse', 'HEAD^{tree}').trim(),
      workingTreeDiffSha256: digest(git('diff', 'HEAD', '--', 'mcp', 'server', 'src')),
      capturedTree: await capturedWorkingTree(temp),
      untracked: await Promise.all(untracked.map(async (file) => ({ file, sha256: digest(await readFile(path.join(root, file), 'utf8')) }))),
      previousBaselineCommit: existing.rebaseline?.head ?? baseline,
      previousRebaseline: previousRebaselineSummary(existing.rebaseline),
      previousEvidenceSha256: digest(await readFile(evidenceFile, 'utf8')),
      previousSourcesSha256: digest(await readFile(sourcesFile, 'utf8')),
      previousEvidenceRecovery: `git show ${head}:${EVIDENCE_PATH}`,
    }
    const run = { name: 'baseline', head, workingTree: true, capturedAt: new Date().toISOString(), historicalExecution: false, ...await captureInitialResponses(root, path.join(temp, 'baseline-state')) }
    assert.ok(run.requests.every((request) => request.method === 'GET'))
    await writeFile(evidenceFile, `${JSON.stringify({
      schemaVersion: 2, capturedAt: new Date().toISOString(),
      method: '승인된 재생성: 현재 작업 트리의 실제 MCP 핸들러와 SDK initialize를 격리 상태 폴더에서 실행했습니다. 그룹 API는 작업 트리의 createGroupProjects.context/forDocument를 사용합니다. 문서·계정·상태는 결정적 fixture이며 운영 응답 캡처가 아닙니다.',
      rebaseline,
      originalBeforeSha256: digest(await readFile(path.join(output, 'before-surface-and-prompts.json'), 'utf8')),
      comparisons: [], runs: [run],
    }, null, 2)}\n`)
    const sources = {}
    for (const file of BASELINE_SOURCE_FILES) sources[file] = await readFile(path.join(root, file), 'utf8')
    await writeFile(sourcesFile, `${JSON.stringify({ baseline: `working-tree@${head}`, rebaseline, sources }, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ head, sessions: run.sessions.map(({ name, guide }) => ({ name, guideSha256: guide.sha256 })) })}\n`)
  } finally {
    assert.ok(path.resolve(temp).startsWith(`${root}${path.sep}.guidance-evidence-`))
    await rm(temp, { recursive: true, force: true })
  }
}

async function main() {
  if (process.argv.includes('--rebaseline-working-tree')) return rebaselineWorkingTree()
  const existing = JSON.parse(await readFile(path.join(output, 'initial-response-evidence.json'), 'utf8'))
  if (existing.schemaVersion >= 2 && !process.argv.includes('--historical')) {
    throw new Error('기준선은 2026-10-22에 작업 트리 기준으로 재생성되었습니다. 과거 Git 기준선 재현으로 덮어쓰려면 --historical을 지정하세요.')
  }
  const temp = await mkdtemp(path.join(root, '.guidance-evidence-'))
  const runs = []
  try {
    for (const [name, ref] of [['baseline', baseline], ['historical-start', startHead], ['candidate', 'HEAD']]) {
      const head = git('rev-parse', ref).trim()
      const codeRoot = path.join(temp, name)
      await mkdir(codeRoot)
      const archive = path.join(temp, `${name}.tar`)
      execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, head], { cwd: root })
      execFileSync('tar', ['-xf', archive, '-C', codeRoot])
      runs.push({ name, head, capturedAt: new Date().toISOString(), historicalExecution: name !== 'candidate', ...await captureInitialResponses(codeRoot, path.join(temp, `${name}-state`)) })
    }
    const old = runs[0], current = runs[2]
    const comparisons = current.sessions.map((session, index) => ({
      name: session.name, guideMatchesBaseline: session.guide.text === old.sessions[index].guide.text,
      groupGuideMatchesBaseline: session.groupGuide ? session.groupGuide.text === old.sessions[index].groupGuide.text : null,
    }))
    await writeFile(path.join(output, 'initial-response-evidence.json'), `${JSON.stringify({
      schemaVersion: 1, capturedAt: new Date().toISOString(),
      method: '각 Git commit을 후보 작업공간 내부에 archive로 격리 추출하여 실제 MCP 핸들러와 SDK initialize를 실행했습니다. 그룹 API는 해당 commit의 createGroupProjects.context/forDocument를 사용합니다. 문서·계정·상태는 결정적 fixture이며 운영 응답 캡처가 아닙니다.',
      originalBeforeSha256: digest(await readFile(path.join(output, 'before-surface-and-prompts.json'), 'utf8')),
      comparisons, runs,
    }, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ heads: runs.map(({ name, head }) => ({ name, head })), comparisons })}\n`)
    for (const item of comparisons) assert.ok(item.guideMatchesBaseline && item.groupGuideMatchesBaseline !== false, `${item.name}의 기준선 guide가 다릅니다.`)
  } finally {
    assert.ok(path.resolve(temp).startsWith(`${root}${path.sep}.guidance-evidence-`))
    await rm(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
