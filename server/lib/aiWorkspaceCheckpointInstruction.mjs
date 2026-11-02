import { aiDelegationWorkspaceLeaseMatches } from './aiDelegations.mjs'

// AionCore routes_external_dispatch.rs: 320 KiB JSON body;
// external_dispatch.rs: MAX_INSTRUCTION_BYTES = 256 * 1024.
const coreInstructionLimit = 256 * 1024
const filePreviewBytes = 6_000
const filePreviewCount = 25

export function checkpointChangedFilesText(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : []
  if (!files.length) return '- Git status로 현재 변경을 다시 확인하세요.'
  const preview = []
  let bytes = 0
  for (const file of files) {
    const line = `- ${file}`
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (preview.length >= filePreviewCount || bytes + size > filePreviewBytes) break
    preview.push(line)
    bytes += size
  }
  const omitted = files.length - preview.length
  return `전체 변경 후보: ${files.length}개\n${preview.join('\n')}${omitted > 0
    ? `\n\n위 목록은 일부이며 ${omitted}개 경로를 생략했습니다. 전체 목록은 할당된 projectRoot에서 \`git status --porcelain=v1 -z --untracked-files=all\`로 다시 확인하세요. 이 요약만으로 체크포인트 범위를 정하지 마세요.` : ''}`
}

// Only the pre-summary checkpoint recovery format can prove non-acceptance from
// its immutable attempt snapshot. A 404 alone must never release pending work.
export function rejectedOversizedCheckpointRecoveryPatch(delegation) {
  const pending = delegation?.pendingRecovery
  if (!pending || pending.checkpointInstructionVersion !== undefined || pending.dispatchBody || pending.resultCorrection
    || !pending.integrationRecovery || pending.sourceState !== 'integration-recovery-required'
    || delegation.state !== 'integration-recovery-required' || delegation.workspaceResult?.status !== 'checkpoint-required'
    || !Number.isSafeInteger(pending.attempt) || pending.attempt < 1 || !pending.operationId || !pending.requestedAt
    || !pending.workspaceLease?.leaseId || !aiDelegationWorkspaceLeaseMatches(pending.workspaceLease, delegation.workspaceLease)) return null
  const original = delegation.attemptHistory?.find((attempt) => attempt.at === pending.requestedAt
    && attempt.reason === '사용자가 승인 범위의 기존 작업 재개 요청'
    && attempt.state === pending.sourceState && attempt.workspaceResult?.status === 'checkpoint-required'
    && aiDelegationWorkspaceLeaseMatches(attempt.workspaceLease, pending.workspaceLease))
  const files = original?.workspaceResult?.changedFiles
  if (!Array.isArray(files) || !files.length || files.some((file) => typeof file !== 'string')) return null
  const minimumInstructionBytes = files.reduce((bytes, file) => bytes + Buffer.byteLength(file, 'utf8') + 3, -1)
  if (minimumInstructionBytes <= coreInstructionLimit) return null
  return {
    pendingRecovery: null,
    recoveryDispatchError: '이전 복구 요청은 변경 파일 목록이 AionCore 지시 크기 제한을 초과했고 접수 기록도 없어 종료했습니다. 기존 작업 재개로 요약된 지시를 다시 보낼 수 있습니다.',
    rejectedCheckpointRecovery: { operationId: pending.operationId, attempt: pending.attempt, requestedAt: pending.requestedAt,
      reason: 'checkpoint-instruction-too-large', changedFileCount: files.length, minimumInstructionBytes, instructionLimitBytes: coreInstructionLimit },
  }
}

export function workspaceCheckpointInstruction(delegation, workspaceResult) {
  const files = checkpointChangedFilesText(workspaceResult?.changedFiles)
  return `# MindNProgress 명시적 체크포인트 요청

하위 작업이 완료되었지만 Unity Play·재임포트·동적 자산 생성 등의 부산물과 구현 변경을 구분할 명시적 체크포인트가 없어 main 통합을 중단했습니다.

- 하위 카드: ${delegation.targetCardLabel} (${delegation.targetCardId})
- workspaceId: ${delegation.workspaceLease.workspaceId}
- jobId: ${delegation.workspaceLease.jobId}
- leaseId: ${delegation.workspaceLease.leaseId}
- projectRoot: ${delegation.workspaceLease.projectRoot}
- 요청 회차: ${workspaceResult.checkpointRound}

## 현재 변경 후보

${files}

최신 카드 요구사항과 Git diff를 대조해 의도한 구현 변경과 검증 부산물을 구분하세요. 의도한 파일 변경이 있으면 \`mindnprogress_checkpoint_ai_workspace\`의 \`operation.action=commit-changes\`와 함께 \`paths\` 및 실제 변경을 설명하는 \`commitMessage\`의 \`summary\`·\`background\`·\`cause\`·\`changes\`, 필요한 경우 \`scope\`를 작성하세요. \`summary\`의 커밋 제목 prefix(사용자 커밋 규칙의 이름 머리말 등)와 출처를 나타내는 \`[MnP]\` 및 나머지 본문 섹션은 서버가 추가하므로 직접 넣지 마세요. 폴더 범위로 대량 추가·수정·삭제를 한 번의 체크포인트에 포함할 수 있습니다. 해당 폴더의 전체 변경이 의도된 것인지 확인하고 자동 변경은 포함하지 마세요. 의도한 파일 변경이 없다면 같은 도구의 \`operation.action=confirm-no-changes\`를 사용하세요. 구현과 자동 변경이 같은 파일에 섞여 있으면 기준 내용으로 되돌린 뒤 의도한 수정만 다시 적용하세요. 체크포인트 후 필수 검증을 다시 수행하고 최종 결과를 보고하세요.`
}

