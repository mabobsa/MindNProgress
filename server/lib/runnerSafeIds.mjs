import { createHash } from 'node:crypto'

// 서브 머신의 AionUi 내장 Runner는 실행 ID가 경로에 들어가는 요청에서 영문·숫자·밑줄·하이픈만 허용한다
// (AionUi mindnprogressRunner/runtime.ts의 AIONUI_ENTITY_ID_PATTERN). 콜론이 들어간 실행 ID는 첫 전달 요청
// (경로에 ID 없음)은 통과하지만 이후 상태 조회·완료 처리가 모두 RUNNER_OPERATION_REJECTED로 거부되어
// 위임이 starting에 멈춘다. 새로 만드는 ID에만 이 규칙을 적용하고, 기존 기록은 저장 형식 그대로 읽고 조회한다.
const RUNNER_SAFE_CHARACTERS = /^[A-Za-z0-9_-]+$/
const RUNNER_ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/
export const NEW_AI_DELEGATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const NEW_GROUP_DOCUMENT_INSTRUCTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/
export const RUNNER_SAFE_ID_RULE = '영문·숫자로 시작하고 영문·숫자·밑줄(_)·하이픈(-)만 사용'
export const RUNNER_OPERATION_REJECTED = 'RUNNER_OPERATION_REJECTED'
export const RUNNER_REJECTED_CLOSURE_REASON = 'runner-rejected-operation'
const RUNNER_REJECTION_CLOSABLE_STATES = new Set(['starting', 'waiting-resource', 'running', 'waiting-child-resume'])

export function isNewAiDelegationIdAllowed(value) {
  return NEW_AI_DELEGATION_ID_PATTERN.test(String(value ?? ''))
}

export function isNewGroupDocumentInstructionIdAllowed(value) {
  return NEW_GROUP_DOCUMENT_INSTRUCTION_ID_PATTERN.test(String(value ?? ''))
}

export function isRunnerOperationRejected(error) {
  return error?.code === RUNNER_OPERATION_REJECTED
}

// Runner는 상태 조회 경로 자체를 허용하므로, 그 조회가 거부되는 원인은 실행 ID 형식뿐이다.
export function runnerRejectsOperationId(operationId) {
  return !RUNNER_ENTITY_ID_PATTERN.test(String(operationId ?? ''))
}

// 허용되지 않는 문자가 있으면 결정적으로 치환하고 원문 해시를 붙여 서로 다른 ID가 같은 실행 ID가 되지 않게 한다.
export function runnerSafeOperationIdPart(value) {
  const text = String(value ?? '')
  if (RUNNER_SAFE_CHARACTERS.test(text)) return text
  const digest = createHash('sha256').update(text).digest('hex').slice(0, 12)
  return `${text.replace(/[^A-Za-z0-9_-]/g, '-')}-${digest}`
}

// 같은 실행 ID를 다시 조회해도 Runner 거부는 풀리지 않는다. 조용히 넘기지 않고 위임에 한 번 기록한다.
// 실행 ID가 Runner 규칙에 맞으면 다른 요청의 거부이므로 이 실행 ID의 원인으로 기록하지 않는다.
// 이미 같은 실행 ID의 거부가 기록돼 있으면 null을 돌려 폴링마다 다시 저장하지 않는다.
export function aiDelegationRunnerRejectionPatch(delegation, error, { operationId, machineId = null }, observedAt = new Date().toISOString()) {
  if (!isRunnerOperationRejected(error) || !operationId || !runnerRejectsOperationId(operationId)) return null
  if (delegation?.runnerRejection?.operationId === operationId) return null
  return {
    runnerRejection: {
      code: RUNNER_OPERATION_REJECTED,
      operationId,
      machineId,
      message: String(error?.message ?? '').slice(0, 300),
      observedAt,
    },
  }
}

// 하위 실행 ID 조회가 Runner에서 거부된 위임은 MnP가 실행 결과를 확인할 수 없다.
// 작업공간·복구·그룹이 걸리지 않은 경우에만 대상 대화가 쉬는 상태인지 확인한 뒤 사용자 종료를 허용한다.
export function aiDelegationRunnerRejectedClosable(delegation) {
  return Boolean(delegation?.runnerRejection?.operationId
    && delegation.runnerRejection.operationId === (delegation.childOperationId ?? delegation.id)
    && RUNNER_REJECTION_CLOSABLE_STATES.has(String(delegation.state ?? ''))
    && !delegation.workspaceLease?.leaseId
    && !delegation.pendingRecovery
    && !delegation.recoveryDispatchRejection
    && !delegation.groupId)
}

export function aiDelegationReadsChildOperation(delegation) {
  return RUNNER_REJECTION_CLOSABLE_STATES.has(String(delegation?.state ?? ''))
    && !delegation.pendingRecovery
    && !delegation.recoveryDispatchRejection
}
