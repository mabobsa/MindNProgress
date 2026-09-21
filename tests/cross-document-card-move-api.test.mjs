import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const node = (id, kind, data = {}) => ({
  id,
  type: 'mind',
  position: { x: 0, y: 0 },
  data: { label: id, description: '', kind, isWork: kind === 'task', progress: 0, status: 'planned', ...data },
})
const edge = (id, source, target) => ({ id, source, target, type: 'default', data: { relation: 'hierarchy' } })

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

test('문서 간 카드 이동 API가 카드 ID와 댓글·Ref·AI 귀속·완료 위임·알림을 함께 옮긴다', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-cross-document-move-'))
  const fakeAionUi = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: true, data: request.url === '/api/internal/conversation-runtimes/active'
      ? { schema_version: 1, generated_at: Date.now(), items: [] }
      : {} }))
  })
  const fakePort = await listen(fakeAionUi)
  const probe = createServer()
  const port = await listen(probe)
  await new Promise((resolve) => probe.close(resolve))
  const baseUrl = `http://127.0.0.1:${port}`
  let child
  let errors = ''
  const imageAssetId = `${'a'.repeat(32)}.png`
  const imageContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
  const sourceMap = {
    id: 'map-source', title: '원본', color: '#64748b', version: 7,
    nodes: [
      node('source-root', 'root', { isWork: false }),
      node('moved-parent', 'branch', { isWork: false }),
      node('moved-child', 'task', { aiConversationId: 'conversation-moved' }),
      node('moved-image', 'image', { isWork: false, image: {
        assetId: imageAssetId,
        fileName: '이동 이미지.png',
        mimeType: 'image/png',
        naturalWidth: 10,
        naturalHeight: 10,
        displayWidth: 10,
        displayHeight: 10,
      } }),
      node('source-sibling', 'task'),
    ],
    edges: [
      edge('source-parent', 'source-root', 'moved-parent'),
      edge('moved-child-edge', 'moved-parent', 'moved-child'),
      edge('moved-image-edge', 'moved-parent', 'moved-image'),
      edge('source-sibling-edge', 'source-root', 'source-sibling'),
    ],
  }
  const targetMap = {
    id: 'map-target', title: '대상', color: '#0ea5e9', version: 3,
    nodes: [node('target-root', 'root', { isWork: false }), node('target-parent', 'branch', { isWork: false })],
    edges: [edge('target-parent-edge', 'target-root', 'target-parent')],
  }
  const referenceMap = {
    id: 'map-reference', title: '참조', color: '#22c55e', version: 5,
    nodes: [
      node('reference-root', 'root', { isWork: false }),
      node('reference-card', 'branch', { isWork: false, reference: { mapId: 'map-source', nodeId: 'moved-child' } }),
    ],
    edges: [edge('reference-edge', 'reference-root', 'reference-card')],
  }
  const removeDirectory = async () => {
    const resolved = path.resolve(directory)
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('mnp-cross-document-move-')) {
      throw new Error('테스트 임시 경로 검증 실패')
    }
    await rm(resolved, { recursive: true, force: true })
  }
  try {
    await mkdir(path.join(directory, '_comments'), { recursive: true })
    await mkdir(path.join(directory, '_notifications'), { recursive: true })
    await mkdir(path.join(directory, '_assets', 'map-source'), { recursive: true })
    await Promise.all([
      writeFile(path.join(directory, 'map-source.json'), JSON.stringify(sourceMap), 'utf8'),
      writeFile(path.join(directory, 'map-target.json'), JSON.stringify(targetMap), 'utf8'),
      writeFile(path.join(directory, 'map-reference.json'), JSON.stringify(referenceMap), 'utf8'),
      writeFile(path.join(directory, '_users.json'), JSON.stringify([{
        id: 'user-editor', name: '이동 편집자', email: 'move@mind.local', role: 'editor', active: true,
        salt: '00', passwordHash: '00'.repeat(64),
      }]), 'utf8'),
      writeFile(path.join(directory, '_comments', 'map-source.json'), JSON.stringify([{
        id: 'comment-moved', mapId: 'map-source', nodeId: 'moved-child', content: '이동할 댓글',
        createdAt: '2026-09-20T00:00:00.000Z', author: { id: 'user-editor', name: '이동 편집자' },
      }]), 'utf8'),
      writeFile(path.join(directory, '_comments', 'map-target.json'), '[]', 'utf8'),
      writeFile(path.join(directory, '_ai-conversation-origins.json'), JSON.stringify([{
        conversationId: 'conversation-moved', mapId: 'map-source', cardId: 'moved-child',
        startedBy: 'user-editor', linkedAt: '2026-09-20T00:00:00.000Z',
      }]), 'utf8'),
      writeFile(path.join(directory, '_ai-conversation-attributions.json'), JSON.stringify([{
        conversationId: 'conversation-moved', mapId: 'map-source', cardId: 'moved-child',
        authorName: 'Codex(test)', startedBy: 'user-editor',
      }]), 'utf8'),
      writeFile(path.join(directory, '_ai-delegations.json'), JSON.stringify([
        {
          id: 'delegation-moved', state: 'completed', mapId: 'map-source',
          parentCardId: 'moved-parent', targetCardId: 'moved-child',
          parentConversationId: 'conversation-parent', targetConversationId: 'conversation-moved',
          createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:01:00.000Z',
        },
        {
          id: 'delegation-active', state: 'running', mapId: 'map-source',
          parentCardId: 'source-root', targetCardId: 'source-sibling',
          parentConversationId: 'conversation-parent', targetConversationId: 'conversation-active',
          createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:01:00.000Z',
        },
      ]), 'utf8'),
      writeFile(path.join(directory, '_notifications', 'user-editor.json'), JSON.stringify([{
        id: 'notification-moved', userId: 'user-editor', type: 'comment', mapId: 'map-source', mapTitle: '원본',
        nodeId: 'moved-child', nodeLabel: 'moved-child', createdAt: '2026-09-20T00:00:00.000Z', readAt: null,
      }]), 'utf8'),
      writeFile(path.join(directory, '_assets', 'map-source', imageAssetId), imageContent),
    ])

    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        MNP_DATA_DIR: directory,
        MNP_API_HOST: '127.0.0.1',
        MNP_API_PORT: String(port),
        MNP_WEB_PORT: String(port),
        MNP_AIONUI_URL: `http://127.0.0.1:${fakePort}`,
        MNP_AI_DELEGATION_POLL_INTERVAL_MS: '600000',
        MNP_WORKSPACE_POOL_REGISTRY: path.join(directory, 'no-pool.json'),
        MNP_ADMIN_EMAIL: 'move-admin@mind.local',
        MNP_ADMIN_PASSWORD: 'MoveTest!2026',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    child.stderr.on('data', (chunk) => { errors += chunk })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${baseUrl}/api/health`)).ok) break
      } catch { /* 서버 시작 대기 */ }
      await pause(50)
    }
    const token = (await readFile(path.join(directory, '_integration-token'), 'utf8')).trim()
    const response = await fetch(`${baseUrl}/api/maps/map-source/cards/moved-parent/move`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-MNP-AI-Editor-Id': 'user-editor',
        'X-MNP-AI-Type': 'Codex',
        'X-MNP-AI-Model': 'test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetMapId: 'map-target',
        targetParentCardId: 'target-parent',
        sourceVersion: 7,
        targetVersion: 3,
      }),
    })
    const body = await response.json()
    assert.equal(response.status, 200, `${JSON.stringify(body)}\n${errors}`)
    assert.equal(body.atomic, true)
    assert.deepEqual(body.movedCardIds, ['moved-parent', 'moved-child', 'moved-image'])
    assert.equal(body.operation.movedCommentCount, 1)
    assert.equal(body.operation.updatedReferenceCount, 1)
    assert.equal(body.operation.updatedConversationCount, 1)
    assert.equal(body.operation.updatedDelegationCount, 1)
    assert.equal(body.operation.updatedNotificationCount, 1)

    const storedSource = JSON.parse(await readFile(path.join(directory, 'map-source.json'), 'utf8'))
    const storedTarget = JSON.parse(await readFile(path.join(directory, 'map-target.json'), 'utf8'))
    const storedReference = JSON.parse(await readFile(path.join(directory, 'map-reference.json'), 'utf8'))
    assert.deepEqual(storedSource.nodes.map((item) => item.id), ['source-root', 'source-sibling'])
    assert.equal(storedTarget.nodes.some((item) => item.id === 'moved-child'), true)
    assert.equal(storedTarget.nodes.some((item) => item.id === 'moved-image'), true)
    assert.equal(storedTarget.edges.some((item) => item.source === 'target-parent' && item.target === 'moved-parent'), true)
    assert.deepEqual(storedReference.nodes.find((item) => item.id === 'reference-card').data.reference, {
      mapId: 'map-target', nodeId: 'moved-child',
    })

    const sourceComments = JSON.parse(await readFile(path.join(directory, '_comments', 'map-source.json'), 'utf8'))
    const targetComments = JSON.parse(await readFile(path.join(directory, '_comments', 'map-target.json'), 'utf8'))
    assert.equal(sourceComments.length, 0)
    assert.equal(targetComments[0].mapId, 'map-target')
    const origins = JSON.parse(await readFile(path.join(directory, '_ai-conversation-origins.json'), 'utf8'))
    const attributions = JSON.parse(await readFile(path.join(directory, '_ai-conversation-attributions.json'), 'utf8'))
    const delegations = JSON.parse(await readFile(path.join(directory, '_ai-delegations.json'), 'utf8'))
    const notifications = JSON.parse(await readFile(path.join(directory, '_notifications', 'user-editor.json'), 'utf8'))
    assert.equal(origins[0].mapId, 'map-target')
    assert.equal(attributions[0].mapId, 'map-target')
    const movedDelegation = delegations.find((item) => item.id === 'delegation-moved')
    assert.equal(movedDelegation.mapId, 'map-target')
    assert.equal(movedDelegation.parentMapId, 'map-target')
    assert.equal(notifications[0].mapId, 'map-target')
    assert.equal(notifications[0].mapTitle, '대상')
    assert.deepEqual(await readFile(path.join(directory, '_assets', 'map-target', imageAssetId)), imageContent)

    const operations = JSON.parse(await readFile(path.join(directory, '_card-move-operations.json'), 'utf8'))
    assert.equal(operations[0].sourceVersionBefore, 7)
    assert.equal(operations[0].targetVersionBefore, 3)

    const blockedResponse = await fetch(`${baseUrl}/api/maps/map-source/cards/source-sibling/move`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-MNP-AI-Editor-Id': 'user-editor',
        'X-MNP-AI-Type': 'Codex',
        'X-MNP-AI-Model': 'test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetMapId: 'map-target',
        targetParentCardId: 'target-parent',
        sourceVersion: body.sourceDocument.version,
        targetVersion: body.targetDocument.version,
      }),
    })
    const blockedBody = await blockedResponse.json()
    assert.equal(blockedResponse.status, 409)
    assert.equal(blockedBody.code, 'CARD_MOVE_ACTIVE_DELEGATION')
    assert.deepEqual(blockedBody.details.delegationIds, ['delegation-active'])
    assert.equal(JSON.parse(await readFile(path.join(directory, 'map-source.json'), 'utf8')).version, body.sourceDocument.version)
    assert.equal(JSON.parse(await readFile(path.join(directory, 'map-target.json'), 'utf8')).version, body.targetDocument.version)
  } finally {
    await stop(child)
    await new Promise((resolve) => fakeAionUi.close(resolve))
    await removeDirectory()
  }
})
