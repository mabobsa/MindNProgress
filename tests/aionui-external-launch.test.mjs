import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AionUiExternalLaunchPayloadError,
  createAionUiConversationWebUrl,
  createAionUiDesktopLaunchUrl,
  createAionUiWebLaunchUrl,
  normalizeAionUiExternalLaunchPayload,
  parseMindNProgressCompletionToken,
} from '../server/lib/aionUiExternalLaunch.mjs'

const COMPLETION_TOKEN = 'A'.repeat(43)

test('긴 한글 전문은 서버 payload로 보존하고 데스크톱 URL에는 짧은 ticket만 넣는다', () => {
  const prompt = '승인한 제안과 사용자 추가 요청을 그대로 전달합니다.\n'.repeat(1000)
  const payload = normalizeAionUiExternalLaunchPayload({ agentId: 'codex', prompt,
    completionUrl: `http://127.0.0.1:4176/api/integrations/aionui/launches/${COMPLETION_TOKEN}/conversation` })
  assert.equal(payload.prompt, prompt.trim())
  assert.ok(Buffer.from(JSON.stringify(payload)).toString('base64').length > 32767)
  const url = createAionUiDesktopLaunchUrl('a'.repeat(64))
  assert.equal(url, `aionui://conversation/new?launchId=${'a'.repeat(64)}`)
  assert.ok(url.length < 128)
  for (const invalid of [null, undefined, '', 'short', 'A'.repeat(64), '../other']) assert.throws(() => createAionUiDesktopLaunchUrl(invalid))
})

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

test('AionUi 대화 주소는 지정한 머신 WebUI를 유지한다', () => {
  assert.equal(
    createAionUiConversationWebUrl('http://10.78.12.223:7777/previous?value=1#old', 'conversation-on-mac'),
    'http://10.78.12.223:7777/#/conversation/conversation-on-mac',
  )
  assert.throws(() => createAionUiConversationWebUrl('http://10.78.12.223:7777', 'invalid conversation'))
})
