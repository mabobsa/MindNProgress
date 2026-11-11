import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fixture, storageApi } from './helpers/storage-api-harness.mjs'
import { aiDelegationPolicy } from '../server/lib/aiDelegationPolicy.mjs'
import { rootHandoffDocumentHash } from '../server/lib/rootConversationHandoff.mjs'

const pause = () => new Promise(resolve => setTimeout(resolve, 40))
async function until(action, label) {
  let last
  for (let i = 0; i < 150; i++) { last = await action(); if (last) return last; await pause() }
  assert.fail(typeof label === 'function' ? label() : label)
}
const options = (...values) => values.map(value => ({ value, name: value }))
const agents = [
  { id: 'claude', name: 'Claude Code', backend: 'claude', installed: true, enabled: true,
    available_models: { available_models: options('opus') }, available_modes: { available_modes: options('acceptEdits') },
    config_options: [{ id: 'effort', category: 'thought_level', options: options('high', 'xhigh', 'max') }] },
  { id: 'codex', name: 'Codex CLI', backend: 'codex', installed: true, enabled: true,
    available_models: { available_models: options('gpt-6-astra') }, available_modes: { available_modes: options('full-access') },
    config_options: [{ id: 'reasoning_effort', category: 'thought_level', options: options('high', 'xhigh', 'max') }] },
]

