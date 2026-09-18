import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

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
  throw new Error('전체 검색 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

function card(id, label, data = {}) {
  return {
    id,
    type: 'mind',
    position: { x: 0, y: 0 },
    data: { label, description: '', progress: 0, status: 'planned', kind: 'task', ...data },
  }
}

function storedUser(id, name, email, role, password) {
  const salt = randomBytes(16).toString('hex')
  const now = '2026-09-18T00:00:00.000Z'
  return {
    id,
    name,
    email,
    role,
    active: true,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    salt,
    passwordHash: scryptSync(password, salt, 64).toString('hex'),
  }
}

test('전체 검색 API가 활성 문서·댓글·Ref 최신값과 커서 카탈로그를 권한 안에서 제공한다', { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-global-search-'))
  const port = 35_000 + Math.floor(Math.random() * 4_000)
  const baseUrl = `http://127.0.0.1:${port}`
  const accountPassword = 'GlobalSearch!2026'
  await writeFile(path.join(dataDirectory, '_users.json'), `${JSON.stringify([
    storedUser('user-editor', '검색 편집자', 'search-editor@mind.local', 'editor', accountPassword),
    storedUser('user-viewer', '검색 뷰어', 'search-viewer@mind.local', 'viewer', accountPassword),
  ], null, 2)}\n`, 'utf8')
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
    assert.equal((await fetch(`${baseUrl}/api/search?q=검색`)).status, 401)
    const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const headers = {
      Authorization: `Bearer ${token}`,
      'X-MNP-Editor-Id': 'user-editor',
      'Content-Type': 'application/json',
    }
    const sourceResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: '통합 검색 원본',
        map: {
          nodes: [card('source-card', '최신 담당 카드', {
            description: '표현이 다른 실제 담당 업무이며 검색 원본입니다.',
            sharedKnowledge: '재사용 가능한 확정 결론',
            checklist: [{ id: 'check', text: '댓글 상세 검색 검증', done: false }],
            waitingItems: [{ id: 'waiting', label: '서버 응답', note: '검색 권한 확인', resumeCondition: '배포 완료', since: '2026-09-18T00:00:00.000Z' }],
            isWork: true,
            assigneeId: 'user-editor',
            aiConversationId: 'internal-secret-conversation',
          })],
          edges: [],
        },
      }),
    })
    assert.equal(sourceResponse.status, 201)
    const sourceMap = (await sourceResponse.json()).map
    const placementResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: '통합 검색 배치',
        map: {
          nodes: [card('ref-card', '낡은 제목', {
            description: '낡은 복사본',
            reference: { mapId: sourceMap.id, nodeId: 'source-card' },
          })],
          edges: [],
        },
      }),
    })
    assert.equal(placementResponse.status, 201)
    const placementMap = (await placementResponse.json()).map
    const commentResponse = await fetch(`${baseUrl}/api/maps/${sourceMap.id}/comments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        nodeId: 'source-card',
        summary: '[결과] 검색 댓글을 검증했습니다.',
        detail: '원본 댓글 상세가 Ref 배치에서도 검색됩니다.',
      }),
    })
    assert.equal(commentResponse.status, 201)

    const sourceFile = path.join(dataDirectory, `${sourceMap.id}.json`)
    const placementFile = path.join(dataDirectory, `${placementMap.id}.json`)
    const beforeSource = await readFile(sourceFile, 'utf8')
    const beforePlacement = await readFile(placementFile, 'utf8')

    const commentSearchResponse = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('원본 댓글 상세')}`, { headers })
    assert.equal(commentSearchResponse.status, 200)
    const commentSearch = await commentSearchResponse.json()
    assert.equal(commentSearch.coverage.searchedDocumentCount, 2)
    assert.equal(commentSearch.coverage.semanticCoverage, 'not-guaranteed')
    assert.ok(commentSearch.results.some((item) => item.mapId === sourceMap.id && item.field === 'comments'))
    const referenceComment = commentSearch.results.find((item) => item.mapId === placementMap.id && item.field === 'comments')
    assert.equal(referenceComment.cardId, 'ref-card')
    assert.equal(referenceComment.reference.sourceCardId, 'source-card')

    const staleSearch = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('낡은 복사본')}`, { headers })
    assert.equal((await staleSearch.json()).page.total, 0)
    const internalSearch = await fetch(`${baseUrl}/api/search?q=internal-secret-conversation`, { headers })
    assert.equal((await internalSearch.json()).page.total, 0)

    const firstCatalogResponse = await fetch(`${baseUrl}/api/search?mode=catalog&limit=1`, { headers })
    assert.equal(firstCatalogResponse.status, 200)
    const firstCatalog = await firstCatalogResponse.json()
    assert.equal(firstCatalog.page.total, 2)
    assert.equal(firstCatalog.page.hasMore, true)
    const secondCatalogResponse = await fetch(`${baseUrl}/api/search?mode=catalog&limit=1&cursor=${encodeURIComponent(firstCatalog.page.nextCursor)}`, { headers })
    assert.equal(secondCatalogResponse.status, 200)
    const secondCatalog = await secondCatalogResponse.json()
    assert.equal(secondCatalog.page.returned, 1)
    assert.equal(secondCatalog.page.hasMore, false)

    const invalidCursorResponse = await fetch(`${baseUrl}/api/search?q=다른검색&cursor=${encodeURIComponent(firstCatalog.page.nextCursor)}`, { headers })
    assert.equal(invalidCursorResponse.status, 400)
    assert.equal((await invalidCursorResponse.json()).code, 'GLOBAL_SEARCH_CURSOR_INVALID')

    const viewerLogin = await fetch(`${baseUrl}/api/auth/viewer-access`, { method: 'POST' })
    assert.equal(viewerLogin.status, 200)
    const viewerCookie = viewerLogin.headers.get('set-cookie')?.split(';')[0]
    assert.ok(viewerCookie)
    const viewerSearch = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('최신 담당')}`, {
      headers: { Cookie: viewerCookie },
    })
    assert.equal(viewerSearch.status, 200)
    const viewerBody = await viewerSearch.json()
    assert.ok(viewerBody.results.length >= 2)
    assert.equal(JSON.stringify(viewerBody).includes('internal-secret-conversation'), false)

    for (const email of ['search-editor@mind.local', 'search-viewer@mind.local']) {
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: accountPassword }),
      })
      assert.equal(login.status, 200)
      const cookie = login.headers.get('set-cookie')?.split(';')[0]
      assert.ok(cookie)
      const accountSearch = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('최신 담당')}`, {
        headers: { Cookie: cookie },
      })
      assert.equal(accountSearch.status, 200)
      assert.ok((await accountSearch.json()).results.length >= 2)
    }

    assert.equal(await readFile(sourceFile, 'utf8'), beforeSource)
    assert.equal(await readFile(placementFile, 'utf8'), beforePlacement)
  } finally {
    if (server.exitCode === null) {
      server.kill()
      await new Promise((resolve) => server.once('exit', resolve))
    }
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
