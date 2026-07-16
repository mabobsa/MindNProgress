import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { teamMembers, type MindNodeData } from '../types/mindMap'
import { AssigneeTooltip } from './AssigneeTooltip'
import './MindNode.css'

type MindNodeType = Node<MindNodeData, 'mind'>

const statusText: Record<MindNodeData['status'], string> = {
  planned: '예정',
  'in-progress': '진행 중',
  done: '완료',
}

export function MindNode({ data, selected, isConnectable }: NodeProps<MindNodeType>) {
  const isCompleted = data.progress >= 100
  const displayStatus = isCompleted ? 'done' : data.status
  const assignee = teamMembers.find((member) => member.id === data.assigneeId)
  const checklist = data.checklist ?? []
  const completedItems = checklist.filter((item) => item.done).length
  const isOverdue = Boolean(data.dueDate && !isCompleted && new Date(`${data.dueDate}T23:59:59`) < new Date())
  const formattedDueDate = data.dueDate
    ? data.dueDate.split('-').slice(1).map(Number).join('.')
    : ''

  return (
    <article className={`mind-node ${data.kind} ${isCompleted ? 'completed' : ''} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} isConnectable={isConnectable} />
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
        <span className={`node-status ${displayStatus}`} />
        <span>{statusText[displayStatus]}</span>
        {Boolean(data.commentCount) && (
          <span className={`node-comments-badge ${data.unresolvedCommentCount ? 'unresolved' : ''}`} title={`댓글 ${data.commentCount}개 · 미해결 스레드 ${data.unresolvedCommentCount ?? 0}개`}>
            <span aria-hidden="true">💬</span>{data.commentCount}
          </span>
        )}
        <strong>{data.progress}%</strong>
      </div>
      <h3>{data.label}</h3>
      <p>{data.description}</p>
      <div className="node-progress" aria-label={`진행률 ${data.progress}%`}>
        <span style={{ width: `${data.progress}%` }} />
      </div>
      {data.isWork && (
        <div className="node-work-meta">
          <span className="work-label">업무</span>
          {assignee && <AssigneeTooltip name={assignee.name} className={`node-assignee ${assignee.color}`}>{assignee.initials}</AssigneeTooltip>}
          {data.dueDate && <span className={`node-due ${isOverdue ? 'overdue' : ''}`}>~ {formattedDueDate}</span>}
          {Boolean(data.unresolvedDependencyCount) && <span className="node-blocked">차단 {data.unresolvedDependencyCount}</span>}
          {checklist.length > 0 && <span className="node-checklist">✓ {completedItems}/{checklist.length}</span>}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={isConnectable} />
    </article>
  )
}
