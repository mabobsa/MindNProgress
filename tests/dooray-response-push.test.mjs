import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createDoorayResponseService } from '../server/lib/doorayResponses.mjs'
import { replaceFileWithRetry } from '../server/lib/replaceFileWithRetry.mjs'
import { buildDoorayResponsePush, claimDoorayPush, DOORAY_PUSH_LIFETIME_MS, doorayPushEventId,
  finishDoorayPush, reconcileDoorayPush } from '../server/lib/doorayResponsePush.mjs'
import { doorayResponseIdFromSearch } from '../src/utils/doorayResponseLink.mjs'

const inputDecision = { kind: 'input', reason: '대상 확인 필요', questions: ['어느 화면을 수정할까요?'], approval: null }
const approvalDecision = { kind: 'approval', reason: '범위 확정', questions: [],
  approval: { title: '금액 표시 수정', scope: ['금액을 천 단위로 표시'], exclusions: ['결제 로직 변경'] } }
const makeJob = (status = 'needs-input') => ({ id: 'response-1', status, attempt: 0,
  source: { subject: '금액 표시 요청', fingerprint: 'source-1' },
  settings: { pushEnabled: true, pushMachineId: 'windows' }, proposal: '제안 본문',
  decision: status === 'needs-input' ? inputDecision : approvalDecision })

test('새 응답 대기만 기록하며 같은 제안 조회·구형 기록·알림 미사용은 발송하지 않는다', () => {
  const job = makeJob()
  reconcileDoorayPush(job, null, 1000)
  const saved = structuredClone(job.pushNotification)
  reconcileDoorayPush(job, doorayPushEventId(job), 2000)
  assert.deepEqual(job.pushNotification, saved)
  const legacy = makeJob()
  reconcileDoorayPush(legacy, doorayPushEventId(legacy), 2000)
  assert.equal(legacy.pushNotification, undefined)
  const disabled = makeJob()
  disabled.settings.pushEnabled = false
  reconcileDoorayPush(disabled, null, 1000)
  assert.equal(disabled.pushNotification, undefined)
  job.attempt++
  reconcileDoorayPush(job, saved.eventId, 3000)
  assert.notEqual(job.pushNotification.eventId, saved.eventId, '같은 질문도 새 재제안 회차에서는 다시 알린다')
})

test('질문·승인 본문과 HTTPS 대응 바로가기를 만들고 길이·대상을 제한한다', () => {
  for (const status of ['needs-input', 'needs-approval']) {
    const job = makeJob(status)
    reconcileDoorayPush(job, null, 1000)
    const payload = buildDoorayResponsePush(job, 'https://mnp.example')
    assert.equal(payload.kind, 'choice')
    assert.equal(payload.machineId, 'windows')
    assert.equal(doorayResponseIdFromSearch(new URL(payload.webUrl).search), job.id)
    assert.match(payload.body, /금액 표시 요청/)
    assert.ok(payload.body.includes(status === 'needs-input' ? inputDecision.questions[0] : approvalDecision.approval.scope[0]))
    assert.equal(buildDoorayResponsePush(job, 'http://127.0.0.1:4175').webUrl, undefined)
  }
  const huge = makeJob()
  huge.source.subject = '제목'.repeat(2000)
  huge.decision = { ...inputDecision, questions: Array.from({ length: 30 }, () => '질문😀'.repeat(2000)) }
  reconcileDoorayPush(huge, null, 1000)
  assert.ok(buildDoorayResponsePush(huge).body.length <= 16000)
  assert.equal(doorayResponseIdFromSearch('?doorayResponseId=../another'), '')
})

test('동일 이벤트로 유한 재시도하고 재시작의 진행 중 전송을 회수한다', () => {
  const job = makeJob()
  reconcileDoorayPush(job, null, 1000)
  const originalId = job.pushNotification.eventId
  const first = claimDoorayPush(job, 1000)
  assert.equal(claimDoorayPush(job, 2000), null)
  const restarted = structuredClone(job)
  const second = claimDoorayPush(restarted, 61000)
  assert.equal(second.pushNotification.eventId, originalId)
  finishDoorayPush(restarted, first.pushNotification, null, 62000)
  assert.equal(restarted.pushNotification.state, 'sending', '이전 시도의 늦은 응답은 무시한다')
  for (let count = 2; count <= 5; count++) {
    finishDoorayPush(restarted, structuredClone(restarted.pushNotification), { status: 503, code: 'RUNNER_OFFLINE' }, 62000)
    assert.equal(restarted.pushNotification.eventId, originalId)
    if (count < 5) assert.ok(claimDoorayPush(restarted, restarted.pushNotification.nextAttemptAt))
  }
  assert.equal(restarted.pushNotification.state, 'failed')
  const expired = makeJob()
  reconcileDoorayPush(expired, null, 1000)
  assert.equal(claimDoorayPush(expired, 1000 + DOORAY_PUSH_LIFETIME_MS), null)
  assert.equal(expired.pushNotification.errorCode, 'PUSH_RETRY_EXHAUSTED')
})

