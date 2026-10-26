import assert from 'node:assert/strict'
import test from 'node:test'
import { createDocumentTrashReview } from '../server/lib/documentTrashReview.mjs'

function fixture() {
  const reference = { mapId: 'map-source', nodeId: 'original' }
  const documents = new Map([
    ['map-source', { id: 'map-source', title: '원본 문서', version: 3, nodes: [
      { id: 'original', label: '원본 카드', description: '비공개 본문' },
      { id: 'internal', label: '내부 참조', reference },
    ] }],
    ['map-active', { id: 'map-active', title: '활성 문서', nodes: [
      { id: 'ref-1', label: '첫 참조', reference }, { id: 'ref-2', label: '두 번째 참조', reference },
      { id: 'unrelated', label: '다른 문서 참조', reference: { mapId: 'map-other', nodeId: 'original' } },
    ] }],
    ['map-archive', { id: 'map-archive', title: '보관 문서', archivedAt: '2026-10-27', nodes: [{ id: 'ref-3', label: '보관 참조', reference }] }],
    ['map-trash', { id: 'map-trash', title: '휴지통 문서', trashedAt: '2026-10-27', nodes: [{ id: 'ref-4', label: '휴지통 참조', reference }] }],
    ['map-pending', { id: 'map-pending', title: '전환 중', reconstructionPending: true, nodes: [{ id: 'ref-5', label: '전환 중 참조', reference }] }],
  ])
  const review = createDocumentTrashReview({ listDocumentIds: async () => [...documents.keys()], readDocument: async (id) => documents.get(id) })
  return { documents, review }
}

test('외부 Ref 위치는 활성·보관 문서별로 모두 제공하고 내부·휴지통·전환 중 참조와 본문은 제외한다', async () => {
  const { review } = fixture()
  const preview = await review.inspect('map-source')
  assert.deepEqual(preview.references.map((item) => item.cardId).sort(), ['ref-1', 'ref-2', 'ref-3'])
  assert.equal(preview.references.filter((item) => item.archived).length, 1)
  assert.equal(preview.references.every((item) => item.sourceCardTitle === '원본 카드'), true)
  assert.equal(JSON.stringify(preview).includes('비공개 본문'), false)
  assert.deepEqual(preview.target, { id: 'map-source', title: '원본 문서', version: 3, lifecycleVersion: 0, archived: false })
})

test('사라진 원본을 가리키는 Ref도 누락하지 않는다', async () => {
  const { documents, review } = fixture()
  documents.get('map-active').nodes.push({ id: 'dangling', label: '남아 있는 참조', reference: { mapId: 'map-source', nodeId: 'missing' } })
  const dangling = (await review.inspect('map-source')).references.find((item) => item.cardId === 'dangling')
  assert.equal(dangling.sourceCardTitle, '원본 카드 없음')
  assert.equal(dangling.sourceCardId, 'missing')
})

test('참조가 있는 문서는 확인 전 이동을 차단하고 추가·제거·보관 변경 뒤에는 다시 확인한다', async () => {
  const { documents, review } = fixture()
  await assert.rejects(review.assertReviewed('map-source'), (error) => error.status === 409 && error.preview.references.length === 3)
  let preview = await review.inspect('map-source')
  await review.assertReviewed('map-source', preview.referenceVersion)
  const changes = [
    () => documents.get('map-active').nodes.push({ id: 'new-ref', label: '추가 참조', reference: { mapId: 'map-source', nodeId: 'original' } }),
    () => documents.get('map-active').nodes.pop(),
    () => { documents.get('map-active').archivedAt = '2026-10-27' },
    () => { documents.get('map-source').version += 1 },
  ]
  for (const change of changes) {
    change()
    await assert.rejects(review.assertReviewed('map-source', preview.referenceVersion), (error) => error.code === 'TRASH_REFERENCES_CHANGED' && error.preview.referenceVersion !== preview.referenceVersion)
    preview = await review.inspect('map-source')
    await review.assertReviewed('map-source', preview.referenceVersion)
  }
})

test('다른 문서의 무관한 본문 수정·열거 순서 변경은 확인을 무효화하지 않는다', async () => {
  const { documents, review } = fixture()
  const preview = await review.inspect('map-source')
  documents.get('map-active').version = 9
  documents.get('map-active').nodes[0].description = '참조 위치와 관계없는 변경'
  documents.get('map-active').nodes.reverse()
  await review.assertReviewed('map-source', preview.referenceVersion)
})

test('참조가 없으면 기존 이동 호출도 허용하되 문서가 사라지거나 확인되지 않으면 차단한다', async () => {
  const { documents, review } = fixture()
  documents.get('map-active').nodes = []
  documents.get('map-archive').nodes = []
  assert.equal((await review.assertReviewed('map-source')).references.length, 0)
  documents.set('map-unreadable', undefined)
  await assert.rejects(review.inspect('map-source'), { code: 'TRASH_REFERENCES_UNVERIFIED' })
  documents.delete('map-unreadable')
  documents.get('map-source').trashedAt = '2026-10-27'
  await assert.rejects(review.inspect('map-source'), { code: 'TRASH_TARGET_UNAVAILABLE' })
  documents.delete('map-source')
  await assert.rejects(review.inspect('map-source'), { status: 404, code: 'TRASH_TARGET_MISSING' })
})
