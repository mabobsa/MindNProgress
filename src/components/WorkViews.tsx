import { useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import type { Node } from '@xyflow/react'
import { teamMembers, type MindNodeData } from '../types/mindMap'
import { AssigneeTooltip } from './AssigneeTooltip'
import { blockingNodes } from '../utils/dependencies'
import './WorkViews.css'

type WorkNode = Node<MindNodeData, 'mind'>
type AccessMode = 'editor' | 'viewer'
type WorkStatus = MindNodeData['status']

type WorkViewProps = {
  nodes: WorkNode[]
  mode: AccessMode
  selectedId: string | null
  onSelect: (nodeId: string) => void
  onUpdate: (nodeId: string, patch: Partial<MindNodeData>) => void
  onOpenMindMap: () => void
  onContextMenu: (event: ReactMouseEvent, nodeId: string) => void
}

const columns: { id: WorkStatus; title: string; description: string }[] = [
  { id: 'planned', title: '예정', description: '아직 시작하지 않은 업무' },
  { id: 'in-progress', title: '진행 중', description: '현재 실행 중인 업무' },
  { id: 'done', title: '완료', description: '마무리된 업무' },
]

function effectiveStatus(node: WorkNode): WorkStatus {
  return node.data.progress >= 100 ? 'done' : node.data.status
}

function assigneeFor(node: WorkNode) {
  return teamMembers.find((member) => member.id === node.data.assigneeId)
}

function formatDate(date?: string) {
  if (!date) return '마감일 미정'
  const [year, month, day] = date.split('-').map(Number)
  return `${year}.${String(month).padStart(2, '0')}.${String(day).padStart(2, '0')}`
}

function isOverdue(node: WorkNode) {
  return Boolean(node.data.dueDate && effectiveStatus(node) !== 'done' && new Date(`${node.data.dueDate}T23:59:59`) < new Date())
}

function EmptyWorkView({ onOpenMindMap }: { onOpenMindMap: () => void }) {
  return (
    <div className="work-view-empty">
      <div className="work-empty-symbol">✓</div>
      <strong>업무 노드가 없습니다</strong>
      <span>마인드맵에서 노드를 선택한 뒤 업무 관리를 활성화해 주세요.</span>
      <button onClick={onOpenMindMap}>마인드맵으로 이동</button>
    </div>
  )
}

function WorkCard({ node, blockedCount, selected, draggable, onSelect, onContextMenu }: { node: WorkNode; blockedCount: number; selected: boolean; draggable: boolean; onSelect: () => void; onContextMenu: (event: ReactMouseEvent) => void }) {
  const assignee = assigneeFor(node)
  const checklist = node.data.checklist ?? []
  const completed = checklist.filter((item) => item.done).length

  return (
    <article
      className={`work-card ${selected ? 'selected' : ''}`}
      draggable={draggable}
      data-node-id={node.id}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      tabIndex={0}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect() }}
    >
      <div className="work-card-top">
        <span className="work-chip">업무</span>
        {blockedCount > 0 && <span className="blocked-chip">차단됨 {blockedCount}</span>}
        <strong>{node.data.progress}%</strong>
      </div>
      <h3>{node.data.label}</h3>
      <p>{node.data.description}</p>
      <div className="work-card-progress"><span style={{ width: `${node.data.progress}%` }} /></div>
      <div className="work-card-meta">
        {assignee ? <AssigneeTooltip name={assignee.name} className={`work-avatar ${assignee.color}`}>{assignee.initials}</AssigneeTooltip> : <span className="unassigned">미지정</span>}
        <span className={isOverdue(node) ? 'overdue' : ''}>{formatDate(node.data.dueDate)}</span>
        {Boolean(node.data.commentCount) && <span className={`card-comments ${node.data.unresolvedCommentCount ? 'unresolved' : ''}`} title={`댓글 ${node.data.commentCount}개 · 미해결 스레드 ${node.data.unresolvedCommentCount ?? 0}개`}>💬 {node.data.commentCount}</span>}
        {checklist.length > 0 && <span className="card-checks">✓ {completed}/{checklist.length}</span>}
      </div>
    </article>
  )
}

