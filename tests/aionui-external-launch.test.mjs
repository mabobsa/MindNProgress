import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AionUiExternalLaunchPayloadError,
  createAionUiWebLaunchUrl,
  normalizeAionUiExternalLaunchPayload,
  parseMindNProgressCompletionToken,
} from '../server/lib/aionUiExternalLaunch.mjs'

const COMPLETION_TOKEN = 'A'.repeat(43)

test('외부 대화 시작 payload는 허용된 필드만 정규화한다', () => {
  const payload = normalizeAionUiExternalLaunchPayload({
    agentId: ' claude ',
    completionUrl: `http://127.0.0.1:4176/api/integrations/aionui/launches/${COMPLETION_TOKEN}/conversation`,
    prompt: ' 작업을 시작해 주세요. ',
    modelId: 'opus',
    enabledSkillIds: ['one', 'one', 'two'],
    mcpIds: [],
    autoSend: true,
    ignored: 'value',
  })

  assert.equal(payload.agentId, 'claude')
  assert.equal(payload.prompt, '작업을 시작해 주세요.')
  assert.deepEqual(payload.enabledSkillIds, ['one', 'two'])
  assert.deepEqual(payload.mcpIds, [])
  assert.equal(payload.autoSend, true)
  assert.equal('ignored' in payload, false)
})

test('필수 값과 payload 제한을 위반하면 외부 대화 시작을 거부한다', () => {
  assert.throws(
    () => normalizeAionUiExternalLaunchPayload({ agentId: '', prompt: 'request' }),
    AionUiExternalLaunchPayloadError,
  )
  assert.throws(
    () => normalizeAionUiExternalLaunchPayload({ agentId: 'claude', prompt: 'x'.repeat(256 * 1_024 + 1) }),
    AionUiExternalLaunchPayloadError,
  )
  assert.throws(
    () => normalizeAionUiExternalLaunchPayload({ agentId: 'claude', prompt: 'request', mcpIds: Array(129).fill('mcp') }),
    AionUiExternalLaunchPayloadError,
  )
})

test('MindNProgress가 발급한 loopback 완료 주소에서만 token을 추출한다', () => {
  const valid = `http://127.0.0.1:4176/api/integrations/aionui/launches/${COMPLETION_TOKEN}/conversation`
  assert.equal(parseMindNProgressCompletionToken(valid, 4176), COMPLETION_TOKEN)
  assert.equal(parseMindNProgressCompletionToken(valid, 4177), null)
  assert.equal(parseMindNProgressCompletionToken(valid.replace('127.0.0.1', 'localhost'), 4176), null)
  assert.equal(parseMindNProgressCompletionToken(valid.replace('127.0.0.1', '[::1]'), 4176), COMPLETION_TOKEN)
  assert.equal(parseMindNProgressCompletionToken(`${valid}?retry=1`, 4176), null)
})

test('서브 머신에는 허용한 공개 MindNProgress 주소의 완료 token을 전달한다', () => {
  const valid = `https://mind.example:4175/api/integrations/aionui/launches/${COMPLETION_TOKEN}/conversation`
  assert.equal(parseMindNProgressCompletionToken(valid, ['http://127.0.0.1:4176', 'https://mind.example:4175']), COMPLETION_TOKEN)
  assert.equal(parseMindNProgressCompletionToken(valid.replace('mind.example', 'other.example'), ['https://mind.example:4175']), null)
})

test('AionUi WebUI launch 주소에는 짧은 ticket만 포함한다', () => {
  const launchId = 'a'.repeat(64)
  assert.equal(
    createAionUiWebLaunchUrl('http://10.77.15.110:7777/previous?value=1#old', launchId),
    `http://10.77.15.110:7777/#/guid?external-launch=${launchId}`,
  )
  assert.throws(() => createAionUiWebLaunchUrl('http://10.77.15.110:7777', 'short'))
})
