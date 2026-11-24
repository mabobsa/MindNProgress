import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const defaultMnpApiBaseUrl = 'http://127.0.0.1:4176'
export const defaultMnpRunnerRelayFile = path.join(tmpdir(), 'aionui-mindnprogress-mcp-relay.json')

function normalizedBaseUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim())
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
    url.search = ''
    url.hash = ''
    return `${url.origin}${pathname}`
  } catch {
    return null
  }
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  } catch {
    return false
  }
}

function defaultProcessExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function normalizeMnpRunnerRelayDescriptor(value, processExists = defaultProcessExists) {
  const baseUrl = normalizedBaseUrl(value?.baseUrl)
  const token = String(value?.token ?? '').trim()
  const instanceId = String(value?.instanceId ?? '').trim()
  const pid = Number(value?.pid)
  if (value?.schemaVersion !== 1 || !baseUrl || !isLoopbackUrl(baseUrl)
    || !/^mnprl_[A-Za-z0-9_-]{40,100}$/.test(token)
    || !/^[A-Za-z0-9_-]{16,100}$/.test(instanceId)
    || !Number.isInteger(pid) || pid < 1 || !processExists(pid)) return null
  return { mode: 'runner-relay', apiBaseUrl: baseUrl, token, instanceId, pid }
}

async function readIntegrationToken(tokenFile, readFileImpl) {
  const token = (await readFileImpl(tokenFile, 'utf8')).trim()
  if (token.length < 32) throw new Error('MindNProgress 연동 토큰이 준비되지 않았습니다. API 서버를 다시 시작해 주세요.')
  return token
}

export function createMnpApiConnectionResolver({
  explicitApiBaseUrl = '',
  localApiBaseUrl = defaultMnpApiBaseUrl,
  tokenFile,
  relayFile = defaultMnpRunnerRelayFile,
  fetchImpl = fetch,
  readFileImpl = readFile,
  processExists = defaultProcessExists,
  localProbeTimeoutMs = 500,
} = {}) {
  const explicitBaseUrl = normalizedBaseUrl(explicitApiBaseUrl)
  if (String(explicitApiBaseUrl ?? '').trim() && !explicitBaseUrl) {
    throw new Error('MNP_API_URL은 올바른 HTTP 또는 HTTPS 주소여야 합니다.')
  }
  const normalizedLocalApiBaseUrl = normalizedBaseUrl(localApiBaseUrl) ?? defaultMnpApiBaseUrl
  let resolvedConnection = null

  async function readRelayConnection() {
    try {
      const descriptor = JSON.parse(await readFileImpl(relayFile, 'utf8'))
      return normalizeMnpRunnerRelayDescriptor(descriptor, processExists)
    } catch {
      return null
    }
  }

  async function localApiIsAvailable() {
    try {
      const response = await fetchImpl(`${normalizedLocalApiBaseUrl}/api/health`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(localProbeTimeoutMs),
      })
      if (!response.ok) return false
      const body = await response.json().catch(() => null)
      return body?.status === 'ok' && typeof body?.publicBaseUrl === 'string'
    } catch {
      return false
    }
  }

  return {
    async resolve() {
      if (explicitBaseUrl) {
        if (!resolvedConnection) {
          resolvedConnection = {
            mode: 'explicit',
            apiBaseUrl: explicitBaseUrl,
            token: await readIntegrationToken(tokenFile, readFileImpl),
          }
        }
        return resolvedConnection
      }

      if (resolvedConnection?.mode === 'local') return resolvedConnection
      if (resolvedConnection?.mode === 'runner-relay') {
        const currentRelay = await readRelayConnection()
        if (currentRelay?.instanceId === resolvedConnection.instanceId) return resolvedConnection
        resolvedConnection = currentRelay
        if (resolvedConnection) return resolvedConnection
      }

      if (await localApiIsAvailable()) {
        resolvedConnection = {
          mode: 'local',
          apiBaseUrl: normalizedLocalApiBaseUrl,
          token: await readIntegrationToken(tokenFile, readFileImpl),
        }
        return resolvedConnection
      }

      resolvedConnection = await readRelayConnection()
      if (resolvedConnection) return resolvedConnection
      throw new Error('MindNProgress API에 연결할 수 없습니다. 메인 MnP 또는 이 머신의 AionUi Runner 연결을 확인해 주세요.')
    },

    // 401을 받은 연결의 토큰이 그사이 교체됐는지 확인한다. 바뀌었으면 연결 정보를 갱신하고 true를 반환해
    // 호출자가 한 번만 다시 보내게 한다. 토큰이 그대로면(신원 불일치 등 다른 이유의 401) false를 반환한다.
    async refreshAfterUnauthorized(connection) {
      if (!connection) return false
      // 동시에 401을 받은 다른 요청이 먼저 갱신했으면 새 토큰으로 다시 보내면 된다.
      if (resolvedConnection && resolvedConnection !== connection) return resolvedConnection.token !== connection.token
      if (connection.mode === 'local' || connection.mode === 'explicit') {
        let token
        try {
          token = await readIntegrationToken(tokenFile, readFileImpl)
        } catch {
          return false
        }
        if (token === connection.token) return false
        resolvedConnection = { ...connection, token }
        return true
      }
      if (connection.mode === 'runner-relay') {
        const currentRelay = await readRelayConnection()
        if (!currentRelay || currentRelay.token === connection.token) return false
        resolvedConnection = currentRelay
        return true
      }
      return false
    },
  }
}
