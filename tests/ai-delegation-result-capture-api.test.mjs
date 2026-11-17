import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AI_DELEGATION_RESULT_INLINE_LIMIT, buildAiDelegationResultCapture } from '../server/lib/aiDelegationResultCapture.mjs'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await exited
}

test('위임 목록은 절단 메타데이터와 보관 원문 경로를 노출하고 그룹 지시 응답 캡처에 메시지 형태를 기록한다', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-result-capture-'))
  const removeDirectory = async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('mnp-result-capture-')) throw new Error('테스트 임시 경로 검증 실패')
    await rm(directory, { recursive: true, force: true })
  }
  const longReport = `${'보고'.repeat(AI_DELEGATION_RESULT_INLINE_LIMIT / 2)}\n- R-42: 검증 완료`
  const fake = createServer((request, response) => {
    const send = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: status === 200, data }))
    }
    if (request.url === '/api/internal/external-conversation-dispatches/capabilities') return send({ historyOnlyReports: false })
    if (request.url === '/api/internal/external-conversation-dispatches/instruction-operation') {
      return send({ operationId: 'instruction-operation', conversationId: 'document-conversation', state: 'completed', turnId: 'document-turn' })
    }
    if (request.url?.startsWith('/api/conversations/document-conversation/messages')) {
      return send({ items: [
        { id: 'request', position: 'right', type: 'text', content: { content: '그룹 문서 지시' } },
        { id: 'long-answer', position: 'left', type: 'text', content: { content: longReport } },
      ] })
    }
    if (request.url?.startsWith('/api/conversations/')) {
      const id = request.url.split('/')[3]
      return send({ id, type: 'acp', extra: {}, runtime: { state: 'idle', is_processing: false } })
    }
    return send({}, 404)
  })
  const fakePort = await listen(fake)
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let child
  let errors = ''
  let headers = {}
  async function start() {
    child = spawn(process.execPath, ['server/index.mjs'], { cwd: projectDirectory, env: {
      ...process.env, MNP_DATA_DIR: directory, MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port), MNP_WEB_PORT: String(port),
      MNP_AIONUI_URL: `http://127.0.0.1:${fakePort}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '100',
      MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'),
      MNP_ADMIN_EMAIL: 'capture-test@mind.local', MNP_ADMIN_PASSWORD: 'CaptureTest!2026',
    }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    child.stderr.on('data', (chunk) => { errors += chunk })
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(baseUrl + '/api/health')).ok) return } catch { /* 테스트 서버 시작 대기 */ }
      await pause(50)
    }
    throw new Error(`테스트 서버 시작 실패: ${errors}`)
  }
  async function api(url, method = 'GET', body) {
    const response = await fetch(baseUrl + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  try {
    await start()
    const token = (await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()
    headers = { Authorization: `Bearer ${token}`, 'X-MNP-AI-Editor-Id': 'user-admin', 'Content-Type': 'application/json' }
    const created = await api('/api/maps', 'POST', { title: '결과 캡처 회귀', map: {
      nodes: [
        { id: 'parent-card', type: 'mind', position: { x: 0, y: 0 }, data: { label: '상위', kind: 'root', aiConversationId: 'parent-conversation' } },
        { id: 'child-card', type: 'mind', position: { x: 300, y: 0 }, data: { label: '하위', kind: 'task', aiConversationId: 'child-conversation' } },
      ], edges: [{ id: 'edge', source: 'parent-card', target: 'child-card' }],
    } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const mapId = created.body.map.id
    await stop(child)
    child = null

    const capture = buildAiDelegationResultCapture([
      { id: 'request', position: 'right', type: 'text', content: { content: '위임' } },
      { id: 'child-answer', position: 'left', type: 'text', content: { content: longReport } },
    ])
    await writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify([{
      id: 'long-result', mapId, parentCardId: 'parent-card', parentCardLabel: '상위', targetCardId: 'child-card', targetCardLabel: '하위',
      parentConversationId: 'parent-conversation', targetConversationId: 'child-conversation', state: 'superseded',
      childStatus: 'completed', childTurnId: 'child-turn', childResultTurnId: 'child-turn',
      childResultSnapshot: capture.snapshot, childResultHash: capture.snapshotHash,
      childResultCapture: capture.capture, childResultFull: capture.full,
      createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
    }]), 'utf8')
    await writeFile(path.join(directory, '_group-document-instructions.json'), JSON.stringify([{
      id: 'instruction-capture', groupId: 'group-capture', parentMapId: mapId, targetMapId: mapId,
      parentCardId: 'parent-card', targetCardId: 'parent-card', parentConversationId: 'coordinator-conversation',
      state: 'delivered', dispatchOperationId: 'instruction-operation', targetConversationId: 'document-conversation',
      createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
    }]), 'utf8')
    await start()
    headers['X-MNP-AI-Map-Id'] = mapId
    headers['X-MNP-AI-Card-Id'] = 'parent-card'
    headers['X-MNP-AI-Conversation-Id'] = 'parent-conversation'
    const listUrl = `/api/maps/${mapId}/ai-delegations`

    const plain = (await api(listUrl)).body.delegations.find((item) => item.id === 'long-result')
    assert.equal(plain.result, undefined)
    assert.equal(plain.childResultFull, undefined, '보관 원문은 기본 목록에 싣지 않는다.')
    assert.equal(plain.resultHashBasis, 'stored-snapshot')
    assert.equal(plain.resultTruncated, true)
    assert.equal(plain.resultOriginalLength, longReport.length)
    assert.equal(plain.resultMessageType, 'text')

    const withResult = (await api(`${listUrl}?includeResult=true`)).body.delegations.find((item) => item.id === 'long-result')
    assert.equal(withResult.result, capture.snapshot)
    assert.equal(withResult.resultHash, capture.snapshotHash)
    assert.equal(withResult.resultFullAvailable, true)
    assert.equal(withResult.resultFull, undefined)

    const withFull = (await api(`${listUrl}?includeResult=true&includeFullResult=true`)).body.delegations.find((item) => item.id === 'long-result')
    assert.equal(withFull.resultFull, longReport)
    assert.equal(withFull.resultFullHash, capture.full.hash)
    assert.equal(withFull.resultHash, capture.snapshotHash, '수신 확인 해시는 저장 문자열 기준을 유지한다.')
    const fullOnly = (await api(`${listUrl}?includeFullResult=true`)).body.delegations.find((item) => item.id === 'long-result')
    assert.equal(fullOnly.resultFull, undefined, 'includeResult 없이 보관 원문을 반환하지 않는다.')

    let instruction
    for (let attempt = 0; attempt < 100; attempt++) {
      const stored = JSON.parse(await readFile(path.join(directory, '_group-document-instructions.json'), 'utf8'))
      instruction = stored.find((item) => item.id === 'instruction-capture')
      if (instruction?.state === 'replied') break
      await pause(50)
    }
    assert.equal(instruction.state, 'replied', errors)
    assert.ok(instruction.response.startsWith('보고'))
    assert.ok(!instruction.response.includes('R-42'))
    assert.match(instruction.response.slice(AI_DELEGATION_RESULT_INLINE_LIMIT), /\[MindNProgress 결과 절단\].*mindnprogress_get_ai_conversation_transcript/s)
    assert.equal(instruction.responseCapture.messageId, 'long-answer')
    assert.equal(instruction.responseCapture.messageType, 'text')
    assert.equal(instruction.responseCapture.truncated, true)
    assert.equal(instruction.responseCapture.fullTextStored, false)
    assert.equal(instruction.responseFull, undefined)
  } finally {
    await stop(child)
    await new Promise((resolve) => fake.close(resolve))
    await removeDirectory()
  }
})
