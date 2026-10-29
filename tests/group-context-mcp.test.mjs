import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { storageApi } from './helpers/storage-api-harness.mjs'

const groupId = 'group-summary-mcp'

async function seedGroup({ data, ids }) {
  await writeFile(path.join(data, '_map-order.json'), JSON.stringify({
    version: 1, items: [{ type: 'group', id: groupId }], groups: [{ id: groupId, name: '요약 조회 그룹', mapIds: [ids[0], ids[1]] }],
  }))
  await mkdir(path.join(data, '_group-projects'), { recursive: true })
  await writeFile(path.join(data, '_group-projects', `${groupId}.json`), JSON.stringify({
    version: 1, coordinatorMapId: ids[0], sources: [], objective: '그룹 목표 원문', instructions: '공통 지침 원문',
  }))
}

test('실제 MCP 그룹 조회·기준 저장은 연결 문서 기준 요약을 받고 full은 기존 응답을 유지한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 3, seed: seedGroup }), calls = []
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      calls.push(`${request.method} ${request.url}`)
      const upstream = await fetch(api.base + request.url, { method: request.method, headers: request.headers,
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) })
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()))
    } catch { response.writeHead(502); response.end('{}') }
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const client = new Client({ name: 'group-context-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'),
    env: { ...api.env, MNP_API_URL: `http://127.0.0.1:${proxy.address().port}` }, stderr: 'pipe' })
  t.after(async () => { await client.close(); await new Promise((resolve) => proxy.close(resolve)) })
  await client.connect(transport)
  const raw = (name, args) => client.callTool({ name: `mindnprogress_${name}`, arguments: args })
  const invoke = async (name, args) => {
    const result = await raw(name, args)
    assert.notEqual(result.isError, true, JSON.stringify(result))
    return JSON.parse(result.content.find((part) => part.type === 'text').text)
  }
  const [coordinatorId, memberId] = api.ids
  const groupPath = `/api/groups/${groupId}`
  await invoke('get_context', { mapId: memberId, cardId: 'card-0', editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' })

  calls.length = 0
  const member = await invoke('get_group_context', { groupId })
  assert.deepEqual(calls, [`GET ${groupPath}?view=summary&mapId=${memberId}`])
  assert.equal(member.view, 'summary')
  assert.equal(member.role, 'document')
  assert.equal(member.project.objective, '그룹 목표 원문')
  assert.ok(member.guide.approval)
  const memberRoot = member.documents.find((item) => item.id === memberId).root
  assert.equal(memberRoot.textIntegrity.description.length, '격리 환경의 시험 본문입니다. '.repeat(100).length)
  // 요약의 길이·SHA-256은 detail이 안내하는 get_card 회수 결과와 그대로 대조할 수 있어야 한다.
  const rootCard = await invoke('get_card', { mapId: memberId, cardId: memberRoot.id })
  assert.deepEqual(rootCard.card.textIntegrity, memberRoot.textIntegrity)
  assert.equal(rootCard.card.data.description, '격리 환경의 시험 본문입니다. '.repeat(100))

  calls.length = 0
  const coordinator = await invoke('get_group_context', { groupId, mapId: coordinatorId })
  assert.deepEqual(calls, [`GET ${groupPath}?view=summary&mapId=${coordinatorId}`])
  assert.equal(coordinator.role, 'coordinator')

  calls.length = 0
  const full = await invoke('get_group_context', { groupId, detailLevel: 'full' })
  assert.deepEqual(calls, [`GET ${groupPath}`])
  assert.equal(full.view, undefined)
  assert.equal(full.documents.find((item) => item.id === memberId).root.data.description, '격리 환경의 시험 본문입니다. '.repeat(100))
  assert.deepEqual(member.guide, full.guide)

  calls.length = 0
  const saved = JSON.stringify(await invoke('update_group_project', { groupId, baseVersion: 1, objective: '수정한 그룹 목표' }))
  assert.ok(calls.includes(`PATCH ${groupPath}?view=summary&mapId=${memberId}`), JSON.stringify(calls))
  assert.match(saved, /"view":"summary"/)
  assert.match(saved, /수정한 그룹 목표/)
  assert.doesNotMatch(saved, /"waitingDetails"/)

  const missing = await raw('list_group_document_instructions', { mapId: coordinatorId, instructionId: 'missing-instruction' })
  assert.equal(missing.isError, true)
  assert.match(JSON.stringify(missing.content), /GROUP_DOCUMENT_INSTRUCTION_NOT_FOUND|instructionId를 찾지 못했습니다/)
})
