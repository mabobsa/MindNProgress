import type { ResizeSnapRequest } from '../utils/resizeGrid.mjs'

export type ChecklistItem = {
  id: string
  text: string
  done: boolean
}

export type WaitingItem = {
  id: string
  label: string
  note?: string
  resumeCondition?: string
  since: string
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

export type MindImageData = {
  assetId: string
  fileName: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  naturalWidth: number
  naturalHeight: number
  displayWidth: number
  displayHeight: number
}

export type MindDoorayTaskData = {
  provider: 'dooray-task'
  url: string
  hostname: string
  projectId: string
  postId: string
  title?: string
  taskNumber: string
  workflowName: string
  workflowClass: string
  closed: boolean
  resolvedAt: string
  displayWidth: number
  displayHeight: number
}

export type MindDoorayWikiData = {
  provider: 'dooray-wiki'
  url: string
  hostname: string
  wikiId: string
  pageId: string
  title?: string
  resolvedAt: string
  displayWidth: number
  displayHeight: number
}

export type MindDoorayLinkData = MindDoorayTaskData | MindDoorayWikiData

export type AiConversationRuntime = {
  conversationId: string
  state: 'running' | 'waiting-confirmation' | 'idle' | 'unknown'
  isProcessing: boolean
  pendingConfirmations: number
  turnId: string | null
  observedAt: string
  conversationCount?: number
  activeConversationIds?: string[]
}

export type AiConversationOptionSnapshot = { id: string; label: string }

export type AiConversationLink = {
  conversationId: string
  homeMachineId?: string
  agent?: AiConversationOptionSnapshot
  model?: AiConversationOptionSnapshot
  providerId?: string
  mode?: AiConversationOptionSnapshot
  thoughtLevel?: AiConversationOptionSnapshot
  skills: AiConversationOptionSnapshot[]
  mcpServers: AiConversationOptionSnapshot[]
  workspace?: string
  requestPreview?: string
  startedBy?: AiConversationOptionSnapshot
  startedAt?: string
  linkedAt?: string
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
  sharedKnowledgeReview?: {
    reviewedAt: string
    reviewedHash: string
    reviewedBy: {
      id: string
      name: string
    }
    reviewResult: 'cleaned' | 'accepted-long'
  }
  progress: number
  status: 'planned' | 'in-progress' | 'done'
  kind: 'root' | 'branch' | 'task' | 'image'
  image?: MindImageData
  externalLink?: MindDoorayLinkData
  imageAssetUrl?: string
  imageEditable?: boolean
  onImageResizeStart?: () => void
  onImageResize?: (resize: ResizeSnapRequest) => void
  onImageResizeEnd?: (resize: ResizeSnapRequest) => void
  onOpenImagePreview?: () => void
  externalLinkEditable?: boolean
  onExternalLinkResizeStart?: () => void
  onExternalLinkResize?: (resize: ResizeSnapRequest) => void
  onExternalLinkResizeEnd?: (resize: ResizeSnapRequest) => void
  taskUrl?: string
  aiConversationId?: string
  aiConversations?: AiConversationLink[]
  reference?: MindNodeReference
  referenceUnresolved?: boolean
  isWork?: boolean
  assigneeId?: string
  assignee?: TeamMember
  dueDate?: string
  checklist?: ChecklistItem[]
  blockedBy?: string[]
  waitingItems?: WaitingItem[]
  unresolvedDependencyCount?: number
  blockedByLabels?: string[]
  commentCount?: number
  unresolvedCommentCount?: number
  progressRollupTargetCount?: number
  hasChildren?: boolean
  collapsed?: boolean
  hiddenDescendantCount?: number
  aiConversationRuntime?: AiConversationRuntime
  onToggleCollapse?: () => void
  onOpenWaitingItems?: () => void
  onOpenDependencies?: () => void
}
