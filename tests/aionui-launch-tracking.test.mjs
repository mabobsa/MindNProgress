import assert from 'node:assert/strict'
import test from 'node:test'
import { createAionUiLaunchTracking } from '../server/lib/aionUiLaunchTracking.mjs'

test('발급은 생성 완료가 아니며 동일한 요청을 동시에 받아도 ticket을 한 번만 만든다', async () => {
  const tracking = createAionUiLaunchTracking({ now: () => 100 })
  tracking.register('key', 'owner', 200)
  let count = 0
  const create = async () => { count++; return { launchUrl: 'https://aion.example/#/guid?external-launch=ticket', desktopLaunchUrl: 'aionui://conversation/new?launchId=ticket' } }
  const [first, second] = await Promise.all([tracking.issue('key', { prompt: '전문' }, create), tracking.issue('key', { prompt: '전문' }, create)])
  assert.equal(count, 1)
  assert.deepEqual(first, second)
  assert.equal(tracking.read('key', 'owner').status, 'pending')
  assert.equal(tracking.read('key', 'owner').desktopLaunchUrl, first.desktopLaunchUrl)
  assert.throws(() => tracking.issue('key', { prompt: '변경된 전문' }, create), { status: 409 })
})

test('접수 응답이 유실되어도 같은 token으로 다시 발급하지 않는다', async () => {
  const tracking = createAionUiLaunchTracking({ now: () => 100 })
  tracking.register('key', 'owner', 200)
  let count = 0
  const create = async () => { count++; throw new Error('응답 유실') }
  await assert.rejects(tracking.issue('key', {}, create), /응답 유실/)
  await assert.rejects(tracking.issue('key', {}, create), /응답 유실/)
  assert.equal(count, 1)
  assert.equal(tracking.read('key', 'owner').status, 'delivery-unknown')
})

test('연결 검증 실패는 완료로 오인하지 않고 나중에 검증된 통보만 완료 처리한다', () => {
  const tracking = createAionUiLaunchTracking({ now: () => 100 })
  tracking.register('key', 'owner', 200)
  tracking.finish('key', 409, { error: '작업공간 불일치' })
  assert.equal(tracking.read('key', 'owner').status, 'confirmation-failed')
  tracking.finish('key', 200, { conversationId: 'verified-chat' })
  tracking.finish('key', 409, { error: '늦은 실패 통보' })
  assert.equal(tracking.read('key', 'owner').status, 'completed')
  assert.equal(tracking.read('key', 'owner').conversationId, 'verified-chat')
})

test('시작 상태는 발급 소유자에게만 공개하며 만료되거나 없는 정보는 추측하지 않는다', () => {
  let now = 100
  const tracking = createAionUiLaunchTracking({ now: () => now })
  tracking.register('key', 'owner', 200)
  assert.throws(() => tracking.read('key', 'other'), { status: 404 })
  assert.throws(() => tracking.read('missing', 'owner'), { status: 404 })
  now = 200
  assert.throws(() => tracking.read('key', 'owner'), { status: 404 })
})
