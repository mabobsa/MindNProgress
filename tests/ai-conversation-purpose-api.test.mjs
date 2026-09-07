import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function startFakeAionUi(conversations) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/api/agents/management') {
      return sendJson(response, 200, [{
        id: 'claude',
        name: 'Claude',
        installed: true,
        enabled: true,
        status: 'ready',
        available_models: {
          available_models: [{ value: 'opus', name: 'Opus' }],
        },
      }])
    }
    if (request.method === 'GET' && ['/api/providers', '/api/skills', '/api/mcp/servers'].includes(url.pathname)) {
      return sendJson(response, 200, [])
    }
    if (request.method === 'GET' && url.pathname === '/api/internal/conversation-runtimes/active') {
      return sendJson(response, 200, { conversations: [] })
    }
    if (request.method === 'GET' && url.pathname === '/api/internal/external-conversation-dispatches/capabilities') {
      return sendJson(response, 200, { schemaVersion: 3, explicitCompletionAfterInterruption: true })
    }
    const conversationRoute = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)
    if (request.method === 'GET' && conversationRoute) {
      const conversation = conversations.get(decodeURIComponent(conversationRoute[1]))
      return conversation
        ? sendJson(response, 200, conversation)
        : sendJson(response, 404, { error: '대화를 찾을 수 없습니다.' })
    }
    return sendJson(response, 404, { error: '지원하지 않는 가짜 AionUi 경로입니다.' })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function waitForServer(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // 서버 시작 대기
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('AI 대화 용도 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

async function stopProcess(process) {
  if (process.exitCode !== null) return
  process.kill()
  await new Promise((resolve) => {
    process.once('exit', resolve)
    setTimeout(resolve, 2_000)
  })
}

test('지식 정리 대화는 임시 귀속만 유지하고 카드 대화와 영속 귀속을 변경하지 않는다', { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-ai-conversation-purpose-'))
  const conversations = new Map()
  const fakeAionUi = await startFakeAionUi(conversations)
  const port = 30_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const mindnprogress = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_AIONUI_URL: fakeAionUi.baseUrl,
    },
    stdio: 'ignore',
  })

  try {
    await waitForServer(baseUrl)
    const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-MNP-Editor-Id': 'ai-conversation-purpose-editor',
      'Content-Type': 'application/json',
    }
    const createResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: '지식 정리 대화 분리',
        map: {
          nodes: [
            {
              id: 'review-card',
              type: 'mind',
              position: { x: 0, y: 0 },
              data: {
                label: '정리 후보',
                description: '공유 지식을 검토합니다.',
                sharedKnowledge: '가'.repeat(5_100),
                kind: 'root',
                progress: 0,
                status: 'planned',
              },
            },
            {
              id: 'short-card',
              type: 'mind',
              position: { x: 300, y: 0 },
              data: {
                label: '짧은 지식',
                sharedKnowledge: '짧은 내용',
                kind: 'branch',
                progress: 0,
                status: 'planned',
              },
            },
          ],
          edges: [{ id: 'edge-review-short', source: 'review-card', target: 'short-card', data: { relation: 'hierarchy' } }],
        },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    const mapId = created.map.id

    const requestAttribution = (body) => fetch(`${baseUrl}/api/integrations/aionui/attributions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: 'claude', modelId: 'opus', mapId, ...body }),
    })

    const invalidPurposeResponse = await requestAttribution({ cardId: 'review-card', purpose: 'hidden' })
    assert.equal(invalidPurposeResponse.status, 400)

    const nonCandidateResponse = await requestAttribution({ cardId: 'short-card', purpose: 'shared-knowledge-review' })
    assert.equal(nonCandidateResponse.status, 409)
    assert.equal((await nonCandidateResponse.json()).code, 'SHARED_KNOWLEDGE_REVIEW_NOT_CANDIDATE')

    const cardAttributionResponse = await requestAttribution({ cardId: 'review-card' })
    assert.equal(cardAttributionResponse.status, 201)
    const cardAttribution = await cardAttributionResponse.json()
    const cardConversationId = 'conversation-card'
    conversations.set(cardConversationId, {
      id: cardConversationId,
      name: '카드 대화',
      created_at: '2026-08-26T10:00:00.000Z',
      modified_at: '2026-08-26T10:00:00.000Z',
      extra: { agent_id: 'claude', current_model_id: 'opus' },
    })
    const cardCompletionResponse = await fetch(cardAttribution.completionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: cardConversationId }),
    })
    assert.equal(cardCompletionResponse.status, 200)

    const linkedMap = (await (await fetch(`${baseUrl}/api/maps/${mapId}`, { headers })).json()).map
    const linkedVersion = linkedMap.version
    assert.equal(linkedMap.nodes.find((node) => node.id === 'review-card').data.aiConversationId, cardConversationId)

    const reviewAttributionResponse = await requestAttribution({ cardId: 'review-card', purpose: 'shared-knowledge-review' })
    assert.equal(reviewAttributionResponse.status, 201)
    const reviewAttribution = await reviewAttributionResponse.json()
    const reviewConversationId = 'conversation-review'
    conversations.set(reviewConversationId, {
      id: reviewConversationId,
      name: '[지식정리] 지식 정리 대화 분리: 정리 후보',
      created_at: '2026-08-26T10:01:00.000Z',
      modified_at: '2026-08-26T10:01:00.000Z',
      extra: { agent_id: 'claude', current_model_id: 'opus' },
    })
    const reviewCompletionResponse = await fetch(reviewAttribution.completionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: reviewConversationId }),
    })
    assert.equal(reviewCompletionResponse.status, 200)
    assert.deepEqual(await reviewCompletionResponse.json(), {
      conversationId: reviewConversationId,
      linked: false,
      purpose: 'shared-knowledge-review',
    })

    const reviewedMap = (await (await fetch(`${baseUrl}/api/maps/${mapId}`, { headers })).json()).map
    const reviewedCard = reviewedMap.nodes.find((node) => node.id === 'review-card')
    assert.equal(reviewedMap.version, linkedVersion)
    assert.equal(reviewedCard.data.aiConversationId, cardConversationId)
    assert.deepEqual(reviewedCard.data.aiConversations.map((item) => item.conversationId), [cardConversationId])

    const listed = await (await fetch(
      `${baseUrl}/api/maps/${mapId}/cards/review-card/ai-conversations`,
      { headers },
    )).json()
    assert.deepEqual(listed.conversations.map((item) => item.conversationId), [cardConversationId])

    const origins = JSON.parse(await readFile(path.join(dataDirectory, '_ai-conversation-origins.json'), 'utf8'))
    assert.equal(origins.some((item) => item.conversationId === cardConversationId), true)
    assert.equal(origins.some((item) => item.conversationId === reviewConversationId), false)

    const conversationAttributions = JSON.parse(await readFile(path.join(dataDirectory, '_ai-conversation-attributions.json'), 'utf8'))
    assert.equal(conversationAttributions.length, 1)
    assert.equal(conversationAttributions[0].conversationId, cardConversationId)

    const transientAttributions = JSON.parse(await readFile(path.join(dataDirectory, '_ai-attributions.json'), 'utf8'))
    assert.equal(transientAttributions.some((item) => item.conversationId === reviewConversationId), true)
  } finally {
    await stopProcess(mindnprogress)
    await fakeAionUi.close()
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