for (const nextBackend of ['codex', 'claude']) test(`루트 CLI 인계 ${nextBackend}: 보고 대기·설정 검증·후속 인수·재시작 후 한 번만 전달`, { timeout: 60_000 }, async (t) => {
  const previousBackend = nextBackend === 'codex' ? 'claude' : 'codex'
  const model = backend => backend === 'codex' ? 'gpt-6-astra' : 'opus'
  const mode = backend => backend === 'codex' ? 'full-access' : 'acceptEdits'
  const configs = new Map(['parent', 'previous', 'auxiliary'].map(id => [id, {
    backend: id === 'auxiliary' ? nextBackend : previousBackend, level: 'high',
  }]))
  const dispatches = new Map(), sends = []
  let baselineMap
  let configSource = 'runtime', correctConfig = true, losePrepareResponse = true
  const remote = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost').pathname
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: status < 400, data })) }
    if (url === '/api/agents/management') return send(agents)
    if (url === '/api/internal/conversation-runtimes/active') return send({ schema_version: 1, items: [] })
    if (url === '/api/internal/external-conversation-dispatches/capabilities') return send({ schemaVersion: 3, explicitCompletionAfterInterruption: true, historyOnlyReports: true })
    if (url === '/api/internal/external-conversation-dispatches' && req.method === 'POST') {
      sends.push(body)
      const id = body.targetConversationId ?? 'successor'
      if (body.create) configs.set(id, { backend: body.create.agentId, level: body.create.thoughtLevel })
      const result = { operationId: body.operationId, conversationId: id, turnId: `turn-${sends.length}`, state: 'running' }
      dispatches.set(body.operationId, result)
      if (body.operationId.startsWith('rhp:') && losePrepareResponse) { losePrepareResponse = false; res.destroy(); return }
      return send(result, 202)
    }
    if (url.startsWith('/api/internal/external-conversation-dispatches/')) {
      const result = dispatches.get(decodeURIComponent(url.split('/').at(-1)))
      return send(result ?? {}, result ? 200 : 404)
    }
    if (url.startsWith('/api/conversations/')) {
      const id = url.split('/')[3], config = configs.get(id)
      if (!config) return send({}, 404)
      const runtime = { state: 'idle', can_send_message: true, is_processing: false, pending_confirmations: 0 }
      if (url.endsWith('/runtime-config')) return send({ model: { value: model(config.backend), source: configSource },
        mode: { value: mode(config.backend), source: configSource }, thought_level: { value: correctConfig ? config.level : 'high', source: configSource } })
      if (url.endsWith('/runtime/ensure')) return send({ runtime, config_options: agents.find(a => a.id === config.backend).config_options })
      if (req.method === 'PUT') { config.level = body.value; return send({ confirmation: 'observed' }) }
      return send({ id, type: 'acp', extra: { agent_id: config.backend, backend: config.backend, current_model_id: model(config.backend) }, runtime })
    }
    return send([])
  })
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => remote.close(resolve)))
  const api = await storageApi(t, { documents: 2,
    env: { MNP_AIONUI_URL: `http://127.0.0.1:${remote.address().port}`, MNP_AI_DELEGATION_POLL_INTERVAL_MS: '100' },
    seed: async ({ data, ids }) => {
      const link = id => ({ conversationId: id, homeMachineId: 'isolated-storage', agent: { id: configs.get(id).backend, label: configs.get(id).backend },
        model: { id: model(configs.get(id).backend), label: model(configs.get(id).backend) }, workspace: 'C:/fixture/integration', skills: [], mcpServers: [], startedAt: '2026-11-10T00:00:00Z' })
      for (const [index, conversationId] of [[0, 'parent'], [1, 'previous']]) {
        const map = fixture(ids[index]); Object.assign(map.nodes[0].data, { aiPrimaryConversationId: conversationId, aiConversationId: conversationId,
          aiConversations: [link(conversationId), ...(index ? [{ ...link('auxiliary'), startedAt: '2026-11-11T00:00:00Z' }] : [])] })
        await writeFile(path.join(data, `${ids[index]}.json`), JSON.stringify(map))
      }
      await writeFile(path.join(data, '_ai-conversation-origins.json'), JSON.stringify(['parent', 'previous'].map((conversationId, i) => ({
        mapId: ids[i], cardId: 'card-0', conversationId, homeMachineId: 'isolated-storage', startedBy: 'user-editor',
      }))))
      const policy = structuredClone(aiDelegationPolicy)
      for (const row of policy.rules.filter(row => row.cardLevel === 'document-root')) Object.assign(row, {
        agent: { backend: nextBackend, label: nextBackend }, modelId: model(nextBackend), thoughtLevelId: 'xhigh',
      })
      await writeFile(path.join(data, '_ai-delegation-policy.json'), JSON.stringify({ version: 1, ...policy }))
      await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify([{ id: 'old-work', mapId: ids[1], parentCardId: 'card-0', targetCardId: 'card-1',
        parentConversationId: 'previous', targetConversationId: 'worker', state: 'completed', reportPending: true, createdAt: new Date().toISOString() }]))
      await writeFile(path.join(data, '_map-order.json'), JSON.stringify({ version: 1, items: [{ type: 'group', id: 'group-handoff' }],
        groups: [{ id: 'group-handoff', name: '인계 시험', mapIds: ids }] }))
      await mkdir(path.join(data, '_group-projects'), { recursive: true })
      await writeFile(path.join(data, '_group-projects/group-handoff.json'), JSON.stringify({ version: 1, coordinatorMapId: ids[0], sources: [] }))
    } })
  const [parentMap, targetMap] = api.ids
  const origin = (id, mapId) => ({ 'X-MNP-AI-Conversation-Id': id, 'X-MNP-AI-Map-Id': mapId, 'X-MNP-AI-Card-Id': 'card-0' })
  const groupPath = `/api/maps/${parentMap}/group-document-instructions`
  const currentMap = async () => (await api.call(`/api/maps/${targetMap}`)).body.map
  const primary = async () => (await currentMap()).nodes[0].data.aiPrimaryConversationId
  const request = { targetMapId: targetMap, targetRevision: 1, sourceRevision: 1, groupProjectVersion: 1,
    strategy: 'resume', conversationId: 'previous', workType: 'other', analysisDepth: 'standard',
    instructionType: 'planning', approvalScope: 'analysis-only', approvalEvidence: '사용자가 현재 문서 분석을 요청했습니다.',
    instruction: '인계 완료 뒤에만 이 업무를 분석하세요.', decisionReason: '사용자 설정에 맞춰 실행', idempotencyKey: `handoff-${nextBackend}` }
  const submitted = await api.call(groupPath, 'POST', request, origin('parent', parentMap))
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body))
  assert.equal(submitted.body.reasonCode, 'GROUP_DOCUMENT_INSTRUCTION_HANDOFF_WORK_PENDING')
  baselineMap = await currentMap()
  assert.equal(sends.length, 0); assert.equal(await primary(), 'previous')
  // 격리 데이터에서 기존 보고 완료를 재현하고 서버를 다시 읽힌다.
  await api.stop()
  await writeFile(path.join(api.data, '_ai-delegations.json'), JSON.stringify([]))
  await api.restart()
  const query = async () => (await api.call(`${groupPath}?instructionId=${request.idempotencyKey}`)).body.instructions?.[0]
  await api.tick(100)
  await until(async () => sends.some(s => s.operationId.startsWith('rhp:')), '기존 담당에게 인계 요청이 전달되지 않았습니다.')
  const planned = await query(), handoff = planned.rootHandoff
  assert.equal(sends[0].targetConversationId, 'previous')
  assert.equal(sends[0].create, undefined); assert.equal(await primary(), 'previous')
  assert.match(sends[0].instruction, /인계 준비만/)
  const startPath = `/api/maps/${targetMap}/cards/card-0/ai-conversation-starts`
  const startBody = { requestId: handoff.requestId, predecessorConversationId: 'previous', newConversation: handoff.newConversation,
    initialMessage: '승인 범위: 분석만. 사용자 대기 지시와 기존 회신 대상을 유지합니다. 미완료는 서버 계약 확인입니다.',
    decisionReason: '규칙에 따른 루트 CLI 전환', approvalEvidence: `서버 위임 규칙 ${handoff.policyRevision}에 따른 인계` }
  correctConfig = false
  assert.equal((await api.call(startPath, 'POST', startBody, origin('previous', targetMap))).status, 202)
  const result = (id = 'previous', acceptHandoff = false) => api.call(startPath, 'POST', { requestId: handoff.requestId, resultOnly: true, acceptHandoff }, origin(id, targetMap))
  await until(async () => (await result()).body.conversationId === 'successor', '후속 대화가 생성되지 않았습니다.')
  assert.equal(await primary(), 'previous', '실행 설정 불일치 상태에서는 담당을 바꾸지 않는다')
  correctConfig = true
  await until(async () => (await result()).body.state === 'awaiting-acceptance', '후속 대화의 인수 확인 대기 상태가 아닙니다.')
  assert.equal(await primary(), 'previous', '설정이 맞아도 후속 인수 확인 전에는 담당을 바꾸지 않는다')
  correctConfig = false
  assert.equal((await result('previous', true)).status, 403, '이전 담당은 후속 담당의 인수 확인을 대신할 수 없다')
  assert.equal((await result('successor', true)).status, 202)
  assert.equal(await primary(), 'previous', '인수했어도 잘못된 사고 강도이면 담당을 바꾸지 않는다')
  if (nextBackend === 'codex') {
    // 첫 필드 시험과 같이 연결 저장 뒤 속성 순서만 달라져 실패한 구버전 기록을 재현한다.
    await api.stop()
    const storedInstructions = await api.read('_group-document-instructions.json')
    const stored = storedInstructions.find(item => item.id === request.idempotencyKey)
    delete stored.rootHandoff.documentHashVersion
    stored.rootHandoff.documentHash = rootHandoffDocumentHash(baselineMap, 'card-0', 1)
    stored.state = 'failed'; stored.reasonCode = 'GROUP_DOCUMENT_INSTRUCTION_HANDOFF_REVISION_CHANGED'
    await writeFile(path.join(api.data, '_group-document-instructions.json'), JSON.stringify(storedInstructions))
    const starts = await api.read('_card-conversation-starts.json'), start = starts.find(item => item.requestId === handoff.requestId)
    start.state = 'recovery-required'; start.reasonCode = 'CARD_CONVERSATION_START_POLICY_CHANGED'
    const acceptedAt = start.acceptedAt
    await writeFile(path.join(api.data, '_card-conversation-starts.json'), JSON.stringify(starts))
    const document = await api.read(`${targetMap}.json`)
    document.nodes[1].data = Object.fromEntries(Object.entries(document.nodes[1].data).reverse())
    const actualChange = structuredClone(document); actualChange.nodes[1].data.description += ' 사용자 요구사항 변경'
    await writeFile(path.join(api.data, `${targetMap}.json`), JSON.stringify(actualChange))
    await api.restart()
    assert.equal((await query()).state, 'failed', '실제 내용이 바뀐 건은 재시작해도 복구하지 않는다')
    assert.equal(await primary(), 'previous')
    await api.stop()
    await writeFile(path.join(api.data, `${targetMap}.json`), JSON.stringify(document))
    await api.restart()
    const recovered = await query()
    assert.equal(recovered.state, 'queued', JSON.stringify(recovered) + '\n' + api.output().split('\n').filter(line => line.includes('Root handoff hash')).join('\n'))
    assert.equal(recovered.rootHandoff.documentHashVersion, 2)
    assert.equal(recovered.rootHandoff.legacyDocumentHash, stored.rootHandoff.documentHash)
    assert.ok(recovered.rootHandoff.hashUpgrade.baselineRevisionId)
    const preserved = (await api.read('_card-conversation-starts.json')).find(item => item.requestId === handoff.requestId)
    assert.equal(preserved.conversationId, 'successor'); assert.equal(preserved.acceptedAt, acceptedAt)
    assert.equal(await primary(), 'previous', '복구만으로 설정 검증을 건너뛰지 않는다')
  }
  correctConfig = true; configSource = 'snapshot'
  await result(); assert.equal(await primary(), 'previous', '스냅샷만으로 실행 설정을 확인하지 않는다')
  configSource = 'runtime'
  await until(async () => (await result()).body.state === 'ready', '후속 인수와 실행 설정 확인 후 담당 전환이 완료되지 않았습니다.')
  assert.equal(await primary(), 'successor')
  await api.restart()
  // 재시작 뒤 요청 ID를 다시 보내도 기존 인계와 후속 대화를 재사용한다.
  await api.call(groupPath, 'POST', request, origin('parent', parentMap))
  await api.tick(100)
  let lastInstruction
  await until(async () => { await api.tick(100); lastInstruction = await query(); return lastInstruction?.state === 'delivered' },
    () => `인계 완료 뒤 보관된 업무가 전달되지 않았습니다. ${JSON.stringify(lastInstruction)}`)
  assert.equal(sends.filter(s => s.operationId.startsWith('rhp:')).length, 1)
  assert.equal(sends.filter(s => s.create).length, 1)
  const work = sends.filter(s => s.operationId === `gdi:${request.idempotencyKey}`)
  assert.equal(work.length, 1); assert.equal(work[0].targetConversationId, 'successor')
  assert.ok(work[0].instruction.includes(request.instruction))
  assert.ok((await currentMap()).nodes[0].data.aiConversations.some(link => link.conversationId === 'previous'))
})
