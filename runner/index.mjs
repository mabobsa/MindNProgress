// MindNProgress Runner
//
// 서브 머신에서 실행한다. 메인 머신의 MnP에서 오퍼레이션을 long-poll로 가져와
// 이 머신의 로컬 AionUi에 그대로 전달하고 결과만 올려보낸다.
//
// 서브 머신은 MnP로 나가는 연결만 사용한다. inbound 포트를 열지 않으므로
// AionUi의 인증 없는 내부 API가 사내망에 노출되지 않고, 이 머신의 IP가 바뀌어도 영향이 없다.
//
// 실행:
//   MNP_RUNNER_API_URL=http://<메인PC>:4176 \
//   MNP_RUNNER_MACHINE_ID=macbook \
//   MNP_RUNNER_TOKEN=mnprn_... \
//   node runner/index.mjs

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  RUNNER_FALLBACK_AIONUI_URLS,
  RunnerConfigError,
  describeRunnerConfig,
  normalizeRunnerConfig,
  runnerClaimUrl,
  runnerHeartbeatUrl,
  runnerResultUrl,
} from './lib/runnerConfig.mjs'
import { createRunnerLoop } from './lib/runnerLoop.mjs'
import { MOBILE_PUSH_PATH, sendLocalMobilePush } from '../server/lib/mobilePush.mjs'
import { createAionUiCaller } from './lib/aionUiClient.mjs'
import { startCompletionRelay } from './lib/completionRelay.mjs'
import { createWorkspaceAgent, workspaceRuntimeIdle } from './lib/workspaceAgent.mjs'

let config
try {
  config = normalizeRunnerConfig(process.env)
} catch (error) {
  if (error instanceof RunnerConfigError) {
    console.error(`[MnP Runner] ${error.message}`)
    console.error('[MnP Runner] 필요한 환경변수: MNP_RUNNER_API_URL, MNP_RUNNER_MACHINE_ID, MNP_RUNNER_TOKEN')
    process.exit(1)
  }
  throw error
}

const aionUiDiscoveryFile = path.resolve(
  String(process.env.MNP_RUNNER_AIONUI_DISCOVERY_FILE ?? '').trim() || path.join(tmpdir(), 'aionui-backend.json'),
)
let activeAionUiBaseUrl = config.aionUiBaseUrl ?? RUNNER_FALLBACK_AIONUI_URLS[0]

function log(message) {
  console.log(`[MnP Runner] ${message}`)
}

function logVerbose(message) {
  if (config.verbose) log(message)
}

async function discoverAionUiBaseUrl() {
  if (config.aionUiBaseUrl) return null
  try {
    const record = JSON.parse(await readFile(aionUiDiscoveryFile, 'utf8'))
    const port = Number(record?.port)
    if (record?.schemaVersion !== 1 || record?.host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return null
    }
    return `http://127.0.0.1:${port}`
  } catch (error) {
    if (error?.code !== 'ENOENT' && error instanceof SyntaxError === false) {
      logVerbose(`AionUi 탐색 파일을 읽지 못했습니다: ${error.message}`)
    }
    return null
  }
}

async function aionUiCandidateBaseUrls() {
  if (config.aionUiBaseUrl) return [config.aionUiBaseUrl]
  const discovered = await discoverAionUiBaseUrl()
  return [...new Set([discovered, activeAionUiBaseUrl, ...RUNNER_FALLBACK_AIONUI_URLS].filter(Boolean))]
}

const callAionUi = createAionUiCaller({
  candidateBaseUrls: aionUiCandidateBaseUrls,
  onConnected: (baseUrl) => { activeAionUiBaseUrl = baseUrl },
})

async function mnpRequest(url, body, timeoutMs, { headers = {}, signal = null, method = 'POST' } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  })
  const responseBody = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(responseBody?.error ?? `MNP_REQUEST_FAILED:${response.status}`)
    error.status = response.status
    error.reasonCode = responseBody.reasonCode
    throw error
  }
  return responseBody
}

let longPollMs = 25_000
const claimAbortController = new AbortController()
let completionRelay = null
const workspaceAgent = await createWorkspaceAgent({ registryFile: process.env.MNP_RUNNER_WORKSPACE_REGISTRY,
  machineId: config.machineId, request: (pathname, body, method) => mnpRequest(`${config.apiBaseUrl}${pathname}`, body, 30_000, { method }),
  runtimeIdle: workspaceRuntimeIdle(callAionUi) })

