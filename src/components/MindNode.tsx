import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import type { MindNodeData } from '../types/mindMap'
import { AiConversationRuntimeBadge } from './AiConversationRuntimeBadge'
import { AssigneeTooltip } from './AssigneeTooltip'
import { DoorayTaskNode } from './DoorayTaskNode'
import { MindImageNode } from './MindImageNode'
import { NodeOverlapBadge } from './NodeOverlapBadge'
import { isSameDoorayKnowledgeUrl, normalizedDoorayKnowledgeUrl, taskUrlProvider } from '../utils/externalLinks'
import './MindNode.css'

type MindNodeType = Node<MindNodeData, 'mind'>

const statusText: Record<MindNodeData['status'], string> = {
  planned: '예정',
  'in-progress': '진행 중',
  done: '완료',
}

const statusIcon: Record<MindNodeData['status'], string> = {
  planned: '○',
  'in-progress': '▶',
  done: '✓',
}

export function MindNode({ data, selected, isConnectable }: NodeProps<MindNodeType>) {
  if (data.kind === 'image') return <MindImageNode data={data} selected={selected} />
  const doorayUrl = normalizedDoorayKnowledgeUrl(data.taskUrl ?? '')
  const isDoorayWiki = taskUrlProvider(doorayUrl ?? '') === 'dooray-wiki'
  if (doorayUrl && data.externalLink && isSameDoorayKnowledgeUrl(data.externalLink.url, doorayUrl)) {
    return <DoorayTaskNode data={data} selected={selected} isConnectable={isConnectable} />
  }

  const hasProgressRollup = data.progressRollupTargetCount !== undefined
  const progressRollupScope = data.kind === 'root' ? '전체' : '하위'
  const progressRollupDescription = `${progressRollupScope} 업무 ${data.progressRollupTargetCount ?? 0}개 진행률 평균 · 자동 계산`
  const progressRollupAriaLabel = `${progressRollupScope} 업무 ${data.progressRollupTargetCount ?? 0}개 진행률 평균 ${data.progress}% · 자동 계산`
  const showsProgress = Boolean(data.isWork || hasProgressRollup)
  const isCompleted = showsProgress && data.progress >= 100
  const displayStatus = isCompleted ? 'done' : data.status
  const assignee = data.assignee
  // Ref 표시를 제목 문자열에 두면 제목이 길 때 가장 먼저 잘리므로 별도 배지로 분리한다.
  const isReference = Boolean(data.reference)
  const referenceBroken = data.referenceUnresolved === true
  const displayLabel = isReference
    ? data.label.replace(/\s*\(ref\)\s*$/i, '').trim() || data.label
    : data.label
  const referenceBadge = isReference ? (
    <span
      className={`node-ref-badge ${referenceBroken ? 'unresolved' : ''}`}
      title={referenceBroken ? 'Ref 원본 카드를 찾을 수 없습니다' : '다른 문서의 카드를 참조하는 Ref 카드입니다'}
      aria-label={referenceBroken ? 'Ref 원본 연결 끊김' : 'Ref 카드'}
    >
      Ref
    </span>
  ) : null
  const checklist = data.checklist ?? []
  const completedItems = checklist.filter((item) => item.done).length
  const hasVisibleAiRuntime = data.aiConversationRuntime?.state === 'running'
    || data.aiConversationRuntime?.state === 'waiting-confirmation'
  const waitingItems = (data.waitingItems ?? []).filter((item) => item.label.trim())
  const waitingTitle = waitingItems.map((item) => [
    item.label,
    item.note,
    item.resumeCondition ? `재개 조건: ${item.resumeCondition}` : '',
  ].filter(Boolean).join(' · ')).join('\n')
  const blockedLabels = (data.blockedByLabels ?? []).filter((label) => label.trim())
  const blockedTitle = blockedLabels.length > 0
    ? `완료되지 않은 선행 업무\n${blockedLabels.map((label) => `· ${label}`).join('\n')}`
    : `완료되지 않은 선행 업무 ${data.unresolvedDependencyCount ?? 0}건`
  const isOverdue = Boolean(data.dueDate && !isCompleted && new Date(`${data.dueDate}T23:59:59`) < new Date())
  const formattedDueDate = data.dueDate
    ? data.dueDate.split('-').slice(1).map(Number).join('.')
    : ''

  return (
    <>
      <NodeOverlapBadge data={data} />
      <article className={`mind-node ${data.kind} status-${displayStatus} ${isCompleted ? 'completed' : ''} ${selected ? 'selected' : ''}`}>
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
      <div className="node-topline">
        <span className={`node-status-badge ${displayStatus}`}>
          <span className="node-status-icon" aria-hidden="true">{statusIcon[displayStatus]}</span>
          <span>{statusText[displayStatus]}</span>
        </span>
        {Boolean(data.commentCount) && (
          <span className={`node-comments-badge ${data.unresolvedCommentCount ? 'unresolved' : ''}`} title={`댓글 ${data.commentCount}개 · 미해결 스레드 ${data.unresolvedCommentCount ?? 0}개`}>
            <span aria-hidden="true">💬</span>{data.commentCount}
          </span>
        )}
        {showsProgress && (
          <strong title={hasProgressRollup ? progressRollupDescription : undefined}>
            {hasProgressRollup ? `${progressRollupScope} ${data.progress}%` : `${data.progress}%`}
          </strong>
        )}
      </div>
      {doorayUrl ? (
        <div className="node-title-row dooray-linked-title">
          <span className="dooray-linked-icon" title={isDoorayWiki ? 'Dooray Wiki' : 'Dooray 업무'} aria-label={isDoorayWiki ? 'Dooray Wiki' : 'Dooray 업무'}>D</span>
          {isDoorayWiki && (
            <span className="dooray-wiki-icon" title="Wiki" aria-label="Wiki">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3.25 1.75h6.2l3.3 3.3v8.2a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
                <path d="M9.25 1.9v3.35h3.35M4.75 8h5.5M4.75 10.5h5.5" />
              </svg>
            </span>
          )}
          {referenceBadge}
          <h3>{displayLabel}</h3>
          <a
            className="dooray-linked-open node-source-open nodrag nopan"
            href={doorayUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={isDoorayWiki ? 'Dooray Wiki 원본 열기' : 'Dooray 업무 원본 열기'}
            title={isDoorayWiki ? 'Dooray Wiki 원본 열기' : 'Dooray 업무 원본 열기'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            ↗
          </a>
        </div>
      ) : isReference ? (
        <div className="node-title-row">
          {referenceBadge}
          <h3>{displayLabel}</h3>
        </div>
      ) : <h3>{data.label}</h3>}
      <p>{data.description}</p>
      {showsProgress && (
        <div className="node-progress" aria-label={hasProgressRollup ? progressRollupAriaLabel : `진행률 ${data.progress}%`}>
          <span style={{ width: `${data.progress}%` }} />
        </div>
      )}
      {(data.isWork || hasVisibleAiRuntime) && (
        <div className="node-work-meta">
          {data.isWork && <span className="work-label">업무</span>}
          {data.isWork && assignee && <AssigneeTooltip name={assignee.name} className={`node-assignee ${assignee.color}`}>{assignee.initials}</AssigneeTooltip>}
          <AiConversationRuntimeBadge runtime={data.aiConversationRuntime} />
          {data.isWork && data.dueDate && <span className={`node-due ${isOverdue ? 'overdue' : ''}`}>~ {formattedDueDate}</span>}
          {data.isWork && Boolean(data.unresolvedDependencyCount) && (
            <button
              type="button"
              className="node-blocked nodrag nopan"
              title={`${blockedTitle}\n차단 세부 정보 열기`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => data.onOpenDependencies?.()}
            >
              차단 {data.unresolvedDependencyCount}
            </button>
          )}
          {data.isWork && checklist.length > 0 && <span className="node-checklist">✓ {completedItems}/{checklist.length}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
      </article>
    </>
  )
}
