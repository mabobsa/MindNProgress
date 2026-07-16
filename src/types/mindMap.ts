export type ChecklistItem = {
  id: string
  text: string
  done: boolean
}

export const teamMembers = [
  { id: 'kim', name: '김용민', initials: '김', color: 'violet', userId: 'user-editor' },
  { id: 'viewer', name: '프로젝트 뷰어', initials: '프', color: 'blue', userId: 'user-viewer' },
  { id: 'lee', name: '이서연', initials: '이', color: 'mint', userId: null },
  { id: 'park', name: '박준호', initials: '박', color: 'orange', userId: null },
  { id: 'choi', name: '최하늘', initials: '최', color: 'blue', userId: null },
] as const

export type MindNodeData = {
  label: string
  description: string
  progress: number
  status: 'planned' | 'in-progress' | 'done'
  kind: 'root' | 'branch' | 'task'
  taskUrl?: string
  isWork?: boolean
  assigneeId?: string
  dueDate?: string
  checklist?: ChecklistItem[]
  blockedBy?: string[]
  unresolvedDependencyCount?: number
  commentCount?: number
  unresolvedCommentCount?: number
  hasChildren?: boolean
  collapsed?: boolean
  hiddenDescendantCount?: number
  onToggleCollapse?: () => void
}
