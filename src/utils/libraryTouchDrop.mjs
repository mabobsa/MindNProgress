// 휴대폰 문서 목록의 꾹 누른 뒤 끌기에서 손가락 아래 놓을 위치를 찾고, PC 드래그와 같은 이동 목적지로 바꾼다.
// 놓을 위치 요소는 data-library-drop-* 속성으로 자신이 받는 항목(accepts)과 목적지(action)를 밝힌다.

const dropSelector = '[data-library-drop-key]'

function dropTargetFromDataset(dataset) {
  return {
    key: dataset.libraryDropKey,
    action: dataset.libraryDropAction,
    targetType: dataset.libraryDropTargetType ?? null,
    targetId: dataset.libraryDropTargetId ?? null,
    groupId: dataset.libraryDropGroupId ?? null,
    mapId: dataset.libraryDropMapId ?? null,
  }
}

/**
 * element에서 가장 가까운 놓을 위치부터 바깥으로 올라가며, 끌고 있는 항목 종류(map·group)를 받는 첫 위치를 돌려준다.
 * 예: 그룹을 끌어 그룹 안 문서 위에 놓으면 문서는 그룹을 받지 않으므로 그 그룹 영역(그룹 앞 위치)이 된다. PC 드래그의 이벤트 버블링과 같다.
 */
export function libraryDropTargetFromElement(element, draggedType) {
  let candidate = element && typeof element.closest === 'function' ? element.closest(dropSelector) : null
  while (candidate) {
    const accepts = candidate.dataset.libraryDropAccepts
    if (accepts === 'any' || accepts === draggedType) return dropTargetFromDataset(candidate.dataset)
    candidate = candidate.parentElement ? candidate.parentElement.closest(dropSelector) : null
  }
  return null
}

/** 놓을 위치를 moveLibraryItem의 목적지로 바꾼다. 받을 수 없는 조합이면 null이다. */
export function libraryDropDestination(target, dragged, firstLayoutItem) {
  if (!target || !dragged) return null
  switch (target.action) {
    case 'top-start':
      return firstLayoutItem ? { type: 'top', target: firstLayoutItem } : { type: 'top' }
    case 'top-end':
      return { type: 'top' }
    case 'top-before':
      return target.targetType && target.targetId ? { type: 'top', target: { type: target.targetType, id: target.targetId } } : null
    case 'group-insert':
      return dragged.type === 'map' && target.groupId && target.mapId ? { type: 'group', groupId: target.groupId, targetMapId: target.mapId } : null
    case 'group-append':
      return dragged.type === 'map' && target.groupId ? { type: 'group', groupId: target.groupId } : null
    default:
      return null
  }
}
