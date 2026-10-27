import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sharedKnowledgeSha256 } from '../server/lib/sharedKnowledgeReview.mjs'

const projectDirectory = path.resolve(import.meta.dirname, '..')

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
  throw new Error('공유 지식 검토 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

test('검토 문맥 조회와 해시 조건부 일괄 저장을 원자적으로 처리한다', { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-shared-knowledge-review-'))
  const port = 30_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
    },
    stdio: 'ignore',
  })

  try {
    await waitForServer(baseUrl)
    const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-MNP-Editor-Id': 'shared-knowledge-review-editor',
    }
    const firstKnowledge = `첫 후보의 확정 지식\n${'가'.repeat(5_100)}`
    const secondKnowledge = '나'.repeat(8_100)
    const createResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '공유 지식 검토 API',
        map: {
          nodes: [
            {
              id: 'root-review',
              type: 'mind',
              position: { x: 0, y: 0 },
              data: {
                label: '첫 후보', description: '첫 후보의 범위', sharedKnowledge: firstKnowledge,
                kind: 'root', progress: 0, status: 'planned',
              },
            },
            {
              id: 'second-review',
              type: 'mind',
              position: { x: 300, y: 0 },
              data: {
                label: '둘째 후보', description: '둘째 후보의 범위', sharedKnowledge: secondKnowledge,
                kind: 'branch', progress: 0, status: 'planned',
              },
            },
            {
              id: 'consumer-review',
              type: 'mind',
              position: { x: 600, y: 0 },
              data: {
                label: '소비 카드', description: '첫 후보 지식을 사용하는 작업',
                kind: 'task', progress: 0, status: 'planned', isWork: true,
              },
            },
          ],
          edges: [
            { id: 'hierarchy-review', source: 'root-review', target: 'second-review', data: { relation: 'hierarchy' } },
            { id: 'knowledge-review', source: 'root-review', target: 'consumer-review', data: { relation: 'knowledge' } },
          ],
        },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    const mapId = created.map.id
    const mapFile = path.join(dataDirectory, `${mapId}.json`)

    const commentResponse = await fetch(`${baseUrl}/api/maps/${mapId}/comments`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'root-review',
        summary: '[결과] 검토 문맥에 필요한 최근 결론입니다.',
        detail: '상세 근거는 명시적으로 요청할 때만 반환합니다.',
      }),
    })
    assert.equal(commentResponse.status, 201)

    const unauthenticatedContext = await fetch(
      `${baseUrl}/api/maps/${mapId}/cards/root-review/shared-knowledge-review-context`,
    )
    assert.equal(unauthenticatedContext.status, 401)

    const contextResponse = await fetch(
      `${baseUrl}/api/maps/${mapId}/cards/root-review/shared-knowledge-review-context?commentLimit=1&includeCommentDetail=false`,
      { headers },
    )
    assert.equal(contextResponse.status, 200)
    const contextResult = await contextResponse.json()
    assert.equal(contextResult.context.document.version, created.map.version)
    assert.equal(contextResult.context.card.sharedKnowledge, firstKnowledge)
    assert.equal(contextResult.context.card.textIntegrity.sha256, sharedKnowledgeSha256(firstKnowledge))
    assert.deepEqual(contextResult.context.relations.children.map((card) => card.id), ['second-review'])
    assert.deepEqual(contextResult.context.relations.knowledgeConsumers.map((card) => card.id), ['consumer-review'])
    assert.equal(contextResult.context.comments.length, 1)
    assert.equal(contextResult.context.comments[0].hasDetail, true)
    assert.equal(contextResult.context.comments[0].detail, undefined)

    const beforeFailedBatch = await readFile(mapFile, 'utf8')
    const failedBatchResponse = await fetch(`${baseUrl}/api/maps/${mapId}/shared-knowledge/reviews`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseVersion: created.map.version,
        patches: [
          {
            cardId: 'root-review',
            expectedSha256: sharedKnowledgeSha256(firstKnowledge),
            reviewResult: 'cleaned',
            replacement: '첫 후보의 재사용 가능한 확정 결론',
          },
          {
            cardId: 'second-review',
            expectedSha256: '0'.repeat(64),
            reviewResult: 'accepted-long',
          },
        ],
      }),
    })
    assert.equal(failedBatchResponse.status, 409)
    const failedBatch = await failedBatchResponse.json()
    assert.equal(failedBatch.code, 'SHARED_KNOWLEDGE_REVIEW_HASH_MISMATCH')
    assert.equal(failedBatch.cardId, 'second-review')
    assert.equal(await readFile(mapFile, 'utf8'), beforeFailedBatch)

    const validBatchResponse = await fetch(`${baseUrl}/api/maps/${mapId}/shared-knowledge/reviews`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseVersion: created.map.version,
        patches: [
          {
            cardId: 'root-review',
            expectedSha256: sharedKnowledgeSha256(firstKnowledge),
            reviewResult: 'cleaned',
            replacement: '첫 후보의 재사용 가능한 확정 결론',
          },
          {
            cardId: 'second-review',
            expectedSha256: sharedKnowledgeSha256(secondKnowledge),
            reviewResult: 'accepted-long',
          },
        ],
      }),
    })
    assert.equal(validBatchResponse.status, 200)
    const validBatch = await validBatchResponse.json()
    assert.equal(validBatch.atomic, true)
    assert.equal(validBatch.document.version, created.map.version + 1)
    assert.deepEqual(validBatch.changes.map((change) => change.reviewState), ['current', 'current'])
    assert.equal(validBatch.changes[0].review.reviewResult, 'cleaned')
    assert.equal(validBatch.changes[1].review.reviewResult, 'accepted-long')
    assert.equal(JSON.stringify(validBatch).includes('첫 후보의 재사용 가능한 확정 결론'), false)

    const reviewedMapResponse = await fetch(`${baseUrl}/api/maps/${mapId}`, { headers })
    const reviewedMap = (await reviewedMapResponse.json()).map
    assert.equal(reviewedMap.nodes.find((node) => node.id === 'root-review').data.sharedKnowledge, '첫 후보의 재사용 가능한 확정 결론')
    assert.equal(reviewedMap.nodes.find((node) => node.id === 'second-review').data.sharedKnowledgeReview.reviewResult, 'accepted-long')

    const auditResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit?mapId=${mapId}`, { headers })
    const audit = (await auditResponse.json()).audit
    assert.equal(audit.summary.actionableCandidateCount, 0)
    assert.equal(audit.summary.reviewStateCounts.current, 2)

    const changedMap = structuredClone(reviewedMap)
    changedMap.nodes.find((node) => node.id === 'second-review').data.sharedKnowledge = `${secondKnowledge}변경`
    const changeResponse = await fetch(`${baseUrl}/api/maps/${mapId}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ map: changedMap, baseVersion: reviewedMap.version, baseLifecycleVersion: reviewedMap.lifecycleVersion ?? 0 }),
    })
    assert.equal(changeResponse.status, 200)

    const staleAuditResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit?mapId=${mapId}`, { headers })
    const staleAudit = (await staleAuditResponse.json()).audit
    const staleCard = staleAudit.candidates.find((card) => card.cardId === 'second-review')
    assert.ok(staleCard)
    assert.equal(staleCard.reviewState, 'stale')
    assert.equal(staleCard.actionable, true)

    const staleContextResponse = await fetch(
      `${baseUrl}/api/maps/${mapId}/cards/second-review/shared-knowledge-review-context?commentLimit=0`,
      { headers },
    )
    assert.equal(staleContextResponse.status, 200)
    const staleContext = (await staleContextResponse.json()).context
    assert.equal(staleContext.card.reviewState, 'stale')
    assert.deepEqual(staleContext.comments, [])
  } finally {
    if (server.exitCode === null) {
      server.kill()
      await new Promise((resolve) => server.once('exit', resolve))
    }
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
