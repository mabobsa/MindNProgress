import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

const projectDirectory = path.resolve(import.meta.dirname, '..')
const childOutputLimit = 8_000

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function captureChildOutput(child) {
  let stdout = ''
  let stderr = ''
  const append = (current, chunk) => `${current}${chunk}`.slice(-childOutputLimit)

  child.stdout?.on('data', (chunk) => {
    stdout = append(stdout, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderr = append(stderr, chunk)
  })

  return () => [
    `child stdout:\n${stdout.trim() || '(비어 있음)'}`,
    `child stderr:\n${stderr.trim() || '(비어 있음)'}`,
  ].join('\n')
}

function childTermination(child) {
  if (hasExited(child)) {
    return Promise.resolve({ kind: 'exit', code: child.exitCode, signal: child.signalCode })
  }

  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ kind: 'error', error }))
    child.once('exit', (code, signal) => resolve({ kind: 'exit', code, signal }))
  })
}

function formatStartupError(message, child, output, lastHealthError) {
  const state = `exitCode=${String(child.exitCode)}, signalCode=${String(child.signalCode)}`
  const health = lastHealthError ? `마지막 health 오류: ${lastHealthError}` : '마지막 health 오류: 없음'
  return new Error(`${message}\nchild 상태: ${state}\n${health}\n${output()}`)
}

function throwIfTerminated(result, child, output, lastHealthError) {
  if (result.kind === 'error') {
    throw formatStartupError(
      `AI 대화 탐색 API 검증 서버 프로세스를 시작하지 못했습니다: ${result.error.message}`,
      child,
      output,
      lastHealthError,
    )
  }
  if (result.kind === 'exit') {
    throw formatStartupError(
      `AI 대화 탐색 API 검증 서버가 준비 전에 종료되었습니다: code=${String(result.code)}, signal=${String(result.signal)}`,
      child,
      output,
      lastHealthError,
    )
  }
}

async function findAvailablePort() {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })

  const address = probe.address()
  if (!address || typeof address === 'string') {
    probe.close()
    throw new Error('운영체제가 할당한 테스트 포트를 확인할 수 없습니다.')
  }

  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()))
  })
  return address.port
}

async function waitForServer(baseUrl, child, output, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  const terminated = childTermination(child)
  let lastHealthError = ''

  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw formatStartupError(
        `AI 대화 탐색 API 검증 서버가 ${timeoutMs}ms 안에 시작되지 않았습니다.`,
        child,
        output,
        lastHealthError,
      )
    }

    const health = fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(Math.min(1_000, remaining)),
    }).then(
      (response) => ({ kind: 'health', ok: response.ok, status: response.status }),
      (error) => ({ kind: 'health', ok: false, error }),
    )
    const result = await Promise.race([health, terminated])
    throwIfTerminated(result, child, output, lastHealthError)
    if (result.ok) return

    lastHealthError = result.error?.message ?? `HTTP ${result.status}`
    const pause = new Promise((resolve) => {
      setTimeout(() => resolve({ kind: 'pause' }), Math.min(100, remaining))
    })
    const pauseResult = await Promise.race([pause, terminated])
    throwIfTerminated(pauseResult, child, output, lastHealthError)
  }
}

async function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return true

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function stopProcess(child, output) {
  if (hasExited(child) || child.pid == null) return

  child.kill()
  if (await waitForExit(child, 2_000)) return

  child.kill('SIGKILL')
  if (await waitForExit(child, 2_000)) return

  throw new Error(`AI 대화 탐색 API 검증 서버 프로세스를 종료하지 못했습니다.\n${output()}`)
}

async function readUntil(reader, pattern, timeoutMs = 3_000) {
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + timeoutMs
  while (!pattern.test(received)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`이벤트 수신 제한 시간을 초과했습니다: ${received}`)
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('이벤트 수신 제한 시간을 초과했습니다.')), remaining)),
    ])
    if (result.done) break
    received += decoder.decode(result.value, { stream: true })
  }
  return received
}

async function readFor(reader, durationMs) {
  const decoder = new TextDecoder()
  let received = ''
  const deadline = Date.now() + durationMs
  while (Date.now() < deadline) {
    let timer
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())) }),
    ])
    clearTimeout(timer)
    if (!result || result.done) break
    received += decoder.decode(result.value, { stream: true })
  }
  return received
}

