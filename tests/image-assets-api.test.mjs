import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  throw new Error('이미지 API 검증 서버가 제한 시간 안에 시작되지 않았습니다.')
}

test('이미지 업로드와 원본 조회 및 이미지 노드 삭제 후 자산 보존이 연결된다', { timeout: 30_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-image-api-'))
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
    }
    const createResponse = await fetch(`${baseUrl}/api/maps`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '이미지 API 검증',
        map: {
          nodes: [{
            id: 'root-image-api',
            type: 'mind',
            position: { x: 0, y: 0 },
            data: {
              label: '이미지 API 검증',
              description: '',
              progress: 0,
              status: 'planned',
              kind: 'root',
            },
          }],
          edges: [],
        },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()

    const sourceImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const uploadResponse = await fetch(`${baseUrl}/api/maps/${created.map.id}/images`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'image/png' },
      body: sourceImage,
    })
    assert.equal(uploadResponse.status, 201)
    const uploaded = await uploadResponse.json()
    assert.match(uploaded.image.assetId, /^[a-f0-9]{32}\.png$/)
    assert.equal(uploaded.image.mimeType, 'image/png')

    const imageResponse = await fetch(`${baseUrl}/api/maps/${created.map.id}/images/${uploaded.image.assetId}`, { headers })
    assert.equal(imageResponse.status, 200)
    assert.equal(imageResponse.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), sourceImage)

    const imageNode = {
      id: 'image-api-test',
      type: 'mind',
      position: { x: 100, y: 100 },
      data: {
        label: 'sample.png',
        description: '',
        progress: 0,
        status: 'planned',
        kind: 'image',
        image: {
          assetId: uploaded.image.assetId,
          fileName: 'sample.png',
          mimeType: 'image/png',
          naturalWidth: 100,
          naturalHeight: 50,
          displayWidth: 200,
          displayHeight: 100,
        },
      },
    }
    const saveResponse = await fetch(`${baseUrl}/api/maps/${created.map.id}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        map: { nodes: [created.map.nodes[0], imageNode], edges: [] },
        baseVersion: created.map.version,
        baseLifecycleVersion: created.map.lifecycleVersion ?? 0,
      }),
    })
    assert.equal(saveResponse.status, 200)
    const saved = await saveResponse.json()
    assert.equal(saved.map.nodes[1].data.image.assetId, uploaded.image.assetId)
    const assetPath = path.join(dataDirectory, '_assets', created.map.id, uploaded.image.assetId)
    await access(assetPath)

    const deleteResponse = await fetch(`${baseUrl}/api/maps/${created.map.id}/images/${uploaded.image.assetId}`, {
      method: 'DELETE',
      headers,
    })
    assert.equal(deleteResponse.status, 200)
    const deleted = await deleteResponse.json()
    assert.deepEqual(deleted.deletedNodeIds, ['image-api-test'])
    assert.equal(deleted.deletedAssetId, null)
    assert.equal(deleted.retainedAssetId, uploaded.image.assetId)
    assert.equal(deleted.assetDeletionDeferred, true)
    assert.equal(deleted.map.nodes.some((node) => node.id === 'image-api-test'), false)
    await access(assetPath)

    const retainedImageResponse = await fetch(`${baseUrl}/api/maps/${created.map.id}/images/${uploaded.image.assetId}`, { headers })
    assert.equal(retainedImageResponse.status, 200)
    assert.deepEqual(Buffer.from(await retainedImageResponse.arrayBuffer()), sourceImage)
  } finally {
    if (server.exitCode === null) {
      server.kill()
      await new Promise((resolve) => server.once('exit', resolve))
    }
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
