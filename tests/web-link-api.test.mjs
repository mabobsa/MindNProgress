import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  throw new Error('웹 링크 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

test('웹 링크 카드 저장은 허용하고 원본 URL이 어긋난 데이터는 거부한다', { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-web-link-api-'))
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
      'X-MNP-Editor-Id': 'user-editor',
      'Content-Type': 'application/json',
    }
    const webUrl = 'https://example.com/docs/guide'
    const map = {
      nodes: [{
        id: 'root-web-link-api',
        type: 'mind',
        position: { x: 0, y: 0 },
        data: { label: '웹 링크 API 검증', description: '', progress: 0, status: 'planned', kind: 'root' },
      }, {
        id: 'web-link-api',
        type: 'mind',
        position: { x: 260, y: 0 },
        data: {
          label: 'guide',
          description: '',
          progress: 0,
          status: 'planned',
          kind: 'task',
          isWork: false,
          taskUrl: webUrl,
          webLink: { provider: 'web', url: webUrl },
        },
      }],
      edges: [],
    }
    const createResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '웹 링크 API 검증', map }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    assert.deepEqual(created.map.nodes[1].data.webLink, { provider: 'web', url: webUrl })

    const invalidMap = structuredClone(created.map)
    invalidMap.nodes[1].data.taskUrl = 'https://example.com/docs/other'
    const invalidResponse = await fetch(`${baseUrl}/api/maps/${created.map.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ map: invalidMap, baseVersion: created.map.version, baseLifecycleVersion: created.map.lifecycleVersion ?? 0 }),
    })
    assert.equal(invalidResponse.status, 400)
  } finally {
    server.kill()
    await new Promise((resolve) => server.once('exit', resolve))
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
