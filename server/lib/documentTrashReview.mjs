import { createHash } from 'node:crypto'

export class DocumentTrashReviewError extends Error {
  constructor(message, status, code, preview) {
    super(message)
    this.status = status
    this.code = code
    this.preview = preview
  }
}

// 본문·댓글은 응답에 포함하지 않는다. 휴지통 대상과 외부 Ref의 위치만 비교한다.
export function createDocumentTrashReview({ listDocumentIds, readDocument }) {
  async function inspect(mapId) {
    const target = await readDocument(mapId)
    if (!target) throw new DocumentTrashReviewError('문서를 찾을 수 없습니다.', 404, 'TRASH_TARGET_MISSING')
    if (target.trashedAt) throw new DocumentTrashReviewError('이미 휴지통으로 이동한 문서입니다.', 409, 'TRASH_TARGET_UNAVAILABLE')
    if (target.reconstructionPending) throw new DocumentTrashReviewError('전환 중인 문서는 이동할 수 없습니다.', 409, 'TRASH_TARGET_UNAVAILABLE')
    const cards = new Map(target.nodes.map((node) => [node.id, node.label]))
    const references = []
    for (const id of await listDocumentIds()) {
      if (id === mapId) continue
      const map = await readDocument(id)
      if (!map) throw new DocumentTrashReviewError('참조 확인 중 문서가 변경되었습니다. 다시 조회해 주세요.', 409, 'TRASH_REFERENCES_UNVERIFIED')
      if (map.trashedAt || map.reconstructionPending) continue
      for (const node of map.nodes) {
        if (node.reference?.mapId !== mapId) continue
        references.push({ mapId: id, mapTitle: map.title, cardId: node.id, cardTitle: node.label,
          sourceCardId: node.reference.nodeId, sourceCardTitle: cards.get(node.reference.nodeId) ?? '원본 카드 없음',
          archived: Boolean(map.archivedAt) })
      }
    }
    references.sort((a, b) => a.mapTitle.localeCompare(b.mapTitle, 'ko') || a.mapId.localeCompare(b.mapId)
      || a.cardTitle.localeCompare(b.cardTitle, 'ko') || a.cardId.localeCompare(b.cardId))
    const document = { id: target.id, title: target.title, version: target.version,
      lifecycleVersion: target.lifecycleVersion ?? 0, archived: Boolean(target.archivedAt) }
    const referenceVersion = createHash('sha256').update(JSON.stringify({ target: document, references })).digest('hex')
    return { target: document, references, referenceVersion }
  }

  // 호출자는 문서 변경 잠금을 잡은 상태에서 검사와 실제 이동을 연속해서 실행한다.
  async function assertReviewed(mapId, referenceVersion) {
    const preview = await inspect(mapId)
    if (referenceVersion === undefined && preview.references.length === 0) return preview
    if (referenceVersion !== preview.referenceVersion) {
      throw new DocumentTrashReviewError(referenceVersion === undefined
        ? '다른 문서에서 참조 중인 카드가 있습니다. 참조 위치를 확인한 뒤 이동해 주세요.'
        : '문서 또는 Ref 참조가 변경되었습니다. 최신 목록을 확인한 뒤 다시 이동해 주세요.',
      409, 'TRASH_REFERENCES_CHANGED', preview)
    }
    return preview
  }
  return { inspect, assertReviewed }
}
