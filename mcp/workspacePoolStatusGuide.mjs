// Status meanings returned by mindnprogress_get_ai_workspace_pool.
// Source of truth: docs/ai-workspace-pool-states.md, server/lib/workspacePool.mjs, server/lib/remoteWorkspacePool.mjs, runner/lib/workspaceAgent.mjs.
export const WORKSPACE_POOL_STATUS_GUIDE = Object.freeze({
  idle: '새 위임 후보가 될 수 있지만 실제 배정은 MindNProgress가 수행합니다.',
  leased: '다른 AI 작업에 점유된 상태입니다.',
  quarantined: '자동 재사용할 수 없으며 원인을 확인하고 명시적으로 복구해야 합니다.',
  integration: '사용자 작업과 완료 결과의 통합 기준이며 AI worker로 직접 선택하지 않습니다.',
  preparing: 'lease 발급 전에 Git 기준선·브랜치·세션 파일을 준비하는 중입니다. 준비에 실패하면 quarantined로 남습니다.',
  'checkpoint-required': '하위 AI가 끝났지만 명시적 체크포인트 없이 변경이 남아 같은 대화에 체크포인트를 다시 요청한 상태입니다.',
  finalizing: '결과와 작업공간 상태를 회수하는 중입니다.',
  'waiting-integration': '결과를 보존한 채 통합을 기다립니다. 원인이 정리되면 자동으로 다시 통합하므로 재위임하지 마세요.',
  integrating: '최신 통합 기준에서 만든 통합 브랜치에 체크포인트를 적용하는 중입니다.',
  'resolving-integration-conflict': '통합 충돌을 같은 worker에서 같은 하위 AI 대화가 해결하는 중입니다.',
  'result-correction-preparing': '통합 대기 결과의 명시적 정정을 준비하는 중입니다.',
  'correcting-result': '통합 대기 결과의 명시적 정정을 진행하는 중입니다.',
  'integration-preparing': '원격 풀 전용. 메인 통합이 충돌해 원격 Fork에 통합 브랜치를 준비하는 중입니다. 메인은 바뀌지 않았으며 같은 하위 AI 대화가 충돌을 해결합니다.',
  'integration-candidate': '원격 풀 Runner 보고. 원격 Fork에서 충돌을 해결한 후보를 메인에 보냈고 메인 통합을 기다립니다. 재위임하지 마세요.',
  'release-pending': '원격 풀 전용. 통합 성공 후 Runner의 작업공간 반환 확인을 기다립니다.',
  'cleanup-pending': '원격 풀 전용. 완료 산출물 정리를 재시도하는 중이며 새 배정이 차단됩니다.',
  dirty: '원격 풀 Runner 보고. 배정 기록 없이 미커밋 변경이 있어 새 배정 후보가 아닙니다.',
  'foreign-session': '원격 풀 Runner 보고. 이 Runner가 배정하지 않은 .ai-session.json이 있어 새 배정 후보가 아닙니다.',
  'foreign-owner': '원격 풀 Runner 보고. 다른 코디네이터나 로컬 풀이 소유한 작업공간이라 새 배정 후보가 아닙니다.',
})

export const WORKSPACE_POOL_STATUS_REFERENCE = '상태 정의의 기준 문서는 MindNProgress 저장소의 docs/ai-workspace-pool-states.md입니다. statusGuide에 없는 상태는 추측하지 말고 사용자에게 확인하세요.'
