const phaseLabels = { child: '하위 실행 요청', recovery: '복구 요청', report: '상위 AI로의 결과 전달 요청' }

export class AiDelegationStatusLookupError extends Error {
  constructor(phase, cause) {
    super(`AionUi에서 기존 ${phaseLabels[phase]} 기록을 찾지 못해 최신 상태를 확인할 수 없습니다. 저장된 위임 상태와 결과는 그대로 유지했으며 AI를 재실행하지 않았습니다. ${phase === 'recovery' ? '복구 요청의 전달 여부도 아직 확인되지 않았으므로 새 요청을 만들지 않았습니다. ' : ''}연결된 AI 대화에서 진행 내용과 결과를 확인해 주세요.`, { cause })
    this.name = 'AiDelegationStatusLookupError'
    this.status = 409
    this.code = 'AI_DELEGATION_STATUS_NOT_FOUND'
    this.phase = phase
  }

  responseBody() {
    return {
      error: this.message, code: this.code,
      statusCheck: { state: 'unavailable', reason: 'operation-not-found', phase: this.phase },
      executionRequested: false, storedStatePreserved: true,
    }
  }
}

// 이 함수는 저장된 operation의 조회만 수행한다. 다른 대화 검색·재실행·상태 변경은 하지 않는다.
export async function readAiDelegationDispatchStatus(fetchOn, { machineId, operationId, phase = 'child' }) {
  try {
    return await fetchOn(machineId, `/api/internal/external-conversation-dispatches/${encodeURIComponent(operationId)}`)
  } catch (error) {
    if (error?.status === 404) throw new AiDelegationStatusLookupError(phase, error)
    throw error
  }
}
