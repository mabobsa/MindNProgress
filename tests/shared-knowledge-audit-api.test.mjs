import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { sharedKnowledgeMaxLength } from '../src/utils/sharedKnowledgePolicy.mjs'

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
  throw new Error('공유 지식 현황 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

test('전체 활성 문서의 공유 지식 현황을 원문과 문서 변경 없이 조회한다', { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-shared-knowledge-audit-'))
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
    const unauthenticatedResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit`)
    assert.equal(unauthenticatedResponse.status, 401)

    const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-MNP-Editor-Id': 'shared-knowledge-audit-editor',
    }
    const repeatedStatement = '반복되는 확정 지식 문장입니다.'
    const sharedKnowledge = `${repeatedStatement}\n${repeatedStatement}\n${'장기 지식 '.repeat(1_400)}`
    const createResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '공유 지식 현황 문서',
        map: {
          nodes: [
            {
              id: 'root-audit',
              type: 'mind',
              position: { x: 0, y: 0 },
              data: { label: '긴 공유 지식', kind: 'root', progress: 0, status: 'planned', sharedKnowledge },
            },
            {
              id: 'consumer-audit',
              type: 'mind',
              position: { x: 300, y: 0 },
              data: { label: '지식 소비 카드', kind: 'task', progress: 0, status: 'planned' },
            },
          ],
          edges: [{
            id: 'knowledge-audit',
            source: 'root-audit',
            target: 'consumer-audit',
            data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' },
          }],
        },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    const mapId = created.map.id

    const secondCreateResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '공유 지식 없는 문서',
        map: {
          nodes: [{
            id: 'root-empty-audit',
            type: 'mind',
            position: { x: 0, y: 0 },
            data: { label: '빈 문서', kind: 'root', progress: 0, status: 'planned' },
          }],
          edges: [],
        },
      }),
    })
    assert.equal(secondCreateResponse.status, 201)

    const mapFile = path.join(dataDirectory, `${mapId}.json`)
    const beforeAudit = await readFile(mapFile, 'utf8')
    const auditResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit`, { headers })
    assert.equal(auditResponse.status, 200)
    const result = await auditResponse.json()
    assert.equal(result.audit.summary.documentCount, 2)
    assert.equal(result.audit.summary.cardCount, 3)
    assert.equal(result.audit.summary.cardsWithSharedKnowledge, 1)
    assert.equal(result.audit.summary.actionableCandidateCount, 1)
    assert.equal(result.audit.maintenance.periodicIntervalDays, 7)
    assert.equal(result.audit.maintenance.requiresExplicitApproval, true)
    assert.equal(result.audit.maintenance.automaticMutation, false)
    assert.deepEqual(result.audit.summary.reviewStateCounts, { unreviewed: 1, current: 0, stale: 0 })
    assert.equal(result.audit.candidates[0].mapId, mapId)
    assert.equal(result.audit.candidates[0].cardId, 'root-audit')
    assert.equal(result.audit.candidates[0].reviewLevel, 'recommended')
    assert.equal(result.audit.candidates[0].consumerCount, 1)
    assert.equal(result.audit.candidates[0].exactDuplicateStatementCount, 1)
    assert.match(result.audit.candidates[0].sha256, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(result).includes(repeatedStatement), false)
    assert.equal(await readFile(mapFile, 'utf8'), beforeAudit)

    const forgedMap = structuredClone(created.map)
    forgedMap.nodes.find((node) => node.id === 'root-audit').data.sharedKnowledgeReview = {
      reviewedAt: '2026-08-18T01:02:03.000Z',
      reviewedHash: 'a'.repeat(64),
      reviewedBy: { id: 'forged-user', name: '위조 사용자' },
      reviewResult: 'accepted-long',
    }
    const forgedSaveResponse = await fetch(`${baseUrl}/api/maps/${mapId}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ map: forgedMap, baseVersion: created.map.version }),
    })
    assert.equal(forgedSaveResponse.status, 200)
    const forgedSave = await forgedSaveResponse.json()
    assert.equal(forgedSave.map.version, created.map.version)
    assert.equal(forgedSave.map.nodes.find((node) => node.id === 'root-audit').data.sharedKnowledgeReview, undefined)
    assert.equal(await readFile(mapFile, 'utf8'), beforeAudit)

    const malformedMap = structuredClone(created.map)
    malformedMap.nodes.find((node) => node.id === 'root-audit').data.sharedKnowledgeReview = {
      reviewedAt: '2026-08-18',
      reviewedHash: 'a'.repeat(64),
      reviewedBy: { id: 'forged-user', name: '위조 사용자' },
      reviewResult: 'accepted-long',
    }
    const malformedSaveResponse = await fetch(`${baseUrl}/api/maps/${mapId}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ map: malformedMap, baseVersion: created.map.version }),
    })
    assert.equal(malformedSaveResponse.status, 400)

    const filteredResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit?mapId=${mapId}`, { headers })
    assert.equal(filteredResponse.status, 200)
    const filtered = await filteredResponse.json()
    assert.equal(filtered.audit.summary.documentCount, 1)
    assert.equal(filtered.audit.documents[0].mapId, mapId)

    const invalidResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit?mapId=../invalid`, { headers })
    assert.equal(invalidResponse.status, 400)
    const emptyMapIdResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit?mapId=`, { headers })
    assert.equal(emptyMapIdResponse.status, 400)
    const missingResponse = await fetch(`${baseUrl}/api/shared-knowledge/audit?mapId=map-missing`, { headers })
    assert.equal(missingResponse.status, 404)

    const createBoundaryMap = (length) => fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `공유 지식 ${length}자 경계`,
        map: {
          nodes: [{
            id: `root-boundary-${length}`,
            type: 'mind',
            position: { x: 0, y: 0 },
            data: {
              label: '저장 경계 검증',
              kind: 'root',
              progress: 0,
              status: 'planned',
              sharedKnowledge: '가'.repeat(length),
            },
          }],
          edges: [],
        },
      }),
    })
    assert.equal((await createBoundaryMap(sharedKnowledgeMaxLength)).status, 201)
    assert.equal((await createBoundaryMap(sharedKnowledgeMaxLength + 1)).status, 400)
  } finally {
    if (server.exitCode === null) {
      server.kill()
      await new Promise((resolve) => server.once('exit', resolve))
    }
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
