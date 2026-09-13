import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type DragEvent as ReactDragEvent } from 'react'

type MenuTarget = { kind: 'map' | 'group'; id: string; x: number; y: number }
type Press = MenuTarget & { pointerId: number; timer: ReturnType<typeof setTimeout> | null; opened: boolean }
const rowSelector = '[data-library-menu-id]'

// 목록 스크롤과 짧은 탭을 그대로 두고, 정지한 터치만 문서/그룹 메뉴로 전환한다.
export function useLibraryTouchMenu(enabled: boolean, onOpen: (target: MenuTarget) => void) {
  const press = useRef<Press | null>(null)
  const callback = useRef(onOpen); callback.current = onOpen
  const suppressClick = useRef<{ id: string; until: number } | null>(null)
  const suppressNativeUntil = useRef(0)
  const cancel = useCallback(() => {
    if (press.current?.timer != null) clearTimeout(press.current.timer)
    press.current = null
  }, [])
  useEffect(() => {
    if (!enabled) cancel()
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', cancel)
    return () => { cancel(); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', cancel) }
  }, [cancel, enabled])
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
      const gesture: Press = { id, kind: kind as MenuTarget['kind'], pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: null, opened: false }
      press.current = gesture
      suppressNativeUntil.current = Date.now() + 2500
      gesture.timer = setTimeout(() => {
        if (press.current !== gesture || !row?.isConnected) return
        gesture.timer = null; gesture.opened = true
        suppressClick.current = { id, until: Date.now() + 1000 }
        callback.current(gesture)
      }, 500)
    },
    onPointerMoveCapture: (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = press.current
      if (gesture?.pointerId === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) {
        // 길게 누르기 전에 움직였으면 목록 스크롤이다. 합성 클릭도 탐색으로 처리하지 않는다.
        suppressClick.current = { id: gesture.id, until: Date.now() + 800 }
        cancel()
      }
    },
    onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => {
      const gesture = press.current
      if (gesture?.pointerId !== event.pointerId) return
      if (gesture.opened) suppressClick.current = { id: gesture.id, until: Date.now() + 800 }
      cancel()
    },
    onPointerCancelCapture: cancel,
    onScrollCapture: cancel,
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
      // HTML drag는 마우스 전용이다. 터치 길게 누르기가 문서 재배치로 새지 않게 한다.
      if (Date.now() < suppressNativeUntil.current) { event.preventDefault(); event.stopPropagation() }
    },
  }
}
