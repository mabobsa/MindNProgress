import { findMachine, normalizeMachineId, verifyMachineToken } from './subMachines.mjs'

export const RUNNER_MCP_MACHINE_HEADER = 'x-mnp-runner-mcp-machine-id'

const allowedPathPrefixes = Object.freeze([
  '/api/maps',
  '/api/document-groups',
  '/api/document-reconstructions',
  '/api/card-layouts',
  '/api/shared-knowledge/audit',
  '/api/assignees',
  '/api/health',
  '/api/groups',
  '/api/ai-workspaces',
  '/api/notifications',
])

const allowedAionUiIntegrationPaths = Object.freeze([
  /^\/api\/integrations\/aionui\/conversation-attribution\/resolve$/,
  /^\/api\/integrations\/aionui\/conversation-display\/resolve$/,
  /^\/api\/integrations\/aionui\/conversations\/[A-Za-z0-9_-]{1,120}\/transcript$/,
])

const allowedDoorayIntegrationPaths = Object.freeze([
  /^\/api\/integrations\/dooray\/response-approvals\/[A-Za-z0-9_-]{1,120}$/,
])

const conversationNavigationPath = /^\/api\/integrations\/aionui\/conversations\/([A-Za-z0-9_-]{1,120})\/mindnprogress(\/select)?$/

function bearerToken(headers) {
  const authorization = String(headers?.authorization ?? '')
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

export function isRunnerMcpApiPathAllowed(method, pathname) {
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method ?? '').toUpperCase())) return false
  const normalizedPath = String(pathname ?? '')
  if (normalizedPath === '/api/integrations/aionui/subscription-usage') return String(method).toUpperCase() === 'GET'
  if (normalizedPath === '/api/integrations/aionui/session-messages') return String(method).toUpperCase() === 'POST'
  const navigation = normalizedPath.match(conversationNavigationPath)
  if (navigation) return String(method).toUpperCase() === (navigation[2] ? 'POST' : 'GET')
  if (allowedPathPrefixes.some((prefix) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`))) return true
  return [...allowedAionUiIntegrationPaths, ...allowedDoorayIntegrationPaths]
    .some((pattern) => pattern.test(normalizedPath))
}

export function authorizeRunnerMcpRequest({
  request,
  pathname,
  machineRegistry,
  conversationOrigins,
  transientAttributions = [],
  users,
}) {
  const declaredMachineId = String(request?.headers?.[RUNNER_MCP_MACHINE_HEADER] ?? '').trim()
  if (!declaredMachineId) return { kind: 'normal' }

  const machineId = normalizeMachineId(declaredMachineId)
  const token = bearerToken(request.headers)
  if (!machineId || !token || !verifyMachineToken(machineRegistry, machineId, token)) {
    return {
      kind: 'rejected',
      status: 401,
      code: 'MNP_RUNNER_MCP_AUTH_FAILED',
      error: 'Runner MCP 인증에 실패했습니다.',
    }
  }
  if (!isRunnerMcpApiPathAllowed(request.method, pathname)) {
    return {
      kind: 'rejected',
      status: 403,
      code: 'MNP_RUNNER_MCP_PATH_DENIED',
      error: 'Runner MCP에서 사용할 수 없는 API입니다.',
    }
  }

  const conversationId = String(request.headers['x-mnp-ai-conversation-id'] ?? '').trim()
  const navigation = String(pathname ?? '').match(conversationNavigationPath)
  const origin = conversationOrigins.get(conversationId)
  const machine = findMachine(machineRegistry, machineId)
  const owner = users.find((candidate) => candidate.id === machine?.ownerUserId)
  const transientAttribution = origin ? null : [...transientAttributions].find((candidate) => (
    candidate?.conversationId === conversationId
    && normalizeMachineId(candidate.homeMachineId) === machineId
    && candidate.startedBy === owner?.id
    && Number(candidate.expiresAt) > Date.now()
  ))
  const trustedConversation = origin ?? transientAttribution
  if (!conversationId || (navigation && navigation[1] !== conversationId)
    || !trustedConversation || normalizeMachineId(trustedConversation.homeMachineId) !== machineId
    || !owner || owner.active === false || !['editor', 'admin'].includes(owner.role)
    || trustedConversation.startedBy !== owner.id) {
    return {
      kind: 'rejected',
      status: 403,
      code: 'MNP_RUNNER_MCP_CONVERSATION_DENIED',
      error: '이 Runner와 연결된 MnP 대화 계정을 확인할 수 없습니다.',
    }
  }

  const declaredEditorId = String(request.headers['x-mnp-ai-editor-id'] ?? '').trim()
  if (declaredEditorId && declaredEditorId !== owner.id) {
    return {
      kind: 'rejected',
      status: 403,
      code: 'MNP_RUNNER_MCP_ACCOUNT_MISMATCH',
      error: 'Runner MCP 대화 계정이 MnP 기록과 일치하지 않습니다.',
    }
  }

  return { kind: 'authorized', machineId, owner }
}