async function callRunner(request) {
  try {
    if (request.pathname === MOBILE_PUSH_PATH && request.method === 'POST') {
      return { ok: true, data: await sendLocalMobilePush(request.body) }
    }
    if (request.pathname === '/mnp/workspaces' && request.method === 'POST') {
      if (!workspaceAgent) throw Object.assign(new Error('원격 workspace agent 설정이 없습니다.'), { code: 'REMOTE_WORKSPACE_AGENT_UNAVAILABLE' })
      return { ok: true, data: await workspaceAgent.execute(request.body) }
    }
    if (request.pathname === '/api/internal/external-conversation-dispatches' && request.method === 'POST') {
      if (request.body?.workspaceLease?.ownership && !workspaceAgent) throw Object.assign(new Error('원격 workspace agent 설정이 없습니다.'), { code: 'REMOTE_WORKSPACE_AGENT_UNAVAILABLE' })
      await workspaceAgent?.validateDispatch(request.body)
    }
    return callAionUi(request)
  } catch (error) { return { ok: false, status: error.status ?? 409, code: error.reasonCode ?? error.code, message: error.message } }
}

async function forwardCompletion(pathname, body) {
  return mnpRequest(`${config.apiBaseUrl}${pathname}`, body, 30_000)
}

async function claimOperations() {
  // long-poll이므로 대기 시간보다 넉넉한 타임아웃을 준다.
  const body = await mnpRequest(
    runnerClaimUrl(config),
    { limit: config.concurrency, waitMs: longPollMs, callbackBaseUrl: completionRelay?.baseUrl },
    longPollMs + 10_000,
    { signal: claimAbortController.signal },
  )
  return Array.isArray(body?.operations) ? body.operations : []
}

function reportResult(operationId, result, resultToken) {
  return mnpRequest(runnerResultUrl(config, operationId), result, 30_000, {
    headers: { 'X-MnP-Operation-Token': resultToken },
  })
}

async function heartbeat() {
  const body = await mnpRequest(runnerHeartbeatUrl(config), {
    callbackBaseUrl: completionRelay?.baseUrl,
    workspacePool: await workspaceAgent?.report(),
  }, 10_000)
  if (Number.isInteger(body?.longPollMs) && body.longPollMs > 0) longPollMs = body.longPollMs
  return body
}

const loop = createRunnerLoop({
  claimOperations,
  callAionUi: callRunner,
  reportResult,
  concurrency: config.concurrency,
  retryDelayMs: config.retryDelayMs,
  cancelClaim: () => claimAbortController.abort(),
  onEvent: (event) => {
    if (event.type === 'claimed') logVerbose(`오퍼레이션 ${event.count}건을 가져왔습니다.`)
    else if (event.type === 'operation-succeeded') logVerbose(`완료 ${event.pathname}`)
    else if (event.type === 'operation-failed') log(`실패 ${event.pathname}${event.status ? ` (${event.status})` : ''}`)
    else if (event.type === 'report-retrying') log(`결과 전달 재시도 ${event.operationId} (${event.attempt}회): ${event.error?.message ?? event.error}`)
    else if (event.type === 'report-failed') log(`결과 전달 확정 실패 ${event.operationId}: ${event.error?.message ?? event.error}`)
    else if (event.type === 'claim-failed') {
      const status = event.error?.status
      log(`MnP 연결 실패${status ? ` (${status})` : ''}: ${event.error?.message ?? event.error}`)
      if (status === 401) log('토큰이 폐기되었거나 머신 등록이 삭제되었을 수 있습니다. 분산 작업 설정에서 확인하세요.')
    }
  },
})

completionRelay = await startCompletionRelay({ forward: forwardCompletion })
log(describeRunnerConfig(config))
logVerbose(`완료 콜백 릴레이를 ${completionRelay.baseUrl}에서 시작했습니다.`)

try {
  const info = await heartbeat()
  log(`'${info.label}' 머신으로 연결했습니다. (대기 ${longPollMs}ms)`)
} catch (error) {
  log(`첫 연결에 실패했습니다: ${error.message}`)
  if (error.status === 401) {
    log('머신 ID와 토큰을 확인하세요. 토큰은 MnP 계정 메뉴의 분산 작업 설정에서 재발급할 수 있습니다.')
    process.exit(1)
  }
  log(`${config.retryDelayMs}ms 후 다시 시도합니다.`)
}

const heartbeatTimer = setInterval(() => {
  void heartbeat().catch((error) => logVerbose(`하트비트 실패: ${error.message}`))
}, config.heartbeatIntervalMs)

function shutdown(signal) {
  log(`${signal} 수신, 종료합니다.`)
  clearInterval(heartbeatTimer)
  loop.stop()
  // 진행 중인 AionUi 호출과 결과 전달은 loop.start()가 끝날 때까지 기다린다.
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

await loop.start()
clearInterval(heartbeatTimer)
await completionRelay.close()
completionRelay = null
