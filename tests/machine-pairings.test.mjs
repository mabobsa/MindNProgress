import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MachinePairingError,
  MachinePairingStore,
  createAionUiRunnerPairingUrl,
} from '../server/lib/machinePairings.mjs'

test('페어링 코드는 한 번만 교환할 수 있다', () => {
  const store = new MachinePairingStore({ now: () => 1_000, createCode: () => 'mnppair_one' })
  const issued = store.issue({ machineId: 'macbook', requestedByUserId: 'editor' })

  assert.equal(issued.code, 'mnppair_one')
  assert.deepEqual(store.consume(issued.code), { machineId: 'macbook', requestedByUserId: 'editor' })
  assert.throws(() => store.consume(issued.code), (error) => (
    error instanceof MachinePairingError && error.reasonCode === 'PAIRING_INVALID'
  ))
})

test('같은 머신에서 새 링크를 발급하면 이전 링크를 무효화한다', () => {
  const codes = ['mnppair_old', 'mnppair_new']
  const store = new MachinePairingStore({ now: () => 1_000, createCode: () => codes.shift() })
  store.issue({ machineId: 'macbook', requestedByUserId: 'editor' })
  const current = store.issue({ machineId: 'macbook', requestedByUserId: 'editor' })

  assert.throws(() => store.consume('mnppair_old'), MachinePairingError)
  assert.equal(store.consume(current.code).machineId, 'macbook')
})

test('만료된 페어링 코드는 교환할 수 없다', () => {
  let now = 1_000
  const store = new MachinePairingStore({ now: () => now, createCode: () => 'mnppair_expired', ttlMs: 500 })
  const issued = store.issue({ machineId: 'macbook', requestedByUserId: 'editor' })
  now = 1_501

  assert.throws(() => store.consume(issued.code), MachinePairingError)
})

test('딥링크는 서버 주소와 대상 머신 및 일회용 코드만 전달한다', () => {
  const launchUrl = new URL(createAionUiRunnerPairingUrl('http://192.168.0.10:4176', 'mnppair_secret', 'macbook'))

  assert.equal(launchUrl.protocol, 'aionui:')
  assert.equal(launchUrl.hostname, 'mindnprogress')
  assert.equal(launchUrl.pathname, '/runner-pair')
  assert.equal(launchUrl.searchParams.get('api_url'), 'http://192.168.0.10:4176')
  assert.equal(launchUrl.searchParams.get('pairing_code'), 'mnppair_secret')
  assert.equal(launchUrl.searchParams.get('machine_id'), 'macbook')
  assert.equal(launchUrl.searchParams.has('token'), false)
})
