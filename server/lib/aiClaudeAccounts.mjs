import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { replaceFileWithRetry } from './replaceFileWithRetry.mjs'

// Claude 멀티 계정(AionUi fork). 계정 목록과 번호는 AionCore가 정하고, 이 모듈은
// 그 번호를 그대로 쓰면서 대화 용도별 기본 계정(역할 정책)만 MnP에 저장한다.
// 계정이 1개면 AionCore가 목록을 주지 않으며, 기본 계정은 실제 생성 요청에서 생략한다.

export const DEFAULT_CLAUDE_ACCOUNT_ID = 'default'
const ROLES = new Set(['coordinator', 'others'])
const MAX_ID_LENGTH = 120

const cleanId = (value) => {
  const id = String(value ?? '').trim()
  return id && id.length <= MAX_ID_LENGTH ? id : ''
}

/** AionCore 관리 목록의 Claude 행에서 계정 목록을 정리한다. 2개 미만이면 undefined. */
export function normalizeClaudeAccounts(agent) {
  if (agent?.backend !== 'claude' || !Array.isArray(agent?.claude_accounts) || agent.claude_accounts.length < 2) return undefined
  const accounts = agent.claude_accounts.flatMap((account) => {
    const id = cleanId(account?.id)
    const number = Number(account?.number)
    return id && Number.isInteger(number) && number > 0
      ? [{ id, number, label: String(account?.label ?? '').trim().slice(0, 80) || id }]
      : []
  })
  return accounts.length >= 2 ? accounts : undefined
}

/** 그룹 총괄 대화만 총괄 계정을 쓰고, 문서·카드·위임·Dooray 등 그 외 용도는 같은 기본 계정을 쓴다. */
export function claudeAccountRoleForPurpose(purpose) {
  return purpose === 'group-coordination' ? 'coordinator' : 'others'
}

/**
 * 새 대화에 사용할 계정. 사람의 선택(`requested`)은 정책 기본값보다 우선하고,
 * AI 대화의 기본값(`enforcePolicy`)은 설정된 정책을 따른다. 이번 요청의 명시적
 * 계정은 resolveExplicitClaudeAccount로 먼저 검증·적용한다. 기본값 목록에 없는 값은
 * 버리며, 결과가 없으면 기본 계정(키 없음)으로 만든다.
 */
export function resolveClaudeAccountSelection({ accounts, requested, policyAccountId, enforcePolicy = false }) {
  if (!Array.isArray(accounts) || accounts.length < 2) return null
  const valid = (id) => Boolean(id) && accounts.some((account) => account.id === id)
  const requestedId = cleanId(requested)
  const policyId = cleanId(policyAccountId)
  if (enforcePolicy && valid(policyId)) return policyId
  if (valid(requestedId)) return requestedId
  if (valid(policyId)) return policyId
  return null
}

/** 이번 새 대화에 명시한 계정만 검증한다. 잘못된 선택은 정책 계정으로 대체하지 않는다. */
export function resolveExplicitClaudeAccount({ backend, accounts, accountId, accountNumber }) {
  if (accountId === undefined && accountNumber === undefined) return null
  if (backend !== 'claude') throw new Error('Claude 계정은 Claude Code 새 대화에만 지정할 수 있습니다.')
  if (accountId !== undefined && accountNumber !== undefined) throw new Error('Claude 계정 ID와 번호 중 하나만 지정하세요.')
  if (accountId !== undefined && (typeof accountId !== 'string' || !accountId.trim() || accountId.trim().length > MAX_ID_LENGTH)) {
    throw new Error('Claude 계정 ID는 1~120자의 문자열이어야 합니다.')
  }
  if (accountNumber !== undefined && (!Number.isSafeInteger(accountNumber) || accountNumber < 1)) {
    throw new Error('Claude 계정 번호는 1 이상의 정수여야 합니다.')
  }
  const id = accountId?.trim()
  const available = Array.isArray(accounts) && accounts.length >= 2 ? accounts
    : [{ id: DEFAULT_CLAUDE_ACCOUNT_ID, number: 1 }]
  const account = available.find(item => accountNumber !== undefined ? item.number === accountNumber : item.id === id)
  if (!account) throw new Error('실행 머신에서 지정한 Claude 계정을 확인할 수 없습니다. 다른 계정으로 변경하지 않았습니다. 계정 목록을 확인하세요.')
  return account.id
}

