export type ChecklistItem = {
  id: string
  text: string
  done: boolean
}

export type TeamMember = {
  id: string
  name: string
  initials: string
  color: 'violet' | 'blue' | 'mint' | 'orange'
  active: boolean
}

export type MindNodeData = {
  label: string
  description: string
  progress: number
  status: 'planned' | 'in-progress' | 'done'
  kind: 'root' | 'branch' | 'task'
  taskUrl?: string
  aiConversationId?: string
  isWork?: boolean
  assigneeId?: string
  assignee?: TeamMember
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
