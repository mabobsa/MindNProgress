import { useLayoutEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position } from '@xyflow/react'
import type { MindNodeData } from '../types/mindMap'
import { normalizedDoorayKnowledgeUrl } from '../utils/externalLinks'
import { beginResizeGesture, finishResizeGesture, updateResizeGesture, type ResizeGesture } from '../utils/resizeGesture'
import { NodeOverlapBadge } from './NodeOverlapBadge'
import './DoorayTaskNode.css'

export function DoorayTaskNode({ data, selected, isConnectable }: {
  data: MindNodeData
  selected: boolean
  isConnectable: boolean
}) {
  const externalLink = data.externalLink
  const sourceUrl = normalizedDoorayKnowledgeUrl(data.taskUrl ?? '')
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const titleBoxRef = useRef<HTMLDivElement | null>(null)
  const resizeGesture = useRef<ResizeGesture | null>(null)
  const [titleLines, setTitleLines] = useState(2)

  useLayoutEffect(() => {
    const title = titleRef.current
    const titleBox = titleBoxRef.current
    if (!title || !titleBox) return
    const updateTitleLines = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(title).lineHeight) || 18
      setTitleLines(Math.max(1, Math.floor(titleBox.clientHeight / lineHeight)))
    }
    updateTitleLines()
    const observer = new ResizeObserver(updateTitleLines)
    observer.observe(titleBox)
    return () => observer.disconnect()
  }, [])

  if (!sourceUrl || !externalLink) return null
  const isWiki = externalLink.provider === 'dooray-wiki'
  const closed = externalLink.provider === 'dooray-task' && (externalLink.closed || data.progress >= 100)
  const statusLabel = isWiki
    ? 'Wiki'
    : externalLink.workflowName || (closed ? '완료' : data.status === 'in-progress' ? '진행 중' : '할 일')
  const cardTitle = externalLink?.title?.trim() || data.label
  const knowledgeDescription = data.description?.trim() ?? ''
  const tooltip = [
    cardTitle,
    knowledgeDescription ? `설명: ${knowledgeDescription}` : '',
  ].filter(Boolean).join('\n')
  const waitingItems = (data.waitingItems ?? []).filter((item) => item.label.trim())
  const waitingTitle = waitingItems.map((item) => [
    item.label,
    item.note,
    item.resumeCondition ? `재개 조건: ${item.resumeCondition}` : '',
  ].filter(Boolean).join(' · ')).join('\n')

  return (
    <>
      <NodeOverlapBadge data={data} />
      <NodeResizer
        isVisible={selected && data.externalLinkEditable === true}
        minWidth={160}
        minHeight={96}
        maxWidth={1_200}
        maxHeight={800}
        lineClassName="dooray-task-resize-line"
        handleClassName="dooray-task-resize-handle"
        onResizeStart={(event, params) => {
          resizeGesture.current = beginResizeGesture(event, params)
          data.onExternalLinkResizeStart?.()
        }}
        onResize={(event, params) => data.onExternalLinkResize?.(updateResizeGesture(event, params, resizeGesture.current))}
        onResizeEnd={(event, params) => {
          data.onExternalLinkResizeEnd?.(finishResizeGesture(event, params, resizeGesture.current))
          resizeGesture.current = null
        }}
      />
      <article className={`mind-node dooray-task-node ${closed ? 'closed' : ''} ${selected ? 'selected' : ''}`} title={tooltip}>
        {waitingItems.length > 0 && (
          <button
            type="button"
            className="node-waiting nodrag nopan"
            title={`${waitingTitle}\n대기 항목 세부 정보 열기`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => data.onOpenWaitingItems?.()}
          >
            <span className="node-waiting-text">⏸️ {waitingItems.length === 1 ? `${waitingItems[0].label} 대기` : `대기 ${waitingItems.length}건`}</span>
          </button>
        )}
        {data.hasChildren && (
          <button
            type="button"
            className={`node-collapse-toggle nodrag nopan ${data.collapsed ? 'collapsed' : ''}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); data.onToggleCollapse?.() }}
            title={data.collapsed ? `숨긴 하위 노드 ${data.hiddenDescendantCount ?? 0}개 펼치기` : `하위 노드 ${data.hiddenDescendantCount ?? 0}개 접기`}
            aria-label={data.collapsed ? '하위 가지 펼치기' : '하위 가지 접기'}
            aria-expanded={!data.collapsed}
          >
            <span>{data.collapsed ? '+' : '−'}</span>
            {data.collapsed && <b>{data.hiddenDescendantCount}</b>}
          </button>
        )}
        <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
        {([
          ['top', Position.Top],
          ['right', Position.Right],
          ['bottom', Position.Bottom],
          ['left', Position.Left],
        ] as const).map(([side, position]) => (
          <Handle
            key={side}
            id={`knowledge-target-${side}`}
            className="knowledge-route-handle"
            type="target"
            position={position}
            isConnectable={false}
          />
        ))}
        {([
          ['top', Position.Top],
          ['right', Position.Right],
          ['bottom', Position.Bottom],
          ['left', Position.Left],
        ] as const).map(([side, position]) => (
          <Handle
            key={`knowledge-source-${side}`}
            id={`dooray-knowledge-source-${side}`}
            className="knowledge-route-handle"
            type="source"
            position={position}
            isConnectable={false}
          />
        ))}
        <header className="dooray-task-heading">
          <span className="dooray-task-provider">
            <i aria-hidden="true">D</i>
            {isWiki && (
              <span className="dooray-wiki-icon" title="Wiki" aria-label="Wiki">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.25 1.75h6.2l3.3 3.3v8.2a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
                  <path d="M9.25 1.9v3.35h3.35M4.75 8h5.5M4.75 10.5h5.5" />
                </svg>
              </span>
            )}
            {isWiki ? 'Dooray Wiki' : 'Dooray 업무'}
          </span>
          {Boolean(data.commentCount) && (
            <span className={`node-comments-badge ${data.unresolvedCommentCount ? 'unresolved' : ''}`} title={`댓글 ${data.commentCount}개 · 미해결 스레드 ${data.unresolvedCommentCount ?? 0}개`}>
              <span aria-hidden="true">💬</span>{data.commentCount}
            </span>
          )}
          <span className="dooray-task-status">{statusLabel}</span>
        </header>
        <div ref={titleBoxRef} className="dooray-task-title-box">
          <h3 ref={titleRef} style={{ WebkitLineClamp: titleLines }}>{cardTitle}</h3>
        </div>
        <footer className="dooray-task-footer">
          <span title={isWiki ? externalLink.pageId : externalLink.taskNumber}>
            {isWiki ? 'Wiki 페이지' : externalLink.taskNumber || 'Dooray 원본'}
          </span>
          <a
            className="node-source-open nodrag nopan"
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={isWiki ? 'Dooray Wiki 원본 열기' : 'Dooray 업무 원본 열기'}
            title={isWiki ? 'Dooray Wiki 원본 열기' : 'Dooray 업무 원본 열기'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            ↗
          </a>
        </footer>
        <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
      </article>
    </>
  )
}
