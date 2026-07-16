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

export type KnowledgePolicy = 'reuse-first' | 'inspect-if-insufficient'

export type MindMapEdgeData = {
  relation?: 'hierarchy' | 'knowledge'
  knowledgePolicy?: KnowledgePolicy
  parallelOffset?: number
}

export type MindNodeReference = {
  mapId: string
  nodeId: string
}

export type MindNodeData = {
  label: string
  description: string
  sharedKnowledge?: string
  sharedKnowledgeUpdatedAt?: string
  sharedKnowledgeUpdatedBy?: {
    id: string
    name: string
  }
  progress: number
  status: 'planned' | 'in-progress' | 'done'
  kind: 'root' | 'branch' | 'task'
  taskUrl?: string
  aiConversationId?: string
  reference?: MindNodeReference
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
