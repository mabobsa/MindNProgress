import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildAiUsageResult } from '../mcp/aiUsage.mjs'
import {
  claudeAccountRequestId,
  claudeAccountRoleForPurpose,
  createAiClaudeAccountPolicy,
  findClaudeAccount,
  formatAiAuthorName,
  normalizeClaudeAccounts,
  resolveClaudeAccountSelection,
  resolveExplicitClaudeAccount,
} from '../server/lib/aiClaudeAccounts.mjs'
import { mergeAiDelegationSelections } from '../server/lib/aiDelegations.mjs'
import { normalizeAionUiSubscriptionUsage } from '../server/lib/aionUiSubscriptionUsage.mjs'
import { aiConversationLinkFromAionUiConversation, normalizeAiConversationLink } from '../src/utils/aiConversations.mjs'
import { claudeAccountMark, claudeAccountRole, mostUsedClaudeUsageEntry, resolveDialogClaudeAccountId } from '../src/utils/claudeAccounts.mjs'

const accounts = [
  { id: 'default', number: 1, label: 'Team' },
  { id: 'max', number: 2, label: 'Max' },
]
const claudeRow = (claudeAccounts) => ({ id: 'claude-row', backend: 'claude', claude_accounts: claudeAccounts })

test('계정이 1개인 AionUi 행에는 계정 목록을 만들지 않는다', () => {
  assert.equal(normalizeClaudeAccounts(claudeRow(undefined)), undefined)
  assert.equal(normalizeClaudeAccounts(claudeRow(accounts.slice(0, 1))), undefined)
  assert.equal(normalizeClaudeAccounts({ ...claudeRow(accounts), backend: 'codex' }), undefined)
  assert.deepEqual(normalizeClaudeAccounts(claudeRow(accounts)), accounts)
})

test('그룹 총괄만 총괄 계정 용도이고 나머지 용도는 같은 기본 계정을 쓴다', () => {
  assert.equal(claudeAccountRoleForPurpose('group-coordination'), 'coordinator')
  for (const purpose of ['card', 'dooray-response', 'card-layout', 'document-reconstruction', 'shared-knowledge-review']) {
    assert.equal(claudeAccountRoleForPurpose(purpose), 'others')
  }
  assert.equal(claudeAccountRole('group-coordination'), 'coordinator')
})

test('사람의 선택은 정책보다 우선하고 AI 대화의 기본값은 정책을 우선한다', () => {
  assert.equal(resolveClaudeAccountSelection({ accounts, requested: 'default', policyAccountId: 'max' }), 'default')
  assert.equal(resolveClaudeAccountSelection({ accounts, requested: 'default', policyAccountId: 'max', enforcePolicy: true }), 'max')
  assert.equal(resolveClaudeAccountSelection({ accounts, requested: 'gone', policyAccountId: 'max' }), 'max')
  assert.equal(resolveClaudeAccountSelection({ accounts, requested: 'max' }), 'max')
})

test('명시한 계정 번호는 실행 머신의 목록에서 찾고 번호를 기본 계정으로 추측하지 않는다', () => {
  const choose = input => resolveExplicitClaudeAccount({ backend: 'claude', accounts, ...input })
  assert.equal(choose({}), null)
  assert.equal(choose({ accountNumber: 1 }), 'default')
  assert.equal(choose({ accountNumber: 2 }), 'max')
  assert.equal(choose({ accountId: ' max ' }), 'max')
  assert.equal(choose({ accountNumber: 1, accounts: [
    { id: 'max', number: 1 }, { id: 'default', number: 2 },
  ] }), 'max')
  assert.equal(choose({ accountNumber: 1, accounts: undefined }), 'default')
  assert.equal(choose({ accountId: 'default', accounts: undefined }), 'default')
  for (const input of [{ accountNumber: 3 }, { accountId: 'missing' }, { accountId: '' }, { accountId: null },
    { accountId: 'x'.repeat(121) }, { accountId: 1 }, { accountNumber: '1' }, { accountNumber: 0 },
    { accountNumber: 1.5 }, { accountNumber: null }, { accountNumber: 2, accounts: undefined },
    { accountId: 'max', accounts: undefined }, { accountNumber: 1, backend: 'codex' },
    { accountId: 'default', accountNumber: 1 }]) assert.throws(() => choose(input), /Claude 계정/)
})

test('정책 계정이 없거나 목록에 없으면 상위 대화의 계정을 물려받는다', () => {
  assert.equal(resolveClaudeAccountSelection({ accounts, requested: 'max', policyAccountId: 'gone', enforcePolicy: true }), 'max')
  assert.equal(resolveClaudeAccountSelection({ accounts, requested: '', policyAccountId: '' }), null)
})

test('계정이 1개면 어떤 요청이 와도 계정을 지정하지 않는다', () => {
  assert.equal(resolveClaudeAccountSelection({ accounts: undefined, requested: 'max', policyAccountId: 'max', enforcePolicy: true }), null)
  assert.equal(resolveClaudeAccountSelection({ accounts: accounts.slice(0, 1), requested: 'default' }), null)
})

test('AionCore 요청에는 기본 계정을 넣지 않아 단일 계정 요청과 같다', () => {
  assert.equal(claudeAccountRequestId('default'), undefined)
  assert.equal(claudeAccountRequestId(null), undefined)
  assert.equal(claudeAccountRequestId(' max '), 'max')
})

test('작성자 표기는 계정이 2개 이상일 때만 번호를 붙인다', () => {
  assert.equal(formatAiAuthorName('Claude Code', 'Opus', null), 'Claude Code(Opus)')
  assert.equal(formatAiAuthorName('Claude Code', 'Opus', findClaudeAccount(accounts, 'max')), 'Claude Code ②(Opus)')
  assert.equal(formatAiAuthorName('Claude Code', 'Opus', findClaudeAccount(accounts, undefined)), 'Claude Code ①(Opus)')
  assert.equal(claudeAccountMark(21), '#21')
})