test('AionUi 대화 조회와 화면 선택은 연결된 카드 및 같은 계정·디바이스의 MnP 화면에만 적용된다', { timeout: 30_000 }, async () => {
  const port = await findAvailablePort()
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mindnprogress-ai-conversation-navigation-'))
  const mapId = 'map-conversation-navigation'
  const cardId = 'card-navigation'
  const conversationId = 'conversation-navigation'
  const auxiliaryConversationId = 'conversation-navigation-auxiliary'
  const legacyConversationId = 'conversation-legacy'
  const cardOwnerConversationId = 'conversation-card-owner'
  const attributionConversationId = 'conversation-attribution-owner'
  const viewerConversationId = 'conversation-viewer-owner'
  const inactiveConversationId = 'conversation-inactive-owner'
  const groupId = 'group-conversation-navigation'
  const linkedAt = '2026-09-15T00:00:00.000Z'
  const linkedCard = (id, label, linkedConversationId, startedBy = null) => ({
    id,
    type: 'mind',
    position: { x: 0, y: 0 },
    data: {
      label,
      kind: id === cardId ? 'root' : 'task',
      progress: 0,
      status: 'planned',
      aiConversationId: linkedConversationId,
      aiConversations: [{
        conversationId: linkedConversationId,
        linkedAt,
        ...(startedBy ? { startedBy: { id: startedBy, label: startedBy } } : {}),
      }, ...(id === cardId ? [{ conversationId: auxiliaryConversationId, linkedAt: '2026-09-14T00:00:00.000Z' }] : [])],
    },
  })
  await writeFile(path.join(dataDirectory, `${mapId}.json`), JSON.stringify({
    id: mapId,
    title: '대화 탐색 문서',
    nodes: [
      linkedCard(cardId, '대화 탐색 카드', conversationId, 'user-admin'),
      linkedCard('card-legacy', '레거시 카드', legacyConversationId),
      linkedCard('card-owner-link', '카드 소유자 기록', cardOwnerConversationId, 'user-admin'),
      linkedCard('card-owner-attribution', '귀속 소유자 기록', attributionConversationId),
      linkedCard('card-viewer', '열람자 소유 카드', viewerConversationId, 'user-public-viewer'),
      linkedCard('card-inactive', '비활성 소유 카드', inactiveConversationId, 'user-inactive'),
    ],
    edges: [],
    version: 1,
    updatedAt: linkedAt,
  }))
  await writeFile(path.join(dataDirectory, '_map-order.json'), JSON.stringify({
    version: 1,
    items: [{ type: 'group', id: groupId }],
    groups: [{ id: groupId, name: '변경된 그룹 이름', mapIds: [mapId] }],
  }))
  await mkdir(path.join(dataDirectory, '_group-projects'))
  const rootMapId = 'map-document-root-title'
  const rootConversationId = 'conversation-document-root-title'
  await writeFile(path.join(dataDirectory, `${rootMapId}.json`), JSON.stringify({
    id: rootMapId,
    title: '일반 문서',
    nodes: [linkedCard('document-root', '문서 루트', rootConversationId, 'user-admin')],
    edges: [], version: 1, updatedAt: linkedAt,
  }))
  await writeFile(path.join(dataDirectory, '_group-projects', `${groupId}.json`), JSON.stringify({
    version: 1,
    coordinatorMapId: mapId,
    objective: '',
    instructions: '',
  }))
  await writeFile(path.join(dataDirectory, '_ai-conversation-origins.json'), JSON.stringify([
    { conversationId: rootConversationId, mapId: rootMapId, cardId: 'document-root', startedBy: 'user-admin', linkedAt },
    { conversationId, mapId, cardId, startedBy: 'user-admin', homeMachineId: 'macbook', linkedAt },
    { conversationId: auxiliaryConversationId, mapId, cardId, startedBy: 'user-admin', homeMachineId: 'macbook', linkedAt },
    { conversationId: legacyConversationId, mapId, cardId: 'card-legacy', linkedAt },
    { conversationId: cardOwnerConversationId, mapId, cardId: 'card-owner-link', linkedAt },
    { conversationId: attributionConversationId, mapId, cardId: 'card-owner-attribution', linkedAt },
    { conversationId: viewerConversationId, mapId, cardId: 'card-viewer', startedBy: 'user-public-viewer', linkedAt },
    { conversationId: inactiveConversationId, mapId, cardId: 'card-inactive', startedBy: 'user-inactive', linkedAt },
  ]))
  await writeFile(path.join(dataDirectory, '_ai-conversation-attributions.json'), JSON.stringify([{
    mapId,
    cardId: 'card-owner-attribution',
    conversationId: attributionConversationId,
    authorName: '테스트 AI',
    startedBy: 'user-admin',
    linkedAt,
  }]))
  await writeFile(path.join(dataDirectory, '_users.json'), JSON.stringify([{
    id: 'user-inactive',
    name: '비활성 편집자',
    email: 'inactive@mind.local',
    role: 'editor',
    active: false,
    salt: '00',
    passwordHash: '00'.repeat(64),
  }]))

  const baseUrl = `http://127.0.0.1:${port}`
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      MNP_DATA_DIR: dataDirectory,
      MNP_API_HOST: '127.0.0.1',
      MNP_API_PORT: String(port),
      MNP_WEB_PORT: String(port),
      MNP_EVENT_HEARTBEAT_INTERVAL_MS: '60000',
      MNP_ADMIN_EMAIL: 'navigation-admin@mind.local',
      MNP_ADMIN_PASSWORD: 'navigation-admin-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = captureChildOutput(server)
  const localController = new AbortController()
  const remoteController = new AbortController()
  const otherAccountController = new AbortController()
  const otherLocalAccountController = new AbortController()

  try {
    await waitForServer(baseUrl, server, output)
    const token = (await readFile(path.join(dataDirectory, '_integration-token'), 'utf8')).trim()
    const headers = { Authorization: `Bearer ${token}` }
    const accountHeaders = { ...headers, 'X-MNP-AI-Editor-Id': 'user-admin' }
    const remoteHeaders = {
      ...headers,
      'X-MNP-Selection-Device-Address': '10.77.15.55',
    }
    const endpointFor = (id) => `${baseUrl}/api/integrations/aionui/conversations/${id}/mindnprogress`
    const endpoint = endpointFor(conversationId)

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'navigation-admin@mind.local', password: 'navigation-admin-password' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const machine = await fetch(`${baseUrl}/api/machines`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId: 'macbook', label: '탐색 검증 서브 머신', platform: 'darwin' }),
    })
    assert.equal(machine.status, 200)
    const issued = await fetch(`${baseUrl}/api/machines/macbook/token`, { method: 'POST', headers: { Cookie: cookie } })
    assert.equal(issued.status, 200)
    const runnerToken = (await issued.json()).token
    const runnerHeaders = {
      Authorization: `Bearer ${runnerToken}`,
      'X-MnP-Runner-MCP-Machine-Id': 'macbook',
      'X-MnP-AI-Conversation-Id': conversationId,
      'X-MnP-Selection-Device-Address': '10.77.15.55',
    }

    const unauthorized = await fetch(endpoint)
    assert.equal(unauthorized.status, 401)

    const missingResponse = await fetch(`${baseUrl}/api/integrations/aionui/conversations/not-linked/mindnprogress`, { headers: accountHeaders })
    assert.equal(missingResponse.status, 200)
    assert.deepEqual(await missingResponse.json(), {
      conversationId: 'not-linked',
      exists: false,
      target: null,
      selectionAvailable: false,
      matchingViewCount: 0,
      localSelectionAvailable: false,
      localViewCount: 0,
      message: 'MindNProgress 카드에 연결된 대화를 찾을 수 없습니다.',
    })

    let lookup = await (await fetch(endpoint, { headers })).json()
    assert.deepEqual(lookup, {
      conversationId,
      exists: true,
      target: {
        mapId,
        documentTitle: '대화 탐색 문서',
        cardId,
        cardTitle: '대화 탐색 카드',
        archived: false,
        titlePrefix: '[그룹 총괄] ',
        cardRole: 'group-coordinator',
        conversationRole: 'primary',
        primaryConversationId: conversationId,
        group: {
          id: groupId,
          title: '변경된 그룹 이름',
          role: 'coordinator',
        },
      },
      selectionAvailable: false,
      matchingViewCount: 0,
      localSelectionAvailable: false,
      localViewCount: 0,
      message: 'MindNProgress에 연결된 대화입니다.',
    })

    const matchingHeaderLookup = await fetch(endpoint, { headers: accountHeaders })
    assert.equal(matchingHeaderLookup.status, 200)
    const auxiliaryLookup = await (await fetch(endpointFor(auxiliaryConversationId), { headers })).json()
    assert.equal(auxiliaryLookup.exists, true)
    assert.equal(auxiliaryLookup.target.cardRole, 'group-coordinator')
    assert.equal(auxiliaryLookup.target.conversationRole, 'auxiliary')
    assert.equal(auxiliaryLookup.target.primaryConversationId, conversationId)
    assert.equal(auxiliaryLookup.target.titlePrefix, '[그룹 총괄] ', '그룹 총괄 카드의 보조 대화도 카드 역할 접두어는 유지한다')
    const rootLookupResponse = await fetch(`${baseUrl}/api/integrations/aionui/conversations/${rootConversationId}/mindnprogress`, { headers })
    assert.equal(rootLookupResponse.status, 200)
    const rootLookup = await rootLookupResponse.json()
    assert.equal(rootLookup.target.titlePrefix, '[상위] ')
    assert.equal(rootLookup.target.cardRole, 'document-root')
    assert.equal(rootLookup.target.conversationRole, 'primary')
    assert.equal(rootLookup.target.primaryConversationId, rootConversationId)
    assert.equal(rootLookup.target.group, undefined)

    const mismatchingHeaderLookup = await fetch(endpoint, {
      headers: { ...headers, 'X-MNP-AI-Editor-Id': 'user-public-viewer' },
    })
    assert.equal(mismatchingHeaderLookup.status, 403)
    assert.equal((await mismatchingHeaderLookup.json()).code, 'MNP_SELECTION_ACCOUNT_MISMATCH')

    const missingAccount = await fetch(`${endpointFor(legacyConversationId)}/select`, { method: 'POST', headers })
    assert.equal(missingAccount.status, 400)
    assert.equal((await missingAccount.json()).code, 'MNP_SELECTION_ACCOUNT_REQUIRED')

    const trustedLegacyAccount = await fetch(`${endpointFor(legacyConversationId)}/select`, {
      method: 'POST',
      headers: accountHeaders,
    })
    assert.equal(trustedLegacyAccount.status, 409)
    assert.equal((await trustedLegacyAccount.json()).code, 'MNP_MATCHING_VIEW_NOT_CONNECTED')

    for (const unavailableConversationId of [viewerConversationId, inactiveConversationId]) {
      const unavailableAccount = await fetch(`${endpointFor(unavailableConversationId)}/select`, { method: 'POST', headers })
      assert.equal(unavailableAccount.status, 403)
      assert.equal((await unavailableAccount.json()).code, 'MNP_SELECTION_ACCOUNT_UNAVAILABLE')
    }

    const invalidDevice = await fetch(`${endpoint}/select`, {
      method: 'POST',
      headers: { ...headers, 'X-MNP-Selection-Device-Address': 'not-an-ip-address' },
    })
    assert.equal(invalidDevice.status, 400)
    assert.equal((await invalidDevice.json()).code, 'MNP_SELECTION_DEVICE_ADDRESS_INVALID')

    const noMatchingView = await fetch(`${endpoint}/select`, { method: 'POST', headers })
    assert.equal(noMatchingView.status, 409)
    assert.equal((await noMatchingView.json()).code, 'MNP_MATCHING_VIEW_NOT_CONNECTED')

    const localStream = await fetch(`${baseUrl}/api/events?clientId=local-navigation`, {
      headers: accountHeaders,
      signal: localController.signal,
    })
    const remoteStream = await fetch(`${baseUrl}/api/events?clientId=remote-navigation`, {
      headers: { ...accountHeaders, 'X-Forwarded-For': '10.77.15.55' },
      signal: remoteController.signal,
    })
    const otherAccountStream = await fetch(`${baseUrl}/api/events?clientId=other-account-navigation`, {
      headers: { ...headers, 'X-Forwarded-For': '10.77.15.55' },
      signal: otherAccountController.signal,
    })
    assert.equal(localStream.status, 200)
    assert.equal(remoteStream.status, 200)
    assert.equal(otherAccountStream.status, 200)
    const localReader = localStream.body.getReader()
    const remoteReader = remoteStream.body.getReader()
    const otherAccountReader = otherAccountStream.body.getReader()
    await readUntil(localReader, /"type":"connected"/)
    await readUntil(remoteReader, /"type":"connected"/)
    await readUntil(otherAccountReader, /"type":"connected"/)

    lookup = await (await fetch(endpoint, { headers })).json()
    assert.equal(lookup.selectionAvailable, true)
    assert.equal(lookup.matchingViewCount, 1)
    assert.equal(lookup.localSelectionAvailable, true)
    assert.equal(lookup.localViewCount, 1)

    for (const serverOwnedConversationId of [cardOwnerConversationId, attributionConversationId]) {
      const fallbackLookup = await (await fetch(endpointFor(serverOwnedConversationId), { headers })).json()
      assert.equal(fallbackLookup.selectionAvailable, true)
      assert.equal(fallbackLookup.matchingViewCount, 1)
      assert.equal(fallbackLookup.target.group, undefined)
      assert.equal(fallbackLookup.target.titlePrefix, '')
      assert.equal(fallbackLookup.target.cardRole, 'card')
      assert.equal(fallbackLookup.target.conversationRole, 'primary')
      assert.equal(fallbackLookup.target.primaryConversationId, serverOwnedConversationId)
    }

    const remoteLookup = await (await fetch(endpoint, { headers: remoteHeaders })).json()
    assert.equal(remoteLookup.selectionAvailable, true)
    assert.equal(remoteLookup.matchingViewCount, 1)

    const remoteSelectionResponse = await fetch(`${endpoint}/select`, {
      method: 'POST',
      headers: remoteHeaders,
    })
    assert.equal(remoteSelectionResponse.status, 200)
    const remoteSelection = await remoteSelectionResponse.json()
    assert.equal(remoteSelection.selected, true)
    assert.equal(remoteSelection.deliveredClientCount, 1)
    assert.deepEqual(remoteSelection.target, lookup.target)
    assert.doesNotMatch(JSON.stringify(remoteSelection), /user-admin|10\.77\.15\.55|selectionDeviceKey|recordedStartedBy/)

    const remoteEvents = await readUntil(remoteReader, new RegExp(remoteSelection.requestedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(remoteEvents, /"type":"ai-conversation-selection-requested"/)
    assert.match(remoteEvents, new RegExp(`"mapId":"${mapId}"`))
    assert.match(remoteEvents, new RegExp(`"cardId":"${cardId}"`))

    const runnerLookup = await fetch(endpoint, { headers: runnerHeaders })
    assert.equal(runnerLookup.status, 200)
    const runnerLink = await runnerLookup.json()
    assert.equal(runnerLink.exists, true)
    assert.equal(runnerLink.matchingViewCount, 1)
    assert.deepEqual(runnerLink.target, lookup.target)

    const runnerSelectionResponse = await fetch(`${endpoint}/select`, { method: 'POST', headers: runnerHeaders })
    assert.equal(runnerSelectionResponse.status, 200)
    const runnerSelection = await runnerSelectionResponse.json()
    assert.equal(runnerSelection.deliveredClientCount, 1)
    assert.doesNotMatch(JSON.stringify(runnerSelection), /user-admin|10\.77\.15\.55|mnprl_|selectionDeviceKey/)
    const runnerEvents = await readUntil(remoteReader, /"type":"ai-conversation-selection-requested"/)
    assert.match(runnerEvents, new RegExp(`"cardId":"${cardId}"`))

    const otherMachineConversation = await fetch(endpointFor(legacyConversationId), {
      headers: { ...runnerHeaders, 'X-MnP-AI-Conversation-Id': legacyConversationId },
    })
    assert.equal(otherMachineConversation.status, 403)
    assert.equal((await otherMachineConversation.json()).code, 'MNP_RUNNER_MCP_CONVERSATION_DENIED')

    const localSelectionResponse = await fetch(`${endpoint}/select`, { method: 'POST', headers: accountHeaders })
    assert.equal(localSelectionResponse.status, 200)
    const localSelection = await localSelectionResponse.json()
    assert.equal(localSelection.deliveredClientCount, 1)

    const localEvents = await readUntil(localReader, new RegExp(localSelection.requestedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(localEvents, new RegExp(`"mapId":"${mapId}"`))
    assert.match(localEvents, new RegExp(`"cardId":"${cardId}"`))
    assert.doesNotMatch(localEvents, new RegExp(remoteSelection.requestedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(localEvents, new RegExp(runnerSelection.requestedAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const otherLocalAccountStream = await fetch(`${baseUrl}/api/events?clientId=other-local-account-navigation`, {
      headers,
      signal: otherLocalAccountController.signal,
    })
    assert.equal(otherLocalAccountStream.status, 200)
    const otherLocalAccountReader = otherLocalAccountStream.body.getReader()
    await readUntil(otherLocalAccountReader, /"type":"connected"/)

    // A remote Aion host forwards the main PC's LAN address while its MnP tab
    // uses loopback. Both must select only that account's local tab.
    const localAddresses = new Set([
      '::1',
      '127.0.0.2',
      ...Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address)),
    ])
    for (const address of localAddresses) {
      const localRunnerHeaders = { ...runnerHeaders, 'X-MnP-Selection-Device-Address': address }
      const localRunnerLookup = await fetch(endpoint, { headers: localRunnerHeaders })
      assert.equal(localRunnerLookup.status, 200, `local address: ${address}`)
      const localRunnerLink = await localRunnerLookup.json()
      assert.equal(localRunnerLink.selectionAvailable, true, `local address: ${address}`)
      assert.equal(localRunnerLink.matchingViewCount, 1, 'other accounts on the same device must not match')

      const localRunnerSelection = await fetch(`${endpoint}/select`, { method: 'POST', headers: localRunnerHeaders })
      assert.equal(localRunnerSelection.status, 200, `local address: ${address}`)
      assert.equal((await localRunnerSelection.json()).deliveredClientCount, 1)
      const localRunnerEvents = await readUntil(localReader, /"type":"ai-conversation-selection-requested"/)
      assert.match(localRunnerEvents, new RegExp(`"cardId":"${cardId}"`))
    }

    const otherLocalAccountEvents = await readFor(otherLocalAccountReader, 250)
    assert.doesNotMatch(otherLocalAccountEvents, /"type":"ai-conversation-selection-requested"/)
    await otherLocalAccountReader.cancel()

    const mismatchingSelection = await fetch(`${endpoint}/select`, {
      method: 'POST',
      headers: { ...headers, 'X-MNP-AI-Editor-Id': 'user-public-viewer' },
    })
    assert.equal(mismatchingSelection.status, 403)
    const mismatchingSelectionBody = await mismatchingSelection.json()
    assert.equal(mismatchingSelectionBody.code, 'MNP_SELECTION_ACCOUNT_MISMATCH')
    assert.doesNotMatch(JSON.stringify(mismatchingSelectionBody), /user-admin|user-public-viewer/)

    const unexpectedRemoteEvents = await readFor(remoteReader, 250)
    assert.doesNotMatch(unexpectedRemoteEvents, /"type":"ai-conversation-selection-requested"/)
    const otherAccountEvents = await readFor(otherAccountReader, 250)
    assert.doesNotMatch(otherAccountEvents, /"type":"ai-conversation-selection-requested"/)
    const unexpectedLocalEvents = await readFor(localReader, 250)
    assert.doesNotMatch(unexpectedLocalEvents, /"type":"ai-conversation-selection-requested"/)

    await localReader.cancel()
    await remoteReader.cancel()
    await otherAccountReader.cancel()
  } finally {
    localController.abort()
    remoteController.abort()
    otherAccountController.abort()
    otherLocalAccountController.abort()
    try {
      await stopProcess(server, output)
    } finally {
      await rm(dataDirectory, { recursive: true, force: true })
    }
  }
})