test('이미 답변·승인·완료한 요청은 미발송 알림을 취소하고 늦은 성공이 덮어쓰지 않는다', () => {
  for (const status of ['routing', 'approved', 'completed']) {
    const job = makeJob()
    reconcileDoorayPush(job, null, 1000)
    const claimed = claimDoorayPush(job, 1000)
    job.status = status
    reconcileDoorayPush(job, claimed.pushNotification.eventId, 2000)
    finishDoorayPush(job, claimed.pushNotification, null, 3000)
    assert.equal(job.pushNotification.state, 'cancelled')
  }
})

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dooray-push-'))
  let queue = Promise.resolve(), lockHeld = false, now = 1_800_000_000_000
  const sent = [], operations = new Map()
  const file = path.join(directory, 'owner.json')
  const read = async file => { try { return JSON.parse(await readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return {}; throw e } }
  const deps = { directory, read, write: async (file, data) => {
    await writeFile(`${file}.tmp`, JSON.stringify(data))
    await replaceFileWithRetry(`${file}.tmp`, file)
  },
    withMutation: (_file, fn) => {
      const operation = queue.catch(() => {}).then(async () => { lockHeld = true; try { return await fn() } finally { lockHeld = false } })
      queue = operation
      return operation
    },
    now: () => now, publicBaseUrl: 'https://mnp.example',
    user: async id => ({ id, role: 'editor', name: '검증 사용자' }),
    loadSource: async item => ({ item, subject: '검증 업무', body: '본문', fingerprint: item.key, comments: [] }),
    loadMaps: async () => [], resolveSettings: async () => ({ agentId: 'test', modelId: 'model', machineId: 'ai-mac', pushEnabled: true, pushMachineId: 'windows' }),
    conversationExists: async () => true, createConversation: async () => ({ id: 'test-conversation' }),
    prepareConversation: async () => ({ mcpServers: [] }),
    dispatch: async op => { operations.set(op.id, op); return { conversationId: op.conversationId, state: 'running' } },
    getDispatch: async op => { if (!operations.has(op.id)) throw Object.assign(new Error('없음'), { status: 404 }); return { conversationId: op.conversationId, state: 'completed' } },
    messages: async op => [{ position: 'left', type: 'text', content: JSON.stringify({ requestId: op.id,
      action: 'clarify', proposal: '검토 질문', decision: inputDecision }) }],
    sendPush: async (user, body) => { assert.equal(lockHeld, false, '저장 잠금 밖에서 발송'); sent.push({ user, body }); return { delivery: 'queued' } },
    ...overrides,
  }
  const service = createDoorayResponseService(deps)
  const job = async () => (await read(file)).jobs?.[0]
  const until = async (check, current = service) => {
    for (let index = 0; index < 150; index++) {
      await current.poll()
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const latest = await job()
    assert.fail(`푸시 상태 갱신 시간 초과: ${latest?.status}, ${latest?.error}, ${JSON.stringify(latest?.pushNotification)}`)
  }
  t.after(async () => {
    await queue.catch(() => {})
    assert.equal(path.dirname(directory), tmpdir())
    assert.ok(path.basename(directory).startsWith('mnp-dooray-push-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  const start = () => service.start({ id: 'owner', role: 'editor' }, { key: 'item-1', postId: 'post-1', subject: '검증 업무' })
  return { service, deps, sent, job, until, start, setNow: value => { now = value }, now }
}

test('브라우저 없이 서버가 상태와 발송 기록을 저장하고 중복 발송을 막는다', async t => {
  const f = await fixture(t)
  await f.start()
  await f.until(async () => (await f.job())?.pushNotification?.state === 'queued')
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].body.machineId, 'windows', 'AI 실행 머신과 알림 PC를 분리한다')
  for (let n = 0; n < 3; n++) await f.service.poll()
  assert.equal(f.sent.length, 1)
  const publicJob = (await f.service.list('owner'))[0]
  assert.equal(publicJob.status, 'needs-input')
  assert.equal(publicJob.pushNotification.state, 'queued')
})

test('전송 실패 후 서버를 재시작해도 같은 이벤트로 재시도하며 제안은 보존한다', async t => {
  const attempts = []
  const f = await fixture(t, { sendPush: async (_user, body) => {
    attempts.push(body)
    if (attempts.length === 1) throw Object.assign(new Error('오프라인'), { status: 503, code: 'RUNNER_OFFLINE' })
  } })
  await f.start()
  await f.until(async () => (await f.job())?.pushNotification?.errorCode === 'RUNNER_OFFLINE')
  assert.equal((await f.job()).status, 'needs-input')
  f.setNow(f.now + 15000)
  const restarted = createDoorayResponseService(f.deps)
  await f.until(async () => (await f.job())?.pushNotification?.state === 'queued', restarted)
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].eventId, attempts[1].eventId)
  assert.equal((await f.job()).status, 'needs-input')
})

test('느린 푸시가 상태 조회·추가 정보 입력을 막지 않으며 이전 전송 결과를 분리한다', { timeout: 10000 }, async t => {
  let release, sending = false
  const f = await fixture(t, { sendPush: async () => { if (sending) return; sending = true; await new Promise(resolve => { release = resolve }) } })
  await f.start()
  await f.until(() => sending)
  const previous = await f.job()
  const refined = await f.service.refine('owner', previous.id, '대상 화면은 결제 화면입니다.')
  assert.equal(refined.status, 'routing')
  release()
  await f.until(async () => (await f.job())?.status === 'needs-input')
  // 새 회차의 발송을 시작하지 않고 저장된 이벤트가 달라졌는지 확인한다.
  assert.notEqual((await f.job()).pushNotification.eventId, previous.pushNotification.eventId)
  if (release) release()
})
