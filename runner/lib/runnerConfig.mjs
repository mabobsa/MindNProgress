// 서브 머신에서 도는 Runner의 설정이다.
// Runner는 MnP로 나가는 연결만 쓰므로 서브 머신은 inbound 주소를 열지 않는다.

export const RUNNER_DEFAULT_CONCURRENCY = 4
export const RUNNER_DEFAULT_HEARTBEAT_MS = 60_000
export const RUNNER_DEFAULT_RETRY_MS = 3_000
export const RUNNER_MAX_CONCURRENCY = 16

// AionUi가 OS 임시 디렉터리에 게시하는 탐색 파일을 못 읽을 때 쓰는 호환 주소다.
export const RUNNER_FALLBACK_AIONUI_URLS = Object.freeze([
  'http://127.0.0.1:1986',
  'http://127.0.0.1:5830',
])

export class RunnerConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RunnerConfigError'
  }
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedNumber(value, fallback, { min, max }) {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizeBaseUrl(value, label) {
  const candidate = text(value)
  if (!candidate) throw new RunnerConfigError(`${label}가 필요합니다.`)

  // 스킴이 붙어 있으면 그대로 검사한다. 여기서 걸러내지 않으면
  // `ftp://host`가 `http://ftp//host`로 조용히 바뀌어 엉뚱한 곳에 붙는다.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
  if (hasScheme && !/^https?:\/\//i.test(candidate)) {
    throw new RunnerConfigError(`${label}는 http 또는 https만 사용할 수 있습니다.`)
  }

  let url
  try {
    url = new URL(hasScheme ? candidate : `http://${candidate}`)
  } catch {
    throw new RunnerConfigError(`${label}가 올바른 주소가 아닙니다.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RunnerConfigError(`${label}는 http 또는 https만 사용할 수 있습니다.`)
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function normalizeRunnerConfig(environment = {}) {
  const machineId = text(environment.MNP_RUNNER_MACHINE_ID).toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(machineId)) {
    throw new RunnerConfigError('MNP_RUNNER_MACHINE_ID는 소문자, 숫자, 하이픈만 사용할 수 있습니다.')
  }

  const token = text(environment.MNP_RUNNER_TOKEN)
  if (!token) throw new RunnerConfigError('MNP_RUNNER_TOKEN이 필요합니다.')

  return {
    machineId,
    token,
    apiBaseUrl: normalizeBaseUrl(environment.MNP_RUNNER_API_URL, 'MNP_RUNNER_API_URL'),
    // 지정하지 않으면 AionUi 탐색 파일과 호환 주소를 순서대로 시도한다.
    aionUiBaseUrl: text(environment.MNP_RUNNER_AIONUI_URL)
      ? normalizeBaseUrl(environment.MNP_RUNNER_AIONUI_URL, 'MNP_RUNNER_AIONUI_URL')
      : null,
    concurrency: boundedNumber(environment.MNP_RUNNER_CONCURRENCY, RUNNER_DEFAULT_CONCURRENCY, {
      min: 1,
      max: RUNNER_MAX_CONCURRENCY,
    }),
    heartbeatIntervalMs: boundedNumber(environment.MNP_RUNNER_HEARTBEAT_MS, RUNNER_DEFAULT_HEARTBEAT_MS, {
      min: 5_000,
      max: 600_000,
    }),
    retryDelayMs: boundedNumber(environment.MNP_RUNNER_RETRY_MS, RUNNER_DEFAULT_RETRY_MS, {
      min: 500,
      max: 60_000,
    }),
    verbose: text(environment.MNP_RUNNER_VERBOSE) === '1',
  }
}

export function runnerClaimUrl(config) {
  return `${config.apiBaseUrl}/api/machines/${encodeURIComponent(config.machineId)}/runner/operations/claim`
}

export function runnerResultUrl(config, operationId) {
  return `${config.apiBaseUrl}/api/machines/${encodeURIComponent(config.machineId)}/runner/operations/${encodeURIComponent(operationId)}/result`
}

export function runnerHeartbeatUrl(config) {
  return `${config.apiBaseUrl}/api/machines/${encodeURIComponent(config.machineId)}/runner/heartbeat`
}

// 토큰은 어떤 로그에도 남기지 않는다.
export function describeRunnerConfig(config) {
  return [
    `machineId=${config.machineId}`,
    `api=${config.apiBaseUrl}`,
    `aionui=${config.aionUiBaseUrl ?? '자동 탐색'}`,
    `concurrency=${config.concurrency}`,
  ].join(' ')
}