export function KanbanView(props: WorkViewProps) {
  const { nodes, mode, selectedId, onSelect, onUpdate, onOpenMindMap, onContextMenu } = props
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const workNodes = nodes.filter((node) => node.data.isWork)

  if (workNodes.length === 0) return <EmptyWorkView onOpenMindMap={onOpenMindMap} />

  const moveNode = (nodeId: string, status: WorkStatus) => {
    if (mode !== 'editor') return
    const node = workNodes.find((candidate) => candidate.id === nodeId)
    if (!node || effectiveStatus(node) === status) return
    const checklist = node.data.checklist ?? []
    let nextChecklist = checklist
    let progress = node.data.progress

    if (status === 'done') {
      progress = 100
      nextChecklist = checklist.map((item) => ({ ...item, done: true }))
    } else if (status === 'planned') {
      progress = 0
      nextChecklist = checklist.map((item) => ({ ...item, done: false }))
    } else if (progress <= 0 || progress >= 100) {
      if (checklist.length > 0) {
        nextChecklist = checklist.map((item, index) => ({ ...item, done: index === 0 }))
        progress = Math.round(100 / checklist.length)
      } else {
        progress = 10
      }
    }

    onUpdate(nodeId, { status, progress, checklist: nextChecklist })
  }

  return (
    <div className="kanban-view">
      <header className="work-view-header">
        <div><span>Board</span><h2>업무 칸반</h2><p>카드를 이동해 업무 상태를 변경하세요.</p></div>
        <strong>{workNodes.length}개 업무</strong>
      </header>
      <div className="kanban-columns">
        {columns.map((column) => {
          const columnNodes = workNodes.filter((node) => effectiveStatus(node) === column.id)
          return (
            <section
              className={`kanban-column ${column.id} ${draggingId ? 'drag-active' : ''}`}
              key={column.id}
              onDragOver={(event) => { if (mode === 'editor') event.preventDefault() }}
              onDrop={(event) => {
                event.preventDefault()
                const nodeId = event.dataTransfer.getData('text/mind-node') || draggingId
                if (nodeId) moveNode(nodeId, column.id)
                setDraggingId(null)
              }}
            >
              <div className="kanban-column-heading">
                <span className="status-pin" />
                <div><strong>{column.title}</strong><small>{column.description}</small></div>
                <b>{columnNodes.length}</b>
              </div>
              <div className="kanban-cards">
                {columnNodes.map((node) => (
                  <div
                    key={node.id}
                    onDragStart={(event) => {
                      if (mode !== 'editor') return
                      event.dataTransfer.setData('text/mind-node', node.id)
                      event.dataTransfer.effectAllowed = 'move'
                      setDraggingId(node.id)
                    }}
                    onDragEnd={() => setDraggingId(null)}
                  >
                    <WorkCard node={node} blockedCount={blockingNodes(node, nodes).length} selected={selectedId === node.id} draggable={mode === 'editor'} onSelect={() => onSelect(node.id)} onContextMenu={(event) => onContextMenu(event, node.id)} />
                  </div>
                ))}
                {columnNodes.length === 0 && <div className="empty-column">업무가 없습니다</div>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

export function TimelineView({ nodes, selectedId, onSelect, onOpenMindMap, onContextMenu }: WorkViewProps) {
  const workNodes = nodes.filter((node) => node.data.isWork)
  const sortedNodes = [...workNodes].sort((first, second) => (first.data.dueDate ?? '9999').localeCompare(second.data.dueDate ?? '9999'))

  if (workNodes.length === 0) return <EmptyWorkView onOpenMindMap={onOpenMindMap} />

  return (
    <div className="timeline-view">
      <header className="work-view-header">
        <div><span>Timeline</span><h2>업무 타임라인</h2><p>마감일 순서로 실행 계획을 확인합니다.</p></div>
        <strong>{workNodes.filter((node) => node.data.dueDate).length}개 일정</strong>
      </header>
      <div className="timeline-list">
        {sortedNodes.map((node) => {
          const assignee = assigneeFor(node)
          const status = effectiveStatus(node)
          const blockedCount = blockingNodes(node, nodes).length
          return (
            <button className={`timeline-item ${status} ${blockedCount > 0 ? 'blocked' : ''} ${selectedId === node.id ? 'selected' : ''}`} key={node.id} onClick={() => onSelect(node.id)} onContextMenu={(event) => onContextMenu(event, node.id)}>
              <div className={`timeline-date ${isOverdue(node) ? 'overdue' : ''}`}>
                <strong>{node.data.dueDate ? node.data.dueDate.slice(5).replace('-', '.') : '미정'}</strong>
                <span>{node.data.dueDate ? node.data.dueDate.slice(0, 4) : '마감일'}</span>
              </div>
              <span className="timeline-dot" />
              <div className="timeline-content">
                <div><span>{status === 'done' ? '완료' : status === 'in-progress' ? '진행 중' : '예정'}</span>{blockedCount > 0 && <span className="blocked-badge">차단됨 {blockedCount}</span>}<strong>{node.data.label}</strong></div>
                <p>{node.data.description}</p>
                <div className="timeline-progress"><span style={{ width: `${node.data.progress}%` }} /></div>
              </div>
              <div className="timeline-meta">
                {assignee ? <AssigneeTooltip name={assignee.name} className={`work-avatar ${assignee.color}`}>{assignee.initials}</AssigneeTooltip> : <span className="unassigned">미지정</span>}
                <strong>{node.data.progress}%</strong>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function DashboardView({ nodes, onSelect, onOpenMindMap, onContextMenu }: WorkViewProps) {
  const workNodes = nodes.filter((node) => node.data.isWork)
  const metrics = useMemo(() => {
    const completed = workNodes.filter((node) => effectiveStatus(node) === 'done').length
    const inProgress = workNodes.filter((node) => effectiveStatus(node) === 'in-progress').length
    const planned = workNodes.filter((node) => effectiveStatus(node) === 'planned').length
    const overdue = workNodes.filter(isOverdue).length
    const blocked = workNodes.filter((node) => blockingNodes(node, nodes).length > 0).length
    const average = workNodes.length ? Math.round(workNodes.reduce((sum, node) => sum + node.data.progress, 0) / workNodes.length) : 0
    return { completed, inProgress, planned, overdue, blocked, average }
  }, [nodes, workNodes])

  if (workNodes.length === 0) return <EmptyWorkView onOpenMindMap={onOpenMindMap} />

  const upcoming = [...workNodes]
    .filter((node) => effectiveStatus(node) !== 'done')
    .sort((first, second) => (first.data.dueDate ?? '9999').localeCompare(second.data.dueDate ?? '9999'))
    .slice(0, 5)

  return (
    <div className="dashboard-view">
      <header className="work-view-header">
        <div><span>Dashboard</span><h2>진행률 대시보드</h2><p>전체 업무 상태와 병목을 한눈에 확인합니다.</p></div>
        <strong>실시간 집계</strong>
      </header>
      <div className="metric-grid">
        <article><span>전체 업무</span><strong>{workNodes.length}</strong><small>현재 문서 기준</small></article>
        <article className="green"><span>완료</span><strong>{metrics.completed}</strong><small>{Math.round(metrics.completed / workNodes.length * 100)}% 완료</small></article>
        <article className="violet"><span>진행 중</span><strong>{metrics.inProgress}</strong><small>실행 중인 업무</small></article>
        <article className={metrics.overdue ? 'red' : ''}><span>기한 초과</span><strong>{metrics.overdue}</strong><small>확인이 필요합니다</small></article>
        <article className={metrics.blocked ? 'blocked-metric' : ''}><span>차단됨</span><strong>{metrics.blocked}</strong><small>선행 업무 대기</small></article>
      </div>
      <div className="dashboard-panels">
        <section className="progress-overview">
          <div className="panel-heading"><div><span>전체 진행률</span><strong>업무 완료 평균</strong></div></div>
          <div className="donut-wrap">
            <div className="progress-donut" style={{ '--donut-progress': `${metrics.average * 3.6}deg` } as CSSProperties}><span><strong>{metrics.average}%</strong><small>평균</small></span></div>
            <div className="status-legend">
              {columns.map((column) => {
                const count = column.id === 'done' ? metrics.completed : column.id === 'in-progress' ? metrics.inProgress : metrics.planned
                return <div key={column.id}><span className={`legend-dot ${column.id}`} /><span>{column.title}</span><strong>{count}</strong></div>
              })}
            </div>
          </div>
        </section>
        <section className="assignee-overview">
          <div className="panel-heading"><div><span>담당자</span><strong>업무 분배</strong></div></div>
          <div className="assignee-list">
            {teamMembers.map((member) => {
              const assigned = workNodes.filter((node) => node.data.assigneeId === member.id)
              if (assigned.length === 0) return null
              const done = assigned.filter((node) => effectiveStatus(node) === 'done').length
              return <div key={member.id}><AssigneeTooltip name={member.name} className={`work-avatar ${member.color}`}>{member.initials}</AssigneeTooltip><AssigneeTooltip name={member.name}><strong>{member.name}</strong><small>{assigned.length}개 업무</small></AssigneeTooltip><b>{done}/{assigned.length}</b></div>
            })}
            {workNodes.every((node) => !node.data.assigneeId) && <div className="no-assignee">지정된 담당자가 없습니다.</div>}
          </div>
        </section>
        <section className="upcoming-overview">
          <div className="panel-heading"><div><span>다가오는 일정</span><strong>우선 확인할 업무</strong></div></div>
          <div className="upcoming-list">
            {upcoming.map((node) => <button key={node.id} onClick={() => onSelect(node.id)} onContextMenu={(event) => onContextMenu(event, node.id)}><span className={isOverdue(node) ? 'overdue' : ''}>{node.data.dueDate?.slice(5).replace('-', '.') ?? '미정'}</span><strong>{node.data.label}</strong><small>{node.data.progress}%</small></button>)}
            {upcoming.length === 0 && <div className="all-complete">모든 업무가 완료되었습니다.</div>}
          </div>
        </section>
      </div>
    </div>
  )
}
