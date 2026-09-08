import { createHash, randomBytes } from 'node:crypto'

export const MACHINE_PAIRING_TTL_MS = 10 * 60_000
export const MACHINE_PAIRING_LIMIT = 128

function hashPairingCode(code) {
  return createHash('sha256').update(String(code ?? '')).digest('hex')
}

export class MachinePairingError extends Error {
  constructor(message, reasonCode) {
    super(message)
    this.name = 'MachinePairingError'
    this.reasonCode = reasonCode
  }
}

// 페어링 코드는 영구 자격 증명이 아니라 짧게 살아 있는 일회용 교환권이다.
// 원문은 서버에도 남기지 않고 해시만 메모리에 보관하므로 재시작하면 모두 무효가 된다.
export class MachinePairingStore {
  constructor({
    now = () => Date.now(),
    createCode = () => `mnppair_${randomBytes(32).toString('base64url')}`,
    ttlMs = MACHINE_PAIRING_TTL_MS,
    limit = MACHINE_PAIRING_LIMIT,
  } = {}) {
    this.now = now
    this.createCode = createCode
    this.ttlMs = ttlMs
    this.limit = limit
    this.pairings = new Map()
  }

  sweep() {
    const now = this.now()
    for (const [codeHash, pairing] of this.pairings) {
      if (pairing.expiresAtMs <= now) this.pairings.delete(codeHash)
    }
  }

  issue({ machineId, requestedByUserId }) {
    this.sweep()
    // 한 머신에서 새 링크를 만들면 이전 링크는 더 이상 쓸 수 없다.
    for (const [codeHash, pairing] of this.pairings) {
      if (pairing.machineId === machineId) this.pairings.delete(codeHash)
    }
    while (this.pairings.size >= this.limit) {
      this.pairings.delete(this.pairings.keys().next().value)
    }

    const code = this.createCode()
    const expiresAtMs = this.now() + this.ttlMs
    this.pairings.set(hashPairingCode(code), {
      machineId,
      requestedByUserId,
      expiresAtMs,
    })
    return { code, expiresAt: new Date(expiresAtMs).toISOString() }
  }

  consume(code) {
    const codeHash = hashPairingCode(code)
    const pairing = this.pairings.get(codeHash)
    // 성공 여부와 관계없이 발견한 교환권은 즉시 제거해 동시 재사용을 막는다.
    if (pairing) this.pairings.delete(codeHash)
    if (!pairing || pairing.expiresAtMs <= this.now()) {
      throw new MachinePairingError('페어링 링크가 만료되었거나 이미 사용되었습니다.', 'PAIRING_INVALID')
    }
    return {
      machineId: pairing.machineId,
      requestedByUserId: pairing.requestedByUserId,
    }
  }

  revokeMachine(machineId) {
    for (const [codeHash, pairing] of this.pairings) {
      if (pairing.machineId === machineId) this.pairings.delete(codeHash)
    }
  }
}

export function createAionUiRunnerPairingUrl(apiUrl, code, machineId) {
  const launchUrl = new URL('aionui://mindnprogress/runner-pair')
  launchUrl.searchParams.set('api_url', apiUrl)
  launchUrl.searchParams.set('pairing_code', code)
  launchUrl.searchParams.set('machine_id', machineId)
  return launchUrl.toString()
}