test('역할 정책은 실행 머신별로 저장되고 다시 읽힌다', async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-claude-policy-'))
  try {
    const policy = await createAiClaudeAccountPolicy({ dataDirectory })
    assert.deepEqual(policy.get('main'), {})
    await policy.set('main', 'others', 'max')
    await policy.set('main', 'coordinator', 'default')
    await policy.set('sub', 'others', 'default')

    const reopened = await createAiClaudeAccountPolicy({ dataDirectory })
    assert.deepEqual(reopened.get('main'), { coordinator: 'default', others: 'max' })
    assert.deepEqual(reopened.get('sub'), { others: 'default' })
    await reopened.set('main', 'others', '')
    assert.deepEqual(reopened.get('main'), { coordinator: 'default' })
    await assert.rejects(reopened.set('main', 'unknown', 'max'))
    assert.match(await readFile(path.join(dataDirectory, '_ai-claude-account-policy.json'), 'utf8'), /"version": 1/)
  } finally {
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('위임 선택은 같은 AI 종류의 계정만 물려받는다', () => {
  const parent = { agent: { id: 'claude-row' }, model: { id: 'opus' }, claudeAccountId: 'max' }
  const merged = mergeAiDelegationSelections({ agentId: 'claude-row', modelId: 'opus' }, parent)
  assert.equal(merged.claudeAccountId, 'max')
  const other = mergeAiDelegationSelections({ agentId: 'codex-row', modelId: 'gpt' }, parent)
  assert.equal(other.claudeAccountId, null)
})

test('카드 대화 링크는 계정을 보존하고 AionUi 대화에서 복원한다', () => {
  const link = normalizeAiConversationLink({ conversationId: 'c1', claudeAccountId: 'max', skills: [], mcpServers: [] })
  assert.equal(link.claudeAccountId, 'max')
  assert.equal(normalizeAiConversationLink({ conversationId: 'c2', skills: [], mcpServers: [] }).claudeAccountId, undefined)
  const recovered = aiConversationLinkFromAionUiConversation({ id: 'c3', extra: { agent_id: 'claude-row', claude_account_id: 'max' } })
  assert.equal(recovered.claudeAccountId, 'max')
})

test('대화 창은 직접 고른 계정, 용도 정책, 1번 계정 순으로 표시한다', () => {
  assert.equal(resolveDialogClaudeAccountId(accounts, 'max', 'default'), 'max')
  assert.equal(resolveDialogClaudeAccountId(accounts, '', 'max'), 'max')
  assert.equal(resolveDialogClaudeAccountId(accounts, 'gone', 'gone'), 'default')
  assert.equal(resolveDialogClaudeAccountId(undefined, 'max', 'max'), '')
})

test('사용량 표시는 5시간·주간 중 사용률이 가장 높은 계정 하나를 대표로 고른다', () => {
  const entry = (key, state, session, weekly) => ({
    key,
    value: { state, session: session === null ? null : { usedPercent: session }, weekly: weekly === null ? null : { usedPercent: weekly } },
  })
  assert.equal(mostUsedClaudeUsageEntry([entry('team', 'ready', 30, 88), entry('max', 'ready', 70, 20)]).key, 'team')
  assert.equal(mostUsedClaudeUsageEntry([entry('team', 'ready', 30, 10), entry('max', 'ready', 70, null)]).key, 'max')
  assert.equal(mostUsedClaudeUsageEntry([entry('team', 'ready', 50, 0), entry('max', 'ready', 50, 0)]).key, 'team')
  assert.equal(mostUsedClaudeUsageEntry([entry('team', 'loading', null, null), entry('max', 'ready', 5, 5)]).key, 'max')
  assert.equal(mostUsedClaudeUsageEntry([entry('team', 'loading', null, null)]).key, 'team')
  assert.equal(mostUsedClaudeUsageEntry([]), null)
})

test('사용량 스냅숏은 계정이 2개 이상일 때만 계정별 값을 전달한다', () => {
  const base = {
    schemaVersion: 1, state: 'ready', generatedAt: '2026-07-31T03:00:00.000Z', updatedAt: '2026-07-31T03:00:00.000Z',
    retryAfterMs: null,
    claude: { state: 'ready', updatedAt: '2026-07-31T03:00:00.000Z', session: { usedPercent: 30, resetsAt: null }, weekly: null },
    codex: { state: 'unavailable', updatedAt: null, weekly: null, limitReached: false },
  }
  const now = Date.parse('2026-07-31T03:00:30.000Z')
  assert.equal('claudeAccounts' in normalizeAionUiSubscriptionUsage(base, { now }), false)

  const withAccounts = normalizeAionUiSubscriptionUsage({
    ...base,
    claudeAccounts: [
      { ...base.claude, id: 'default', number: 1, label: 'Team' },
      { ...base.claude, id: 'max', number: 2, label: 'Max', session: { usedPercent: 70, resetsAt: null } },
    ],
  }, { now })
  assert.deepEqual(withAccounts.claudeAccounts.map((account) => [account.number, account.session.usedPercent]), [[1, 30], [2, 70]])

  const mcp = buildAiUsageResult(withAccounts, { provider: 'claude', now })
  assert.deepEqual(mcp.claudeAccounts.map((account) => [account.number, account.session.usedPercent, account.usable]), [[1, 30, true], [2, 70, true]])
  assert.equal('claudeAccounts' in buildAiUsageResult(withAccounts, { provider: 'codex', now }), false)
  assert.equal('claudeAccounts' in buildAiUsageResult(normalizeAionUiSubscriptionUsage(base, { now }), { now }), false)
})
