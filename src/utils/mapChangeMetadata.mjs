const mapContentRefreshActions = new Set([
  'content',
  'history-restored',
  'daily-backup-restored',
  'shared-knowledge-reviewed',
  'archived',
  'archive-restored',
  'reconstructed',
  'cross-document-card-move',
])

const revisionReasonLabels = Object.freeze({
  content: '내용 편집',
  rename: '이름 변경',
  color: '색상 변경',
  metadata: '문서 정보 변경',
  'history-restore': '이전 버전 복원',
  'shared-knowledge-review': '공유 지식 정리',
  'card-move': '카드 이동',
  'cross-document-card-move': '문서 간 카드 이동',
})

export function shouldRefreshMapContentForAction(action) {
  return mapContentRefreshActions.has(action)
}

export function revisionReasonLabel(reason) {
  return revisionReasonLabels[reason] ?? '문서 변경'
}
