import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findMachine, machineManageableBy, normalizeMachineId } from './subMachines.mjs'

export const MOBILE_PUSH_PATH = '/api/internal/mobile-push/mnp'

function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }) }

// Firebase 키와 휴대폰 토큰은 AionUi가 관리한다. MnP에는 같은 사용자 PC의 중계 토큰만 전달된다.
export async function sendLocalMobilePush(body, {
  file = process.env.AIONUI_PUSH_RELAY_FILE || path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'AionUiPush', 'mobile-push-relay.json'),
  fetchImpl = fetch,
} = {}) {
  let descriptor
  try { descriptor = JSON.parse(await readFile(file, 'utf8')) }
  catch { fail(503, 'PUSH_RELAY_UNAVAILABLE', 'AionUi에서 휴대폰 푸시와 MnP 알림 받기를 켜 주세요.') }
  let url
  try { url = new URL(descriptor.baseUrl) } catch { fail(503, 'PUSH_RELAY_UNAVAILABLE', '푸시 중계 설정을 확인할 수 없습니다.') }
  if (descriptor.schemaVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !/^[A-Za-z0-9_-]{43}$/.test(descriptor.token ?? ''))
    fail(503, 'PUSH_RELAY_UNAVAILABLE', '푸시 중계 설정을 확인할 수 없습니다.')
  let response
  try {
    response = await fetchImpl(`${url.origin}${MOBILE_PUSH_PATH}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  } catch { fail(503, 'PUSH_RELAY_UNAVAILABLE', '실행 중인 AionUi 푸시 중계에 연결하지 못했습니다.') }
  const result = await response.json()
  if (!response.ok) fail(response.status, result.error?.code || 'PUSH_FAILED', 'AionUi가 푸시 요청을 거부했습니다.')
  return result
}

export function resolveMobilePushTarget(user, registry, requestedMachineId, { mainUserId = '' } = {}) {
  if (!user || !['admin', 'editor'].includes(user.role)) fail(403, 'FORBIDDEN', '편집자만 푸시 알림을 보낼 수 있습니다.')
  const machineId = normalizeMachineId(requestedMachineId)
  const machine = findMachine(registry, machineId)
  if (!machine) fail(404, 'MACHINE_NOT_FOUND', '수신할 머신을 찾지 못했습니다.')
  const namedMainRecipient = machineId === registry.mainMachineId && mainUserId && user.id === mainUserId
  if (!namedMainRecipient && !machineManageableBy(registry, machineId, { userId: user.id, isAdmin: user.role === 'admin' }))
    fail(403, 'FORBIDDEN', '본인 소유 머신에만 푸시 알림을 보낼 수 있습니다.')
  if (!machine.enabled) fail(409, 'MACHINE_DISABLED', '수신 머신이 비활성화되어 있습니다.')
  return { machineId, machine }
}

export function mobilePushTargets(user, registry, options) {
  return registry.machines.flatMap(machine => {
    try {
      resolveMobilePushTarget(user, registry, machine.machineId, options)
      return [{ machineId: machine.machineId, label: machine.label, platform: machine.platform }]
    } catch { return [] }
  })
}

export async function sendMobilePush({ user, body, registry, originUrl, mainUserId = '', sendLocal = sendLocalMobilePush, sendRemote, now = Date.now() }) {
  const { machineId, machine } = resolveMobilePushTarget(user, registry, body?.machineId, { mainUserId })
  if (machineId !== registry.mainMachineId) {
    if (!machine.tokenHash) fail(409, 'RUNNER_NOT_CONFIGURED', '수신 머신의 Runner 연결을 먼저 설정해 주세요.')
    if (!machine.lastSeenAt || now - Date.parse(machine.lastSeenAt) > 150_000)
      fail(503, 'RUNNER_OFFLINE', '수신 머신의 Runner가 연결되어 있지 않습니다.')
  }
  const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
  if (!id(body.eventId) || !['choice', 'failure', 'info'].includes(body.kind) ||
      typeof body.title !== 'string' || !body.title.trim() || body.title.length > 120 ||
      typeof body.body !== 'string' || body.body.length > 16000 ||
      (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || body.revision < 1)) ||
      (body.mapId !== undefined && !id(body.mapId)) || (body.cardId !== undefined && !id(body.cardId)))
    fail(400, 'INVALID_INPUT', '이벤트 ID, 유형, 제목, 본문과 개정 번호를 확인해 주세요.')
  let webUrl
  if (body.webUrl !== undefined) {
    try {
      const url = new URL(body.webUrl)
      if (url.origin !== new URL(originUrl).origin || url.protocol !== 'https:' || url.username || url.password || url.href.length > 1500) throw new Error()
      webUrl = url.href
    } catch { fail(400, 'INVALID_INPUT', '원문 링크는 설정된 MnP의 HTTPS 주소여야 합니다.') }
  }
  const payload = {
    originId: createHash('sha256').update(JSON.stringify([new URL(originUrl).origin, user.id])).digest('hex'),
    eventId: body.eventId, kind: body.kind, title: body.title.trim(), body: body.body,
    revision: body.revision ?? 1, createdAt: now,
    ...(body.mapId ? { mapId: body.mapId } : {}), ...(body.cardId ? { cardId: body.cardId } : {}),
    ...(webUrl ? { webUrl } : {}),
  }
  const result = machineId === registry.mainMachineId
    ? await sendLocal(payload)
    : await sendRemote(machineId, payload)
  return { ...result, machineId, eventId: body.eventId, delivery: 'queued', receivedOnPhone: false }
}
