import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const testDataDirectory = path.resolve(projectDirectory, '.mcp-test-data')
const expectedPrefix = `${projectDirectory}${path.sep}`
if (!testDataDirectory.startsWith(expectedPrefix) || path.basename(testDataDirectory) !== '.mcp-test-data') {
  throw new Error('MCP 테스트 데이터 경로가 프로젝트 내부의 전용 디렉터리가 아닙니다.')
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : null
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForServer(baseUrl, child, logs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) throw new Error(`격리 API 서버가 종료되었습니다.\n${logs.join('')}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {
      // 서버가 수신 준비를 마칠 때까지 재시도합니다.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`격리 API 서버 시작 시간이 초과되었습니다.\n${logs.join('')}`)
}

function parseToolResult(name, result) {
  const text = result.content?.find((item) => item.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(`${name}: ${text || '알 수 없는 MCP 오류'}`)
  assert.ok(text, `${name}: 텍스트 결과가 없습니다.`)
  return JSON.parse(text)
}

async function main() {
  await rm(testDataDirectory, { recursive: true, force: true })
  await mkdir(testDataDirectory, { recursive: true })
  const port = await availablePort()
  assert.ok(port, '테스트 포트를 할당하지 못했습니다.')
  const apiBaseUrl = `http://127.0.0.1:${port}`
  const environment = {
    ...process.env,
    MNP_API_HOST: '127.0.0.1',
    MNP_API_PORT: String(port),
    MNP_API_URL: apiBaseUrl,
    MNP_DATA_DIR: testDataDirectory,
    MNP_ADMIN_EMAIL: 'mcp-test-admin@mind.local',
    MNP_ADMIN_PASSWORD: 'McpTest!2026',
  }
  const serverLogs = []
  const apiServer = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  apiServer.stdout.on('data', (chunk) => serverLogs.push(chunk.toString()))
  apiServer.stderr.on('data', (chunk) => serverLogs.push(chunk.toString()))

  let client = null
  const calledTools = new Map()
  try {
    await waitForServer(apiBaseUrl, apiServer, serverLogs)
    await access(path.join(testDataDirectory, '_integration-token'))
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['mcp/server.mjs'],
      cwd: projectDirectory,
      env: environment,
      stderr: 'pipe',
    })
    client = new Client({ name: 'mindnprogress-full-regression', version: '1.0.0' })
    await client.connect(transport)
    const listedTools = await client.listTools()
    const registeredToolNames = listedTools.tools.map((tool) => tool.name).sort()
    assert.equal(registeredToolNames.length, 29, `예상과 다른 MCP 도구 수: ${registeredToolNames.length}`)

    const invoke = async (name, args = {}) => {
      calledTools.set(name, (calledTools.get(name) ?? 0) + 1)
      return parseToolResult(name, await client.callTool({ name, arguments: args }))
    }
    const invokeExpectError = async (name, args, expectedText) => {
      calledTools.set(name, (calledTools.get(name) ?? 0) + 1)
      const result = await client.callTool({ name, arguments: args })
      const text = result.content?.find((item) => item.type === 'text')?.text ?? ''
      assert.equal(result.isError, true, `${name}: 실패해야 하는 요청이 성공했습니다.`)
      assert.match(text, expectedText, `${name}: 예상한 오류가 아닙니다. ${text}`)
    }

    const guide = await invoke('mindnprogress_read_me_first')
    assert.equal(guide.guide.product.name, 'MindNProgress')

    const createdMindmap = await invoke('mindnprogress_create_mindmap', {
      title: 'MCP 전체 회귀 문서',
      color: 'blue',
      cards: [
        { key: 'root', label: '전체 회귀', kind: 'root', description: '루트 업무 https://example.com/root', taskUrl: 'https://example.com/root' },
        { key: 'branch-a', parentKey: 'root', label: '기능 A', kind: 'branch' },
        { key: 'branch-b', parentKey: 'root', label: '기능 B', kind: 'branch' },
        { key: 'task-a', parentKey: 'branch-a', label: '업무 A', kind: 'task', isWork: true, status: 'in-progress', progress: 30, taskUrl: 'https://example.com/task-a' },
      ],
    })
    const mapId = createdMindmap.document.id
    assert.equal(createdMindmap.cardCount, 4)

    const createdSingle = await invoke('mindnprogress_create_document', {
      title: 'MCP 단일 문서', color: 'green', rootLabel: '단일 루트', rootDescription: '삭제 및 복원 검증',
    })
    const secondaryMapId = createdSingle.map.id
    const secondaryRootId = createdSingle.map.nodes[0].id

    const documents = await invoke('mindnprogress_list_documents')
    assert.deepEqual(documents.maps.map((map) => map.id).sort(), [mapId, secondaryMapId].sort())

    let documentResult = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(documentResult.map.nodes.length, 4)
    const context = await invoke('mindnprogress_get_context', { mapId, cardId: 'task-a' })
    assert.equal(context.selection.card.id, 'task-a')
    assert.equal(context.selection.taskLinks.available.length, 2)

    const users = await invoke('mindnprogress_list_users')
    assert.ok(Array.isArray(users.users))

    documentResult.map.nodes[0].data.description = '전체 저장 회귀 변경'
    const saved = await invoke('mindnprogress_save_document', {
      mapId,
      baseVersion: documentResult.map.version,
      nodes: documentResult.map.nodes,
      edges: documentResult.map.edges,
    })
    assert.ok(saved.map.version > documentResult.map.version)

    const history = await invoke('mindnprogress_list_history', { mapId, limit: 1 })
    assert.equal(history.revisions.length, 1)
    assert.equal(history.hasMore, true)
    assert.equal(history.nextOffset, 1)
    const nextHistory = await invoke('mindnprogress_list_history', { mapId, offset: history.nextOffset, limit: 1 })
    assert.equal(nextHistory.revisions.length, 1)
    assert.notEqual(nextHistory.revisions[0].id, history.revisions[0].id)
    const restoredHistory = await invoke('mindnprogress_restore_history', { mapId, revisionId: history.revisions[0].id })
    assert.equal(restoredHistory.map.id, mapId)

    const addedCardResult = await invoke('mindnprogress_add_card', {
      mapId,
      parentId: 'root',
      data: { label: '추가 카드', description: '', kind: 'branch', status: 'planned', progress: 0 },
    })
    const addedCard = addedCardResult.map.nodes.find((node) => node.data.label === '추가 카드')
    assert.ok(addedCard)

    const updatedCardResult = await invoke('mindnprogress_update_card', {
      mapId,
      nodeId: addedCard.id,
      data: {
        label: '수정된 업무 카드', description: '업데이트 검증', kind: 'task', isWork: true,
        status: 'done', progress: 100, dueDate: '2026-07-31', checklist: [{ id: 'check-regression', text: '완료 조건', done: true }],
      },
      position: { x: 700, y: 220 },
    })
    assert.equal(updatedCardResult.map.nodes.find((node) => node.id === addedCard.id).data.progress, 100)

    const movedCardResult = await invoke('mindnprogress_move_card', { mapId, nodeId: addedCard.id, newParentId: 'branch-b' })
    assert.ok(movedCardResult.map.edges.some((edge) => edge.source === 'branch-b' && edge.target === addedCard.id))

    const deletedCardResult = await invoke('mindnprogress_delete_card', { mapId, nodeId: addedCard.id, includeDescendants: true })
    assert.ok(!deletedCardResult.map.nodes.some((node) => node.id === addedCard.id))

    documentResult = await invoke('mindnprogress_get_document', { mapId })
    const metadataResult = await invoke('mindnprogress_update_document_info', {
      mapId, baseVersion: documentResult.map.version, title: 'MCP 전체 회귀 문서 수정', color: 'red',
    })
    assert.equal(metadataResult.summary.color, 'red')

    const reordered = await invoke('mindnprogress_reorder_documents', { mapIds: [secondaryMapId, mapId] })
    assert.deepEqual(reordered.maps.map((map) => map.id), [secondaryMapId, mapId])

    const notificationsPath = path.join(testDataDirectory, '_notifications')
    await writeFile(notificationsPath, '알림 디렉터리 접근 실패 회귀 조건', 'utf8')
    const commentWithFailedNotification = await invoke('mindnprogress_add_comment', {
      mapId, nodeId: 'root', text: '알림 실패와 무관하게 한 번만 생성되어야 합니다.',
    })
    let commentList = await invoke('mindnprogress_list_comments', { mapId, nodeId: 'root' })
    assert.equal(commentList.comments.filter((comment) => comment.id === commentWithFailedNotification.comment.id).length, 1)
    const deletedWithFailedNotification = await invoke('mindnprogress_delete_comment', {
      mapId, commentId: commentWithFailedNotification.comment.id,
    })
    assert.deepEqual(deletedWithFailedNotification.deletedIds, [commentWithFailedNotification.comment.id])
    await rm(notificationsPath, { force: true })
    await mkdir(notificationsPath, { recursive: true })

    await writeFile(path.join(notificationsPath, 'user-admin.json'), '{', 'utf8')
    const parentComment = await invoke('mindnprogress_add_comment', { mapId, nodeId: 'root', text: '댓글 상태와 반응 검증' })
    const replyComment = await invoke('mindnprogress_add_comment', {
      mapId, nodeId: 'root', parentId: parentComment.comment.id, text: '답글 검증',
    })
    assert.equal(replyComment.comment.parentId, parentComment.comment.id)
    const resolved = await invoke('mindnprogress_set_comment_resolved', {
      mapId, commentId: parentComment.comment.id, resolved: true,
    })
    assert.ok(resolved.comment.resolvedAt)
    const reacted = await invoke('mindnprogress_toggle_comment_reaction', {
      mapId, commentId: parentComment.comment.id, emoji: '👍',
    })
    assert.ok(reacted.comment.reactions['👍'].includes('system-aionui-ai'))
    commentList = await invoke('mindnprogress_list_comments', { mapId, nodeId: 'root' })
    assert.equal(commentList.comments.length, 2)
    const deletedThread = await invoke('mindnprogress_delete_comment', { mapId, commentId: parentComment.comment.id })
    assert.equal(deletedThread.deletedIds.length, 2)

    const integrationNotifications = [
      { id: 'notification-regression-1', userId: 'system-aionui-ai', createdAt: '2026-07-17T00:00:00.000Z', readAt: null, message: '첫 알림' },
      { id: 'notification-regression-2', userId: 'system-aionui-ai', createdAt: '2026-07-17T00:01:00.000Z', readAt: null, message: '둘째 알림' },
    ]
    await writeFile(path.join(notificationsPath, 'system-aionui-ai.json'), `${JSON.stringify(integrationNotifications, null, 2)}\n`, 'utf8')
    const notificationList = await invoke('mindnprogress_list_notifications')
    assert.equal(notificationList.notifications.length, 2)
    const readOne = await invoke('mindnprogress_mark_notification_read', { notificationId: 'notification-regression-1' })
    assert.ok(readOne.notification.readAt)
    const readAll = await invoke('mindnprogress_mark_all_notifications_read')
    assert.ok(readAll.notifications.every((notification) => notification.readAt))

    const trashed = await invoke('mindnprogress_move_document_to_trash', { mapId: secondaryMapId })
    assert.equal(trashed.trashedId, secondaryMapId)
    let trash = await invoke('mindnprogress_list_trash')
    assert.ok(trash.maps.some((map) => map.id === secondaryMapId))
    const restored = await invoke('mindnprogress_restore_document', { mapId: secondaryMapId })
    assert.equal(restored.map.id, secondaryMapId)
    await invoke('mindnprogress_move_document_to_trash', { mapId: secondaryMapId })
    const permanentlyDeleted = await invoke('mindnprogress_delete_trashed_documents', {
      mapIds: [secondaryMapId], confirmPermanentDeletion: true,
    })
    assert.deepEqual(permanentlyDeleted.deletedIds, [secondaryMapId])

    const emptyTarget = await invoke('mindnprogress_create_document', {
      title: '전체 비우기 대상', color: 'amber', rootLabel: '비우기 대상', rootDescription: '',
    })
    await invoke('mindnprogress_move_document_to_trash', { mapId: emptyTarget.map.id })
    const emptied = await invoke('mindnprogress_empty_trash', { confirmPermanentDeletion: true })
    assert.ok(emptied.deletedIds.includes(emptyTarget.map.id))
    trash = await invoke('mindnprogress_list_trash')
    assert.equal(trash.maps.length, 0)

    const finalDocument = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(finalDocument.map.id, mapId)
    assert.ok(!finalDocument.map.nodes.some((node) => node.id === secondaryRootId))

    await invokeExpectError('mindnprogress_create_mindmap', {
      title: '잘못된 다중 루트',
      cards: [
        { key: 'root-a', label: '루트 A', kind: 'root' },
        { key: 'root-b', label: '루트 B', kind: 'root' },
      ],
    }, /루트 카드는 정확히 하나/)
    await invokeExpectError('mindnprogress_create_mindmap', {
      title: '잘못된 하위 루트',
      cards: [
        { key: 'root', label: '루트', kind: 'root' },
        { key: 'nested-root', parentKey: 'root', label: '하위 루트', kind: 'root' },
      ],
    }, /하위 카드는 kind=root/)
    await invokeExpectError('mindnprogress_save_document', {
      mapId,
      baseVersion: Math.max(1, finalDocument.map.version - 1),
      nodes: finalDocument.map.nodes,
      edges: finalDocument.map.edges,
    }, /다른 사용자가 먼저/)
    await invokeExpectError('mindnprogress_move_card', {
      mapId, nodeId: 'branch-a', newParentId: 'task-a',
    }, /자기 자신이나 하위 카드/)
    await invokeExpectError('mindnprogress_delete_card', {
      mapId, nodeId: 'root', includeDescendants: true,
    }, /루트 카드는 삭제할 수 없습니다/)
    await invokeExpectError('mindnprogress_add_comment', {
      mapId, nodeId: 'missing-card', text: '존재하지 않는 카드',
    }, /댓글을 남길 노드를 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_restore_history', {
      mapId, revisionId: 'missing-revision',
    }, /변경 이력을 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_delete_trashed_documents', {
      mapIds: [mapId], confirmPermanentDeletion: false,
    }, /Invalid literal value|Invalid input/)
    await invokeExpectError('mindnprogress_empty_trash', {
      confirmPermanentDeletion: false,
    }, /Invalid literal value|Invalid input/)
    await invokeExpectError('mindnprogress_mark_notification_read', {
      notificationId: 'missing-notification',
    }, /알림을 찾을 수 없습니다/)
    await invokeExpectError('mindnprogress_move_document_to_trash', { mapId }, /마지막 문서/)

    const afterRejectedOperations = await invoke('mindnprogress_get_document', { mapId })
    assert.equal(afterRejectedOperations.map.version, finalDocument.map.version)

    const uncalledTools = registeredToolNames.filter((name) => !calledTools.has(name))
    assert.deepEqual(uncalledTools, [], `호출되지 않은 MCP 도구: ${uncalledTools.join(', ')}`)
    console.log(JSON.stringify({
      registeredTools: registeredToolNames.length,
      calledTools: calledTools.size,
      totalCalls: [...calledTools.values()].reduce((sum, count) => sum + count, 0),
      status: 'passed',
    }, null, 2))
  } catch (error) {
    if (serverLogs.length > 0) console.error(serverLogs.join(''))
    throw error
  } finally {
    if (client) await client.close().catch(() => undefined)
    if (apiServer.exitCode === null) {
      apiServer.kill()
      await new Promise((resolve) => apiServer.once('exit', resolve))
    }
    await rm(testDataDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
