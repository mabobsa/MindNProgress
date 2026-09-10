// 단위/API 시험에서 렌더러를 대신하는 명시적인 사각형 fixture. 실제 UI는 DOM을 측정한다.
export function reconstructionLayoutFixture(preview) {
  return preview.targets.map((target) => ({ key: target.key, cards: target.layout.boxes.map((box) => ({
    cardId: box.cardId, ...target.map.nodes.find((node) => node.id === box.cardId).position,
    width: box.body.width, height: box.body.height, outsets: box.body.outsets,
  })) }))
}

export async function verifyLayoutFixture(manager, plan) {
  const preview = await manager.preview(plan)
  const measured = await manager.inspectRenderedLayout(plan, preview.previewHash, reconstructionLayoutFixture(preview), false, { id: 'layout-test' })
  return manager.inspectRenderedLayout(plan, measured.previewHash, reconstructionLayoutFixture(measured), true, { id: 'layout-test' })
}
