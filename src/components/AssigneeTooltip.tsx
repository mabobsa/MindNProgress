import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import './AssigneeTooltip.css'

type AssigneeTooltipProps = {
  name: string
  children: ReactNode
  className?: string
}

type TooltipPosition = { left: number; top: number; below: boolean }

export function AssigneeTooltip({ name, children, className = '' }: AssigneeTooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  const showTooltip = () => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const below = rect.top < 58
    setPosition({
      left: Math.max(70, Math.min(rect.left + rect.width / 2, window.innerWidth - 70)),
      top: below ? rect.bottom + 9 : rect.top - 9,
      below,
    })
  }

  return (
    <>
      <span
        ref={anchorRef}
        className={`assignee-tooltip-anchor ${className}`.trim()}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setPosition(null)}
        onFocus={showTooltip}
        onBlur={() => setPosition(null)}
        tabIndex={0}
        aria-label={`담당자 ${name}`}
      >
        {children}
      </span>
      {position && createPortal(
        <div
          className={`assignee-tooltip ${position.below ? 'below' : 'above'}`}
          style={{ left: position.left, top: position.top }}
          role="tooltip"
        >
          <span className="assignee-tooltip-icon"><span /></span>
          <span>담당자 <strong>{name}</strong></span>
          <i />
        </div>,
        document.body,
      )}
    </>
  )
}
