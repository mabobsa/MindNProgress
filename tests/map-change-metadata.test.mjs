import assert from 'node:assert/strict'
import test from 'node:test'
import {
  revisionReasonLabel,
  shouldRefreshMapContentForAction,
} from '../src/utils/mapChangeMetadata.mjs'

test('공유 지식 검토를 다른 편집자에게 반영할 콘텐츠 변경으로 분류한다', () => {
  for (const action of ['content', 'history-restored', 'daily-backup-restored', 'shared-knowledge-reviewed', 'cross-document-card-move']) {
    assert.equal(shouldRefreshMapContentForAction(action), true)
  }
  for (const action of ['rename', 'color', 'metadata', 'trashed']) {
    assert.equal(shouldRefreshMapContentForAction(action), false)
  }
})

test('공유 지식 검토 이력을 전용 라벨로 표시한다', () => {
  assert.equal(revisionReasonLabel('shared-knowledge-review'), '공유 지식 정리')
  assert.equal(revisionReasonLabel('history-restore'), '이전 버전 복원')
  assert.equal(revisionReasonLabel('unknown'), '문서 변경')
})
