import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type DragEvent as ReactDragEvent } from 'react'

type MenuTarget = { kind: 'map' | 'group'; id: string; x: number; y: number }
type Press = MenuTarget & {
  pointerId: number
  timer: ReturnType<typeof setTimeout> | null
  opened: boolean
  dragging: boolean
  lastX: number
  lastY: number
}
// 꾹 누른 뒤 끌기: 메뉴가 열린 다음 손을 떼지 않고 움직이면 메뉴를 닫고 문서·그룹을 옮긴다.
export type LibraryTouchDrag = {
  enabled: boolean
  onStart: (target: { kind: MenuTarget['kind']; id: string }) => void
  onMove: (x: number, y: number) => void
  onEnd: (x: number, y: number) => void
  onCancel: () => void
}
const rowSelector = '[data-library-menu-id]'
const LONG_PRESS_MS = 500
const MOVE_SLOP_PX = 8

// 목록 스크롤과 짧은 탭을 그대로 두고, 정지한 터치만 문서/그룹 메뉴로 전환한다.
// 메뉴가 열린 뒤 이어서 끌면 스크롤 대신 위치 이동으로 처리한다. 마우스는 기존 HTML 드래그를 그대로 쓴다.
export function useLibraryTouchMenu(enabled: boolean, onOpen: (target: MenuTarget) => void, drag?: LibraryTouchDrag) {
  const press = useRef<Press | null>(null)
  const callback = useRef(onOpen); callback.current = onOpen
  const dragRef = useRef(drag); dragRef.current = drag
  const suppressClick = useRef<{ id: string; until: number } | null>(null)
  const suppressNativeUntil = useRef(0)
  const detachTouch = useRef<(() => void) | null>(null)

  const cancel = useCallback(() => {
    const gesture = press.current
    if (gesture?.timer != null) clearTimeout(gesture.timer)
    press.current = null
    detachTouch.current?.()
    detachTouch.current = null
    if (gesture?.dragging) dragRef.current?.onCancel()
  }, [])

  const finishDrag = useCallback((x: number, y: number) => {
    const gesture = press.current
    if (!gesture?.dragging) return false
    // 놓기를 처리하기 전에 제스처를 정리해 같은 놓기가 두 번 처리되지 않게 한다.
    gesture.dragging = false
    suppressClick.current = { id: gesture.id, until: Date.now() + 800 }
    cancel()
    dragRef.current?.onEnd(x, y)
    return true
  }, [cancel])

  const attachTouch = useCallback((gesture: Press) => {
    detachTouch.current?.()
    const onTouchMove = (event: TouchEvent) => {
      if (press.current !== gesture) return
      if (event.touches.length > 1) { cancel(); return }
      const handlers = dragRef.current
      if (!gesture.opened || !handlers?.enabled) return
      const point = event.touches[0]
      if (!point) return
      // 메뉴가 열린 뒤의 움직임은 목록 스크롤이 아니라 위치 이동이다.
      if (event.cancelable) event.preventDefault()
      if (!gesture.dragging) {
        if (Math.hypot(point.clientX - gesture.x, point.clientY - gesture.y) <= MOVE_SLOP_PX) return
        gesture.dragging = true
        handlers.onStart({ kind: gesture.kind, id: gesture.id })
      }
      gesture.lastX = point.clientX
      gesture.lastY = point.clientY
      handlers.onMove(point.clientX, point.clientY)
    }
    // 보통은 pointerup이 먼저 처리한다. pointer 이벤트가 끊긴 브라우저에서도 놓기와 정리가 되도록 touchend에서도 처리한다.
    const onTouchEnd = (event: TouchEvent) => {
      if (press.current !== gesture) return
      const point = event.changedTouches[0]
      if (finishDrag(point?.clientX ?? gesture.lastX, point?.clientY ?? gesture.lastY)) return
      if (gesture.opened) suppressClick.current = { id: gesture.id, until: Date.now() + 800 }
      cancel()
    }
    const onTouchCancel = () => { if (press.current === gesture) cancel() }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('touchcancel', onTouchCancel)
    detachTouch.current = () => {
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [cancel, finishDrag])

  useEffect(() => {
    if (!enabled) cancel()
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', cancel)
    return () => { cancel(); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', cancel) }
  }, [cancel, enabled])

  // 끄는 중에는 메뉴가 열린 채 이동을 기다리는 상태로 보고 스크롤·포인터 취소로 끊지 않는다. 종료는 touchend·touchcancel이 맡는다.
  const holdingForDrag = (gesture: Press | null) => Boolean(gesture?.opened && dragRef.current?.enabled)

  return {
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'touch') { cancel(); suppressNativeUntil.current = 0; return }
      if (!enabled) return
      cancel()
      if (!event.isPrimary || !(event.target instanceof Element)) return
      if (event.target.closest('input, textarea, select, a, [contenteditable="true"]')) return
      const row = event.target.closest<HTMLElement>(rowSelector)
      const id = row?.dataset.libraryMenuId; const kind = row?.dataset.libraryMenuKind
      if (!id || !['map', 'group'].includes(kind ?? '')) return
      const gesture: Press = { id, kind: kind as MenuTarget['kind'], pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        timer: null, opened: false, dragging: false, lastX: event.clientX, lastY: event.clientY }
      press.current = gesture
      attachTouch(gesture)
      suppressNativeUntil.current = Date.now() + 2500
      gesture.timer = setTimeout(() => {
        if (press.current !== gesture || !row?.isConnected) return
        gesture.timer = null; gesture.opened = true
        suppressClick.current = { id, until: Date.now() + 1000 }
        callback.current(gesture)
      }, LONG_PRESS_MS)
    },
    onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = press.current
      if (gesture?.pointerId !== event.pointerId || holdingForDrag(gesture)) return
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > MOVE_SLOP_PX) {
        // 길게 누르기 전에 움직였으면 목록 스크롤이다. 합성 클릭도 탐색으로 처리하지 않는다.
        suppressClick.current = { id: gesture.id, until: Date.now() + 800 }
        cancel()
      }
    },
    onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = press.current
      if (gesture?.pointerId !== event.pointerId) return
      if (finishDrag(event.clientX, event.clientY)) return
      if (gesture.opened) suppressClick.current = { id: gesture.id, until: Date.now() + 800 }
      cancel()
    },
    onPointerCancelCapture: () => { if (!holdingForDrag(press.current)) cancel() },
    onScrollCapture: () => { if (!holdingForDrag(press.current)) cancel() },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>(rowSelector) : null
      const blocked = suppressClick.current
      if (blocked && blocked.id === row?.dataset.libraryMenuId && Date.now() < blocked.until) {
        event.preventDefault(); event.stopPropagation()
      }
    },
    onContextMenuCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (Date.now() < suppressNativeUntil.current && event.target instanceof Element && event.target.closest(rowSelector)) {
        event.preventDefault(); event.stopPropagation()
      }
    },
    onDragStartCapture: (event: ReactDragEvent<HTMLElement>) => {
      // HTML drag는 마우스 전용이다. 터치는 위의 꾹 누른 뒤 끌기로만 옮긴다.
      if (Date.now() < suppressNativeUntil.current) { event.preventDefault(); event.stopPropagation() }
    },
  }
}
