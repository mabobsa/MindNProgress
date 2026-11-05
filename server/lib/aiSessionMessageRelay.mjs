// AionUi 세션 메시지를 대상 대화가 있는 다른 머신으로 중계한다.
// 보낸 머신의 AionCore가 자기 DB에서 대상을 찾지 못했을 때만 호출한다.
// 받는 머신의 AionCore는 다시 중계하지 않으므로 메시지는 한 번만 머신을 건넌다.

export const SESSION_MESSAGE_RELAY_PATH = '/api/integrations/aionui/session-messages'
export const REMOTE_SESSION_MESSAGE_PATH = '/api/internal/session-messages/remote'

const conversationIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/
const maxMessageLength = 200_000
const maxNameLength = 300
const maxWorkspaceLength = 2_048
export const SESSION_MESSAGE_PROBE_TIMEOUT_MS = 5_000
export const SESSION_MESSAGE_DELIVERY_TIMEOUT_MS = 20_000

function invalid(error) {
  return { ok: false, status: 400, body: { code: 'schema_validation_failed', error } }
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

export function normalizeSessionMessageRelayRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('요청 본문이 올바르지 않습니다.')
  const fromConversationId = String(value.fromConversationId ?? '').trim()
  const to = String(value.to ?? '').trim()
  if (!conversationIdPattern.test(fromConversationId)) return invalid('보낸 대화 ID가 올바르지 않습니다.')
  if (!conversationIdPattern.test(to)) return invalid('받는 대화 ID가 올바르지 않습니다.')
  if (to === fromConversationId) {
    return { ok: false, status: 400, body: { code: 'target_is_self', error: '자기 자신에게는 보낼 수 없습니다.' } }
  }
  if (typeof value.message !== 'string' || !value.message.trim()) return invalid('메시지 본문이 비어 있습니다.')
  if (value.message.length > maxMessageLength) return invalid('메시지 본문이 너무 깁니다.')
  const fromName = optionalText(value.fromName, maxNameLength)
  const fromWorkspace = optionalText(value.fromWorkspace, maxWorkspaceLength)
  if (fromName === null || fromWorkspace === null) return invalid('보낸 대화 정보가 올바르지 않습니다.')
  return {
    ok: true,
    value: {
      fromConversationId,
      fromName: fromName || fromConversationId,
      ...(fromWorkspace ? { fromWorkspace } : {}),
      to,
      message: value.message,
    },
  }
}

// 대화 기록에 남은 머신을 먼저 확인하고, 없으면 나머지 머신을 등록 순서대로 확인한다.
function candidateMachines(machines, sourceMachineId, homeMachineId) {
  const others = machines.filter((machine) => machine.enabled !== false && machine.machineId !== sourceMachineId)
  const home = others.find((machine) => machine.machineId === homeMachineId)
  return home ? [home, ...others.filter((machine) => machine !== home)] : others
}

function errorStatus(error) {
  return Number.isInteger(error?.status) ? error.status : null
}

function failureReason(machine, error) {
  const label = machine.label || machine.machineId
  if (error?.reasonCode === 'RESULT_TIMEOUT') return `${label} 머신이 전달 결과를 보내지 않았습니다. 이미 전달됐을 수 있으니 다시 보내기 전에 받는 대화를 확인하세요.`
  if (error?.reasonCode === 'RUNNER_UNAVAILABLE') return `${label} 머신의 Runner가 연결되어 있지 않습니다.`
  return `${label} 머신에 전달하지 못했습니다.`
}

/**
 * 대상 대화가 있는 머신을 찾아 전달한다.
 * `listMachines()`는 `{ machineId, label, enabled, online }`, `callMachine`은 fetchAionUiOn과 같은 계약이다.
 */
export async function relaySessionMessage({
  request,
  sourceMachineId,
  listMachines,
  homeMachineIdOf,
  callMachine,
  probeTimeoutMs = SESSION_MESSAGE_PROBE_TIMEOUT_MS,
  deliveryTimeoutMs = SESSION_MESSAGE_DELIVERY_TIMEOUT_MS,
}) {
  const machines = listMachines()
  const source = machines.find((machine) => machine.machineId === sourceMachineId)
  const candidates = candidateMachines(machines, sourceMachineId, homeMachineIdOf(request.to))
  const reachable = candidates.filter((machine) => machine.online !== false)
  const offline = candidates.filter((machine) => machine.online === false)

  const probePath = `/api/conversations/${encodeURIComponent(request.to)}`
  const probes = await Promise.allSettled(reachable.map((machine) => (
    callMachine(machine.machineId, probePath, { timeoutMs: probeTimeoutMs })
  )))
  const target = reachable.find((_, index) => probes[index].status === 'fulfilled')
  const unreachable = [
    ...offline,
    ...reachable.filter((_, index) => probes[index].status === 'rejected' && errorStatus(probes[index].reason) !== 404),
  ]

  if (!target) {
    if (unreachable.length > 0) {
      const labels = unreachable.map((machine) => machine.label || machine.machineId).join(', ')
      return {
        status: 503,
        body: {
          code: 'MACHINE_UNAVAILABLE',
          error: `연결된 머신에서 대상 대화를 찾지 못했습니다. 확인하지 못한 머신: ${labels}`,
        },
      }
    }
    return { status: 404, body: { code: 'target_not_found', error: '어느 머신에서도 대상 대화를 찾지 못했습니다.' } }
  }

  try {
    const data = await callMachine(target.machineId, REMOTE_SESSION_MESSAGE_PATH, {
      method: 'POST',
      body: { ...request, fromMachine: source?.label || sourceMachineId },
      timeoutMs: deliveryTimeoutMs,
    })
    return {
      status: 200,
      body: { success: true, data, machine: { machineId: target.machineId, label: target.label || target.machineId } },
    }
  } catch (error) {
    const status = errorStatus(error)
    if (status !== null && status >= 400 && status < 500 && typeof error?.code === 'string' && error.code) {
      return { status, body: { code: error.code, error: failureReason(target, error) } }
    }
    return { status: 502, body: { code: 'MACHINE_DELIVERY_FAILED', error: failureReason(target, error) } }
  }
}
