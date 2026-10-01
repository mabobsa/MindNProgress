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
      else if (url.pathname === '/api/groups/group-fixture') value = await service.context(group.id, roleMapId)
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

async function main() {
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
