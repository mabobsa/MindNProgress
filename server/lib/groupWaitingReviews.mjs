import { createHash } from 'node:crypto'
import { groupWaitingCategories, groupWaitingImpacts } from '../../src/utils/groupWaiting.mjs'
import { groupPlanningSources } from '../../src/utils/groupPlanningSources.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function groupCriteriaFingerprint(project) {
  const sources = groupPlanningSources(project)
  const content = [sources[0]?.source ?? '', sources[0]?.sourceVersion ?? '', project.objective ?? '', project.instructions ?? '']
  // 단일 원본을 목록으로 읽는 것만으로 이전 분류를 무효화하지 않는다. 실제 추가·수정은 모두 포함한다.
  if (sources.length > 1 || sources[0]?.title) content.push(sources.map(({ title, source, sourceVersion }) => [title, source, sourceVersion]))
  return hash(content)
}
const waitingFingerprint = (card, item) => hash([card.id, card.data.label, card.data.status, card.data.isWork, card.data.kind, item.id, item.label, item.note ?? '', item.resumeCondition ?? '', item.since ?? ''])

export function groupWaitingDetails(map, root, project) {
  const criteriaFingerprint = groupCriteriaFingerprint(project)
  const reviews = project.waitingReviews ?? []
  return map.nodes.filter((card) => card.id === root?.id || card.data?.isWork).flatMap((card) => (card.data.waitingItems ?? []).map((item) => {
    // 분류 편집 중 기준이 바뀐 경우에도 이전 화면에서 본 내용을 저장할 수 없게 묶는다.
    const fingerprint = hash([waitingFingerprint(card, item), criteriaFingerprint])
    const review = reviews.find((value) => value.mapId === map.id && value.cardId === card.id && value.waitingId === item.id)
    return {
      cardId: card.id, cardTitle: card.data.label, cardStatus: card.data.status, isRoot: card.id === root?.id,
      item: { ...item }, fingerprint,
      review: review ? { category: review.category, impact: review.impact, reviewedAt: review.reviewedAt, reviewedBy: review.reviewedBy,
        valid: review.fingerprint === fingerprint && review.criteriaFingerprint === criteriaFingerprint,
        invalidReason: review.criteriaFingerprint !== criteriaFingerprint ? '기획 기준 변경' : review.fingerprint !== fingerprint ? '카드 또는 대기 내용 변경' : null,
      } : null,
    }
  }))
}

export function applyGroupWaitingReview(project, map, root, body, user) {
  const fail = (message, status = 400) => { throw Object.assign(new Error(message), { groupProjectError: true, status }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ![body.mapId, body.cardId, body.waitingId, body.expectedFingerprint].every((value) => typeof value === 'string' && value.length > 0)
    || !groupWaitingCategories.some((value) => value.id === body.category)
    || !groupWaitingImpacts.some((value) => value.id === body.impact)) fail('대기 분류의 대상·사유·영향을 올바르게 지정해 주세요.')
  if (body.impact === 'deferred' && body.category !== 'external') fail('예정된 외부 대기는 외부 자료 대기로 분류한 항목에만 지정할 수 있습니다.')
  if (!map || map.id !== body.mapId || map.trashedAt || map.archivedAt) fail('현재 그룹의 활성 문서만 분류할 수 있습니다.', 409)
  const detail = groupWaitingDetails(map, root, project).find((value) => value.cardId === body.cardId && value.item.id === body.waitingId)
  if (!detail || detail.fingerprint !== body.expectedFingerprint) fail('대기 기록이 변경되거나 해제되었습니다. 최신 사유를 다시 확인해 주세요.', 409)
  const remaining = (project.waitingReviews ?? []).filter((value) => !(value.mapId === body.mapId && value.cardId === body.cardId && value.waitingId === body.waitingId))
  if (remaining.length >= 5000) fail('저장 가능한 대기 분류 수를 초과했습니다.')
  return [...remaining, { mapId: body.mapId, cardId: body.cardId, waitingId: body.waitingId,
    fingerprint: detail.fingerprint, criteriaFingerprint: groupCriteriaFingerprint(project), category: body.category, impact: body.impact,
    reviewedAt: new Date().toISOString(), reviewedBy: { id: user.id, name: user.name },
  }]
}