/** AionCore 대화 생성 요청에 넣을 값. 기본 계정이면 넣지 않아 단일 계정 요청과 같다. */
export function claudeAccountRequestId(accountId) {
  const id = cleanId(accountId)
  return id && id !== DEFAULT_CLAUDE_ACCOUNT_ID ? id : undefined
}

const CIRCLED_DIGITS = 20
/** 댓글 작성자 표기 등에 쓰는 원형 번호(①…⑳, 이후 #n). */
export function claudeAccountMark(number) {
  const value = Number(number)
  if (!Number.isInteger(value) || value < 1) return ''
  return value <= CIRCLED_DIGITS ? String.fromCodePoint(0x2460 + value - 1) : `#${value}`
}

/**
 * 댓글·이력의 AI 작성자 표기. 계정이 2개 이상일 때만 계정 번호를 붙이므로
 * 단일 계정 표기는 기존과 같다. 작성자 복원도 같은 함수를 써야 이름이 맞는다.
 */
export function formatAiAuthorName(agentName, modelName, account) {
  const mark = account ? claudeAccountMark(account.number) : ''
  return `${agentName}${mark ? ` ${mark}` : ''}(${modelName})`
}

export function findClaudeAccount(accounts, accountId) {
  if (!Array.isArray(accounts) || accounts.length < 2) return null
  const id = cleanId(accountId) || DEFAULT_CLAUDE_ACCOUNT_ID
  return accounts.find((account) => account.id === id) ?? null
}

/** 실행 머신별 역할 정책 저장소. 정책이 없으면 기존처럼 위임 대화가 상위 대화의 계정을 물려받는다. */
export async function createAiClaudeAccountPolicy({ dataDirectory, replaceFile = replaceFileWithRetry }) {
  const file = path.join(dataDirectory, '_ai-claude-account-policy.json')
  let machines = {}
  try {
    const stored = JSON.parse(await readFile(file, 'utf8'))
    if (stored?.version !== 1 || !stored.machines || typeof stored.machines !== 'object') {
      throw new Error('Claude 계정 정책 파일의 형식을 확인할 수 없습니다.')
    }
    machines = Object.fromEntries(Object.entries(stored.machines).map(([machineId, policy]) => [machineId, {
      ...(cleanId(policy?.coordinator) ? { coordinator: cleanId(policy.coordinator) } : {}),
      ...(cleanId(policy?.others) ? { others: cleanId(policy.others) } : {}),
    }]))
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  let queue = Promise.resolve()

  const get = (machineId) => ({ ...(machines[cleanId(machineId)] ?? {}) })
  const set = (machineId, role, accountId) => {
    const machine = cleanId(machineId)
    if (!machine || !ROLES.has(role)) {
      return Promise.reject(Object.assign(new Error('Claude 계정 정책의 실행 머신이나 용도가 올바르지 않습니다.'), { status: 400 }))
    }
    const operation = queue.then(async () => {
      const current = { ...(machines[machine] ?? {}) }
      const id = cleanId(accountId)
      if (id) current[role] = id
      else delete current[role]
      const next = { ...machines, [machine]: current }
      await mkdir(dataDirectory, { recursive: true })
      const temporaryFile = `${file}.${randomBytes(5).toString('hex')}.tmp`
      try {
        await writeFile(temporaryFile, `${JSON.stringify({ version: 1, machines: next }, null, 2)}\n`, 'utf8')
        await replaceFile(temporaryFile, file)
      } catch (error) { await rm(temporaryFile, { force: true }).catch(() => {}); throw error }
      machines = next
      return get(machine)
    })
    queue = operation.catch(() => {})
    return operation
  }
  return { get, set }
}
