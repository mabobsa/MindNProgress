import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type FormEvent as ReactFormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from 'react'
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './App.css'
import { MindNode } from './components/MindNode'
import { KnowledgeEdge } from './components/KnowledgeEdge'
import { LinkifiedText } from './components/LinkifiedText'
import { MentionText } from './components/MentionText'
import { AdminEditorPanel } from './components/AdminEditorPanel'
import { AiConversationDialog } from './components/AiConversationDialog'
import { DashboardView, KanbanView, TimelineView } from './components/WorkViews'
import type { ChecklistItem, KnowledgePolicy, MindMapEdgeData, MindNodeData, TeamMember, WaitingItem } from './types/mindMap'
import { blockingNodes, createsDependencyCycle, dependentNodes, prerequisiteNodes } from './utils/dependencies'
import { createsKnowledgeCycle, isHierarchyEdge, isKnowledgeEdge, knowledgePolicyOf } from './utils/knowledgeEdges'
import { extractTextLinks } from './utils/textLinks'

const DOCUMENT_COLORS = [
  { id: 'violet', label: '보라', solid: '#6758d8', halo: '#dedafd' },
  { id: 'indigo', label: '남색', solid: '#4f68cc', halo: '#dfe4fa' },
  { id: 'blue', label: '파랑', solid: '#3e8bd8', halo: '#dcecfb' },
  { id: 'cyan', label: '하늘', solid: '#2aa9bf', halo: '#d8f3f7' },
  { id: 'teal', label: '청록', solid: '#45b8a2', halo: '#d8f3ed' },
  { id: 'green', label: '초록', solid: '#55a868', halo: '#def1e2' },
  { id: 'amber', label: '노랑', solid: '#d6a62f', halo: '#f8eccb' },
  { id: 'orange', label: '주황', solid: '#e79a47', halo: '#faead5' },
  { id: 'red', label: '빨강', solid: '#d86161', halo: '#f8dddd' },
  { id: 'pink', label: '분홍', solid: '#cc62a0', halo: '#f6deeb' },
] as const

const MINDMAP_GRID_SIZE = 24

function snapMindMapPosition(position: { x: number; y: number }) {
  return {
    x: Math.round(position.x / MINDMAP_GRID_SIZE) * MINDMAP_GRID_SIZE,
    y: Math.round(position.y / MINDMAP_GRID_SIZE) * MINDMAP_GRID_SIZE,
  }
}

function isTextTruncated(element: HTMLElement) {
  if (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight) return true
  const range = document.createRange()
  range.selectNodeContents(element)
  const textWidth = range.getBoundingClientRect().width
  const elementWidth = element.getBoundingClientRect().width
  return textWidth > elementWidth + 0.1
}

function rootStateOf(nodes: MindMapNode[], edges: MindMapEdge[]) {
  const hierarchyTargets = new Set(edges.filter(isHierarchyEdge).map((edge) => edge.target))
  const root = nodes.find((node) => node.data.kind === 'root' && !hierarchyTargets.has(node.id))
    ?? nodes.find((node) => node.data.kind === 'root')
    ?? nodes.find((node) => !hierarchyTargets.has(node.id))
    ?? nodes[0]
  const progress = Number(root?.data.progress)
  return {
    progress: Number.isFinite(progress) ? Math.round(Math.max(0, Math.min(100, progress))) : null,
    status: root?.data.status ?? null,
  }
}

function synchronizeNodeSelection(nodes: MindMapNode[], selectedId: string | null) {
  return nodes.map((node) => {
    const selected = node.id === selectedId
    return Boolean(node.selected) === selected ? node : { ...node, selected }
  })
}

const CLIENT_ID_KEY = 'mindnprogress-client-id'
const LAST_LOGIN_EMAIL_KEY = 'mindnprogress-last-login-email'

function createClientId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()

  const randomValues = new Uint32Array(4)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(randomValues)
  } else {
    for (let index = 0; index < randomValues.length; index += 1) {
      randomValues[index] = Math.floor(Math.random() * 0x1_0000_0000)
    }
  }
  const suffix = [...randomValues].map((value) => value.toString(36)).join('-')
  return `client-${Date.now().toString(36)}-${suffix}`
}

const CLIENT_ID = sessionStorage.getItem(CLIENT_ID_KEY) ?? createClientId()
const COMMENT_REACTIONS = ['👍', '❤️', '🎉', '👀'] as const
sessionStorage.setItem(CLIENT_ID_KEY, CLIENT_ID)

type DocumentColorId = typeof DOCUMENT_COLORS[number]['id']

function getDocumentColor(color: DocumentColorId | undefined, fallbackIndex = 0) {
  return DOCUMENT_COLORS.find((candidate) => candidate.id === color) ?? DOCUMENT_COLORS[fallbackIndex % DOCUMENT_COLORS.length]
}

function documentColorStyle(color: DocumentColorId | undefined, fallbackIndex = 0) {
  const selected = getDocumentColor(color, fallbackIndex)
  return { '--map-color': selected.solid, '--map-halo': selected.halo } as CSSProperties
}

function presenceColor(clientId: string) {
  const index = [...clientId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % DOCUMENT_COLORS.length
  return DOCUMENT_COLORS[index].solid
}

function revisionReasonLabel(reason: string) {
  return ({
    content: '내용 편집',
    rename: '이름 변경',
    color: '색상 변경',
    metadata: '문서 정보 변경',
    'history-restore': '이전 버전 복원',
  } as Record<string, string>)[reason] ?? '문서 변경'
}

function valuesEqual(first: unknown, second: unknown) {
  return JSON.stringify(first) === JSON.stringify(second)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isIdentifiedArray(value: unknown[]): value is Array<{ id: string } & Record<string, unknown>> {
  return value.every((item) => isPlainObject(item) && typeof item.id === 'string')
}

function mergeChangedValue(base: unknown, local: unknown, remote: unknown): { value: unknown; conflicts: number } {
  if (valuesEqual(local, remote)) return { value: structuredClone(local), conflicts: 0 }
  if (valuesEqual(local, base)) return { value: structuredClone(remote), conflicts: 0 }
  if (valuesEqual(remote, base)) return { value: structuredClone(local), conflicts: 0 }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)
    && isIdentifiedArray(base) && isIdentifiedArray(local) && isIdentifiedArray(remote)) {
    const baseById = new Map(base.map((item) => [item.id, item]))
    const localById = new Map(local.map((item) => [item.id, item]))
    const remoteById = new Map(remote.map((item) => [item.id, item]))
    const ids = [...new Set([...local.map((item) => item.id), ...remote.map((item) => item.id), ...base.map((item) => item.id)])]
    let conflicts = 0
    const value = ids.flatMap((id) => {
      const merged = mergeChangedValue(baseById.get(id), localById.get(id), remoteById.get(id))
      conflicts += merged.conflicts
      return merged.value === undefined ? [] : [merged.value]
    })
    return { value, conflicts }
  }

  if (isPlainObject(base) && isPlainObject(local) && isPlainObject(remote)) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])]
    let conflicts = 0
    const value: Record<string, unknown> = {}
    for (const key of keys) {
      const merged = mergeChangedValue(base[key], local[key], remote[key])
      conflicts += merged.conflicts
      if (merged.value !== undefined) value[key] = merged.value
    }
    return { value, conflicts }
  }

  if (local === undefined && remote !== undefined) return { value: structuredClone(remote), conflicts: 1 }
  return { value: structuredClone(local), conflicts: 1 }
}

function mergeMapContent(base: MapDocument, local: Pick<MapDocument, 'nodes' | 'edges'>, remote: MapDocument) {
  const nodes = mergeChangedValue(base.nodes, local.nodes, remote.nodes)
  const edges = mergeChangedValue(base.edges, local.edges, remote.edges)
  return {
    nodes: nodes.value as MindMapNode[],
    edges: edges.value as MindMapEdge[],
    conflicts: nodes.conflicts + edges.conflicts,
  }
}

type MindMapNode = Node<MindNodeData, 'mind'>
type MindMapEdge = Edge<MindMapEdgeData>
type AccessMode = 'editor' | 'viewer'
type UserRole = 'admin' | AccessMode
type ViewMode = 'mindmap' | 'kanban' | 'timeline' | 'dashboard'
type NodeFilter = 'all' | 'work' | 'planned' | 'in-progress' | 'done' | 'blocked'
type NodePasteMode = 'copy' | 'clone' | 'reference'

type CopiedNodeItem = {
  sourceNodeId: string
  position: { x: number; y: number }
  data: MindNodeData
}

type CopiedNodes = {
  sourceMapId: string
  nodes: CopiedNodeItem[]
  edges: MindMapEdge[]
}

type ReferenceCommentTarget = {
  localNodeId: string
  mapId: string
  nodeId: string
}

type WorkspaceDeepLink = {
  viewMode: ViewMode
  mapId: string | null
  nodeId: string | null
}

const VIEW_MODE_PATHS: Record<string, ViewMode> = {
  mindmap: 'mindmap',
  kanban: 'kanban',
  timeline: 'timeline',
  dashboard: 'dashboard',
  '마인드맵': 'mindmap',
  '칸반': 'kanban',
  '타임라인': 'timeline',
  '대시보드': 'dashboard',
}

function decodePathSegment(segment: string | undefined) {
  if (!segment) return null
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function parseWorkspaceDeepLink(pathname: string): WorkspaceDeepLink | null {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/')
  const viewerEntry = decodePathSegment(segments[0])?.toLowerCase() === 'viewer'
  const viewIndex = viewerEntry ? 1 : 0
  const tab = decodePathSegment(segments[viewIndex]) ?? (viewerEntry ? 'mindmap' : null)
  const viewMode = tab ? VIEW_MODE_PATHS[tab.toLowerCase()] : undefined
  if (!viewMode) return null
  return {
    viewMode,
    mapId: decodePathSegment(segments[viewIndex + 1]),
    nodeId: decodePathSegment(segments[viewIndex + 2]),
  }
}

function canSelectNodeInView(node: MindMapNode, viewMode: ViewMode) {
  return viewMode === 'mindmap' || Boolean(node.data.isWork)
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 권한이 제한된 브라우저에서는 선택 영역 복사 방식으로 다시 시도합니다.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    textarea.remove()
  }
  if (!copied) throw new Error('클립보드 복사를 지원하지 않는 브라우저입니다.')
}

type AuthUser = {
  id: string
  name: string
  email: string
  role: UserRole
  publicAccess?: boolean
  active?: boolean
}

type MapSummary = {
  id: string
  title: string
  color: DocumentColorId
  nodeCount: number
  rootProgress: number | null
  rootStatus: MindNodeData['status'] | null
  waitingCount: number
  version: number
  updatedAt: string | null
  updatedBy: AuthUser | null
  createdAt: string | null
  createdBy: AuthUser | null
  trashedAt?: string | null
  trashedBy?: AuthUser | null
}

type DocumentGroup = {
  id: string
  name: string
  mapIds: string[]
}

type DocumentLayoutItem = {
  type: 'map' | 'group'
  id: string
}

type DocumentLayout = {
  version: 1
  items: DocumentLayoutItem[]
  groups: DocumentGroup[]
}

type DocumentLibraryResponse = {
  maps: MapSummary[]
  documentLayout: DocumentLayout
}

const EMPTY_DOCUMENT_LAYOUT: DocumentLayout = { version: 1, items: [], groups: [] }

type MapDocument = {
  id: string
  title: string
  color: DocumentColorId
  version: number
  nodes: MindMapNode[]
  edges: MindMapEdge[]
  updatedAt: string | null
  updatedBy: AuthUser | null
  createdAt: string | null
  createdBy: AuthUser | null
}

type MapRevisionSummary = {
  id: string
  mapId: string
  title: string
  color: DocumentColorId
  nodeCount: number
  archivedAt: string
  archivedBy: AuthUser
  reason: 'content' | 'rename' | 'color' | 'metadata' | 'history-restore' | string
  mapUpdatedAt: string | null
  mapUpdatedBy: AuthUser | null
}

type MapRevisionPage = {
  revisions: MapRevisionSummary[]
  hasMore: boolean
  nextOffset: number | null
}

type DailyBackupSummary = {
  date: string
  mapId: string
  title: string
  color: DocumentColorId
  nodeCount: number
  backedUpAt: string
  backedUpBy: AuthUser
  reason: 'automatic' | 'scheduled' | 'history-backfill' | 'before-history-restore' | 'before-daily-restore' | string
  mapUpdatedAt: string | null
  mapUpdatedBy: AuthUser | null
}

type MapChangeEvent = {
  type: 'map-changed'
  mapId: string | null
  action: string
  sourceClientId: string | null
  updatedAt: string
  updatedBy: AuthUser
}

type PresenceClient = { clientId: string; user: AuthUser }
type PresenceEvent = { type: 'presence'; mapId: string; clients: PresenceClient[] }
type CursorEvent = {
  type: 'cursor'
  mapId: string
  x: number
  y: number
  sourceClientId: string | null
  user: AuthUser
  updatedAt: string
}
type LiveCursor = CursorEvent & { receivedAt: number }
type NodeComment = {
  id: string
  mapId: string
  nodeId: string
  text: string
  parentId: string | null
  resolvedAt: string | null
  resolvedBy: AuthUser | null
  reactions: Partial<Record<CommentReaction, string[]>>
  createdAt: string
  author: AuthUser
}
type CommentReaction = typeof COMMENT_REACTIONS[number]
type NodeCommentStats = Record<string, { total: number; unresolved: number }>
type UserNotification = {
  id: string
  userId: string
  type: 'comment' | 'mention' | 'reply' | 'assignment' | 'schedule'
  mapId: string
  mapTitle: string
  nodeId: string
  nodeLabel: string
  commentId?: string
  message: string
  actor: AuthUser
  createdAt: string
  readAt: string | null
}
type CommentChangeEvent = {
  type: 'comment-changed'
  mapId: string
  nodeId: string
  action: 'created' | 'updated' | 'deleted'
  comment?: NodeComment
  commentIds?: string[]
}
type AiConversationLinkedEvent = {
  type: 'ai-conversation-linked'
  mapId: string
  nodeId: string
  conversationId: string
  sourceClientId: null
  updatedAt: string
  updatedBy: AuthUser
}
type NotificationEvent = { type: 'notification'; notification: UserNotification }
type NotificationsReadEvent = { type: 'notifications-read'; userId: string; notificationId: string | null; readAt: string }
type NotificationsRemovedEvent = { type: 'notifications-removed'; userId: string; notificationIds: string[] }

function buildCommentStats(comments: NodeComment[]): NodeCommentStats {
  return comments.reduce<NodeCommentStats>((stats, comment) => {
    const current = stats[comment.nodeId] ?? { total: 0, unresolved: 0 }
    stats[comment.nodeId] = {
      total: current.total + 1,
      unresolved: current.unresolved + (!comment.parentId && !comment.resolvedAt ? 1 : 0),
    }
    return stats
  }, {})
}

class ApiRequestError<T = unknown> extends Error {
  status: number
  body: T

  constructor(message: string, status: number, body: T) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.body = body
  }
}

type DragSnapshot = {
  rootId: string
  rootPosition: { x: number; y: number }
  descendantPositions: Map<string, { x: number; y: number }>
  selectedPositions: Map<string, { x: number; y: number }>
}

type RightPanGesture = {
  startX: number
  startY: number
  viewport: { x: number; y: number; zoom: number }
  moved: boolean
  contextMenuSuppressed: boolean
}

type HistorySnapshot = {
  nodes: MindMapNode[]
  edges: MindMapEdge[]
  signature: string
}

function createHistorySnapshot(nodes: MindMapNode[], edges: MindMapEdge[]): HistorySnapshot {
  const historyNodes = structuredClone(nodes).map((node) => {
    delete node.selected
    delete node.dragging
    delete node.measured
    return node
  })
  const historyEdges = structuredClone(edges).map((edge) => {
    delete edge.selected
    return edge
  })
  return {
    nodes: historyNodes,
    edges: historyEdges,
    signature: JSON.stringify({ nodes: historyNodes, edges: historyEdges }),
  }
}

function useMapHistory(
  nodes: MindMapNode[],
  setNodes: Dispatch<SetStateAction<MindMapNode[]>>,
  edges: MindMapEdge[],
  setEdges: Dispatch<SetStateAction<MindMapEdge[]>>,
) {
  const undoStack = useRef<HistorySnapshot[]>([])
  const redoStack = useRef<HistorySnapshot[]>([])
  const baseline = useRef<HistorySnapshot | null>(null)
  const pending = useRef<HistorySnapshot | null>(null)
  const commitTimer = useRef<number | null>(null)
  const transactionActive = useRef(false)
  const [availability, setAvailability] = useState({ canUndo: false, canRedo: false })

  const refreshAvailability = useCallback(() => {
    setAvailability({
      canUndo: Boolean(pending.current) || undoStack.current.length > 0,
      canRedo: redoStack.current.length > 0,
    })
  }, [])

  const clearCommitTimer = useCallback(() => {
    if (commitTimer.current !== null) {
      window.clearTimeout(commitTimer.current)
      commitTimer.current = null
    }
  }, [])

  const commitPending = useCallback(() => {
    clearCommitTimer()
    const next = pending.current
    if (!next || !baseline.current || next.signature === baseline.current.signature) {
      pending.current = null
      refreshAvailability()
      return
    }
    undoStack.current.push(baseline.current)
    if (undoStack.current.length > 100) undoStack.current.shift()
    baseline.current = next
    pending.current = null
    redoStack.current = []
    refreshAvailability()
  }, [clearCommitTimer, refreshAvailability])

  useEffect(() => {
    const current = createHistorySnapshot(nodes, edges)
    if (!baseline.current) {
      baseline.current = current
      refreshAvailability()
      return
    }
    if (current.signature === baseline.current.signature) return

    pending.current = current
    redoStack.current = []
    clearCommitTimer()
    if (!transactionActive.current) commitTimer.current = window.setTimeout(commitPending, 350)
    refreshAvailability()
  }, [clearCommitTimer, commitPending, edges, nodes, refreshAvailability])

  useEffect(() => () => clearCommitTimer(), [clearCommitTimer])

  const applySnapshot = useCallback((snapshot: HistorySnapshot) => {
    baseline.current = snapshot
    setNodes(structuredClone(snapshot.nodes))
    setEdges(structuredClone(snapshot.edges))
  }, [setEdges, setNodes])

  const undo = useCallback(() => {
    clearCommitTimer()
    if (!baseline.current) return

    if (pending.current) {
      const current = pending.current
      pending.current = null
      redoStack.current.push(current)
      applySnapshot(baseline.current)
      refreshAvailability()
      return
    }

    const previous = undoStack.current.pop()
    if (!previous) return
    redoStack.current.push(baseline.current)
    applySnapshot(previous)
    refreshAvailability()
  }, [applySnapshot, clearCommitTimer, refreshAvailability])

  const redo = useCallback(() => {
    clearCommitTimer()
    if (!baseline.current || pending.current) return
    const next = redoStack.current.pop()
    if (!next) return
    undoStack.current.push(baseline.current)
    applySnapshot(next)
    refreshAvailability()
  }, [applySnapshot, clearCommitTimer, refreshAvailability])

  const resetHistory = useCallback((nextNodes: MindMapNode[], nextEdges: MindMapEdge[]) => {
    clearCommitTimer()
    undoStack.current = []
    redoStack.current = []
    pending.current = null
    baseline.current = createHistorySnapshot(nextNodes, nextEdges)
    transactionActive.current = false
    refreshAvailability()
  }, [clearCommitTimer, refreshAvailability])

  const beginTransaction = useCallback(() => {
    commitPending()
    transactionActive.current = true
    clearCommitTimer()
  }, [clearCommitTimer, commitPending])

  const endTransaction = useCallback(() => {
    transactionActive.current = false
    clearCommitTimer()
    if (pending.current) commitTimer.current = window.setTimeout(commitPending, 350)
  }, [clearCommitTimer, commitPending])

  return { ...availability, undo, redo, resetHistory, beginTransaction, endTransaction }
}

const MAP_CACHE_KEY = 'mindnprogress-map-cache-v1'
const ASSIGNEE_COLORS: TeamMember['color'][] = ['violet', 'blue', 'mint', 'orange']

function assigneeInitials(name: string) {
  const compact = name.replace(/\s/g, '')
  return [...compact].slice(0, 2).join('') || '?'
}

function assigneeColor(userId: string) {
  const index = [...userId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % ASSIGNEE_COLORS.length
  return ASSIGNEE_COLORS[index]
}

function formatDocumentDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('ko-KR') : '기록 없음'
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    map: <><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="m7 7.2 2.8 2.7M14.2 10l3.1-3.2M14.5 13.5l2.8 3.5"/></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    fit: <><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></>,
    restore: <><path d="M3 7v5h5"/><path d="M5.1 17a8 8 0 1 0 .3-10.3L3 9"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    'chevron-down': <path d="m6 9 6 6 6-6"/>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    share: <><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.7 10.7 6.6-4.4M8.7 13.3l6.6 4.4"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></>,
    edit: <><path d="m4 20 4.2-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5.2 16Z"/><path d="m14.5 6.5 3 3"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    board: <><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/></>,
    timeline: <><path d="M5 4v16M5 7h7M5 12h12M5 17h9"/><circle cx="5" cy="7" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="5" cy="17" r="1.5"/></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    paste: <><path d="M9 5h6M9 3h6v4H9z"/><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7"/><path d="M15 11v8M11 15h8"/></>,
    undo: <><path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></>,
    redo: <><path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></>,
    sparkles: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z"/><path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z"/></>,
    history: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M3 4v5h5"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    comment: <><path d="M21 14a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"/><path d="M8 9h8M8 13h5"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    collapse: <><path d="m3 8 4 4-4 4M7 12H1M21 8l-4 4 4 4M17 12h6"/></>,
    expand: <><path d="m7 8-4 4 4 4M3 12h6M17 8l4 4-4 4M21 12h-6"/></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3"/><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/></>,
  }

  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function CommentCard({ comment, isReply, mode, user, collaborators, readOnly = false, onReply, onDelete, onResolve, onReaction }: {
  comment: NodeComment
  isReply?: boolean
  mode: AccessMode
  user: AuthUser
  collaborators: AuthUser[]
  readOnly?: boolean
  onReply: (comment: NodeComment) => void
  onDelete: (comment: NodeComment) => void
  onResolve: (comment: NodeComment) => void
  onReaction: (comment: NodeComment, emoji: CommentReaction) => void
}) {
  const canResolve = !readOnly && !isReply && (mode === 'editor' || comment.author.id === user.id)
  const canDelete = !readOnly && (mode === 'editor' || comment.author.id === user.id)
  const mentionNames = collaborators.map((collaborator) => collaborator.name)

  return (
    <article className={`comment-item ${isReply ? 'reply' : ''} ${comment.resolvedAt ? 'resolved' : ''}`}>
      <span className="comment-avatar">{comment.author.name.replace(/\s/g, '').slice(0, 2)}</span>
      <div className="comment-body">
        <header>
          <span><strong>{comment.author.name}</strong>{comment.resolvedAt && <i>해결됨</i>}</span>
          <time>{new Date(comment.createdAt).toLocaleString('ko-KR')}</time>
        </header>
        <p><MentionText text={comment.text} names={mentionNames} /></p>
        {!readOnly && <div className="comment-reactions">
          {COMMENT_REACTIONS.map((emoji) => {
            const reactedUsers = comment.reactions?.[emoji] ?? []
            const names = reactedUsers.map((userId) => collaborators.find((candidate) => candidate.id === userId)?.name).filter(Boolean).join(', ')
            return (
              <button className={reactedUsers.includes(user.id) ? 'active' : ''} key={emoji} onClick={() => onReaction(comment, emoji)} title={names || `${emoji} 반응 추가`}>
                <span>{emoji}</span>{reactedUsers.length > 0 && <b>{reactedUsers.length}</b>}
              </button>
            )
          })}
          <button className="comment-reply" onClick={() => onReply(comment)}>답글</button>
          {canResolve && <button className="comment-resolve" onClick={() => onResolve(comment)}>{comment.resolvedAt ? '다시 열기' : '해결'}</button>}
        </div>}
      </div>
      {canDelete && (
        <button className="comment-delete" onClick={() => onDelete(comment)} aria-label="댓글 삭제" title="댓글 삭제"><Icon name="trash" size={12} /></button>
      )}
    </article>
  )
}

function storageKeyForMap(mapId: string) {
  return `${MAP_CACHE_KEY}:${mapId}`
}

function readSavedMap(mapId: string) {
  try {
    const saved = localStorage.getItem(storageKeyForMap(mapId))
    if (!saved) return null
    return JSON.parse(saved) as { nodes: MindMapNode[]; edges: MindMapEdge[] }
  } catch {
    return null
  }
}

function getOpenableUrl(value?: string) {
  const trimmed = value?.trim()
  if (!trimmed) return null

  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

async function apiRequest<T>(pathname: string, init?: RequestInit) {
  const response = await fetch(pathname, {
    ...init,
    credentials: 'include',
    headers: {
      'X-MNP-Client': CLIENT_ID,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new ApiRequestError(body.error ?? '요청을 처리하지 못했습니다.', response.status, body)
  return body
}

function preventInsertedTab(event: ReactFormEvent<HTMLInputElement>, moveFocus: () => void) {
  if ((event.nativeEvent as InputEvent).data !== '\t') return
  event.preventDefault()
  window.requestAnimationFrame(moveFocus)
}

function updateWithoutInsertedTab(value: string, update: (nextValue: string) => void, moveFocus: () => void) {
  const sanitized = value.replace(/\t/g, '')
  update(sanitized)
  if (sanitized !== value) window.requestAnimationFrame(moveFocus)
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const formRef = useRef<HTMLFormElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const rememberMeRef = useRef<HTMLInputElement>(null)
  const loginButtonRef = useRef<HTMLButtonElement>(null)
  const [email, setEmail] = useState(() => localStorage.getItem(LAST_LOGIN_EMAIL_KEY) ?? '')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const form = formRef.current
    if (!form) return
    const moveFocusOnTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = [...form.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
      if (focusable.length === 0) return
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1)
      event.preventDefault()
      focusable[nextIndex].focus()
    }
    form.addEventListener('keydown', moveFocusOnTab)
    return () => form.removeEventListener('keydown', moveFocusOnTab)
  }, [])

  const login = async (loginEmail = email, loginPassword = password) => {
    setSubmitting(true)
    setError('')
    try {
      const result = await apiRequest<{ user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: loginEmail, password: loginPassword, rememberMe }),
      })
      localStorage.setItem(LAST_LOGIN_EMAIL_KEY, loginEmail.trim())
      onAuthenticated(result.user)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '로그인하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-intro">
        <div className="login-brand"><Icon name="map" size={27} /></div>
        <span className="eyebrow">Mind & Progress</span>
        <h1>생각을 연결하고,<br />실행을 완성하세요.</h1>
        <p>아이디어의 흐름과 업무 진행 상황을 하나의 맵에서 관리합니다.</p>
        <div className="login-map-preview" aria-hidden="true">
          <span className="preview-node root-preview">목표</span>
          <i className="preview-line line-one" />
          <i className="preview-line line-two" />
          <span className="preview-node node-one">제품 설계</span>
          <span className="preview-node node-two done-preview">출시 준비 ✓</span>
        </div>
      </section>

      <section className="login-panel">
        <form ref={formRef} className="login-card" onSubmit={(event) => { event.preventDefault(); void login() }}>
          <div className="login-card-heading">
            <span>워크스페이스 로그인</span>
            <h2>다시 만나서 반갑습니다</h2>
            <p>계정 역할에 따라 편집 권한이 자동으로 적용됩니다.</p>
          </div>
          <label>
            <span>이메일</span>
            <input ref={emailRef} type="email" value={email} onBeforeInput={(event) => preventInsertedTab(event, () => passwordRef.current?.focus())} onChange={(event) => updateWithoutInsertedTab(event.target.value, setEmail, () => passwordRef.current?.focus())} autoComplete="username" autoFocus={!email} required />
          </label>
          <label>
            <span>비밀번호</span>
            <input ref={passwordRef} type="password" value={password} onBeforeInput={(event) => preventInsertedTab(event, () => rememberMeRef.current?.focus())} onChange={(event) => updateWithoutInsertedTab(event.target.value, setPassword, () => rememberMeRef.current?.focus())} autoComplete="current-password" autoFocus={Boolean(email)} required />
          </label>
          <div className="login-options">
            <label className="login-remember">
              <input ref={rememberMeRef} type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
              <span>로그인 유지</span>
            </label>
            <small>이 PC에서 30일간 유지</small>
          </div>
          {error && <div className="login-error" role="alert">{error}</div>}
          <button ref={loginButtonRef} className="login-submit" type="submit" disabled={submitting}>
            {submitting ? '확인 중…' : '로그인'}
          </button>
          <a className="viewer-entry-link" href="/mindmap/"><Icon name="external" size={13} /><span>읽기 전용으로 바로 보기</span></a>
        </form>
      </section>
    </main>
  )
}

function PasswordChangeDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)
  const currentPasswordRef = useRef<HTMLInputElement>(null)
  const newPasswordRef = useRef<HTMLInputElement>(null)
  const confirmationRef = useRef<HTMLInputElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute('hidden'))
      if (focusable.length === 0) return
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1)
      event.preventDefault()
      focusable[nextIndex].focus()
    }
    dialog.addEventListener('keydown', handleDialogKeys)
    return () => dialog.removeEventListener('keydown', handleDialogKeys)
  }, [onClose, success])

  const submit = async () => {
    setError('')
    if (newPassword.length < 8) {
      setError('새 비밀번호는 8자 이상 입력해 주세요.')
      return
    }
    if (newPassword !== confirmation) {
      setError('새 비밀번호 확인이 일치하지 않습니다.')
      return
    }
    setSubmitting(true)
    try {
      await apiRequest('/api/account/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      setSuccess(true)
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : '비밀번호를 변경하지 못했습니다.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="history-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section ref={dialogRef} className="history-modal password-modal" role="dialog" aria-modal="true" aria-label="비밀번호 변경">
        <header>
          <div><span>내 계정</span><strong>비밀번호 변경</strong></div>
          <button onClick={onClose} aria-label="비밀번호 변경 닫기"><Icon name="close" size={16} /></button>
        </header>
        {success ? (
          <div className="password-success" role="status">
            <span><Icon name="check" size={20} /></span>
            <strong>비밀번호가 변경되었습니다.</strong>
            <p>현재 브라우저는 그대로 유지되고, 다른 기기의 기존 로그인은 종료됩니다.</p>
            <button onClick={onClose}>확인</button>
          </div>
        ) : (
          <form className="password-form" onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <p>본인 확인을 위해 현재 비밀번호를 입력해 주세요.</p>
            <label><span>현재 비밀번호</span><input ref={currentPasswordRef} type="password" value={currentPassword} onBeforeInput={(event) => preventInsertedTab(event, () => newPasswordRef.current?.focus())} onChange={(event) => updateWithoutInsertedTab(event.target.value, setCurrentPassword, () => newPasswordRef.current?.focus())} autoComplete="current-password" autoFocus required /></label>
            <label><span>새 비밀번호</span><input ref={newPasswordRef} type="password" value={newPassword} onBeforeInput={(event) => preventInsertedTab(event, () => confirmationRef.current?.focus())} onChange={(event) => updateWithoutInsertedTab(event.target.value, setNewPassword, () => confirmationRef.current?.focus())} autoComplete="new-password" minLength={8} maxLength={128} required /><small>8자 이상 입력해 주세요.</small></label>
            <label><span>새 비밀번호 확인</span><input ref={confirmationRef} type="password" value={confirmation} onBeforeInput={(event) => preventInsertedTab(event, () => cancelButtonRef.current?.focus())} onChange={(event) => updateWithoutInsertedTab(event.target.value, setConfirmation, () => cancelButtonRef.current?.focus())} autoComplete="new-password" minLength={8} maxLength={128} required /></label>
            {error && <div className="password-error" role="alert">{error}</div>}
            <div className="password-actions"><button ref={cancelButtonRef} type="button" onClick={onClose}>취소</button><button type="submit" disabled={submitting}>{submitting ? '변경 중…' : '비밀번호 변경'}</button></div>
          </form>
        )}
      </section>
    </div>
  )
}

function Workspace({ user, onLogout, initialDeepLink }: { user: AuthUser; onLogout: () => void; initialDeepLink: WorkspaceDeepLink | null }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MindMapNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<MindMapEdge>([])
  const { canUndo, canRedo, undo, redo, resetHistory, beginTransaction: beginHistoryTransaction, endTransaction: endHistoryTransaction } = useMapHistory(nodes, setNodes, edges, setEdges)
  const mode: AccessMode = user.role === 'viewer' ? 'viewer' : 'editor'
  const [adminOpen, setAdminOpen] = useState(false)
  const closeAdminPanel = useCallback(() => setAdminOpen(false), [])
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [aiDialogOpen, setAiDialogOpen] = useState(false)
  const [nodeLinkCopyStatus, setNodeLinkCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [viewMode, setViewMode] = useState<ViewMode>(initialDeepLink?.viewMode ?? 'mindmap')
  const [documents, setDocuments] = useState<MapSummary[]>([])
  const [documentLayout, setDocumentLayout] = useState<DocumentLayout>(EMPTY_DOCUMENT_LAYOUT)
  const [collapsedDocumentGroupIds, setCollapsedDocumentGroupIds] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`mindnprogress-collapsed-document-groups:${user.id}`) ?? '[]')
      return new Set(Array.isArray(saved) ? saved.filter((groupId) => typeof groupId === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const [trashedDocuments, setTrashedDocuments] = useState<MapSummary[]>([])
  const [selectedTrashIds, setSelectedTrashIds] = useState<Set<string>>(() => new Set())
  const [trashDeleting, setTrashDeleting] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [activeMapId, setActiveMapId] = useState('')
  const [loadedMapId, setLoadedMapId] = useState<string | null>(null)
  const [mapReloadToken, setMapReloadToken] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyTab, setHistoryTab] = useState<'changes' | 'daily'>('changes')
  const [mapRevisions, setMapRevisions] = useState<MapRevisionSummary[]>([])
  const [dailyBackups, setDailyBackups] = useState<DailyBackupSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(null)
  const [historyPaginationError, setHistoryPaginationError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [externalChange, setExternalChange] = useState<MapChangeEvent | null>(null)
  const [presenceClients, setPresenceClients] = useState<PresenceClient[]>([])
  const [liveCursors, setLiveCursors] = useState<Record<string, LiveCursor>>({})
  const [mergeNotice, setMergeNotice] = useState('')
  const [comments, setComments] = useState<NodeComment[]>([])
  const [commentStats, setCommentStats] = useState<NodeCommentStats>({})
  const [referenceCommentStats, setReferenceCommentStats] = useState<NodeCommentStats>({})
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentError, setCommentError] = useState('')
  const [newComment, setNewComment] = useState('')
  const [replyTarget, setReplyTarget] = useState<NodeComment | null>(null)
  const [collaborators, setCollaborators] = useState<AuthUser[]>([])
  const [assigneeUsers, setAssigneeUsers] = useState<AuthUser[]>([])
  const [notifications, setNotifications] = useState<UserNotification[]>([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [nodeSearchTerm, setNodeSearchTerm] = useState('')
  const [nodeSearchIndex, setNodeSearchIndex] = useState(-1)
  const [nodeFilter, setNodeFilter] = useState<NodeFilter>('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [collapsedNodeIds, setCollapsedNodeIds] = useState<Set<string>>(() => new Set())
  const [creatingMap, setCreatingMap] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [newMapTitle, setNewMapTitle] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [renamingMap, setRenamingMap] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')
  const [newChecklistText, setNewChecklistText] = useState('')
  const [newWaitingLabel, setNewWaitingLabel] = useState('')
  const [waitingLabelDrafts, setWaitingLabelDrafts] = useState<Record<string, string>>({})
  const [dependencyCandidate, setDependencyCandidate] = useState('')
  const [dependencyError, setDependencyError] = useState('')
  const [knowledgeCandidate, setKnowledgeCandidate] = useState('')
  const [knowledgePolicy, setKnowledgePolicy] = useState<KnowledgePolicy>('reuse-first')
  const [knowledgeError, setKnowledgeError] = useState('')
  const [editingChecklist, setEditingChecklist] = useState<{ id: string; text: string } | null>(null)
  const [checklistTooltip, setChecklistTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [documentContextMenu, setDocumentContextMenu] = useState<{ x: number; y: number; mapId: string } | null>(null)
  const [aiConversationContextMenu, setAiConversationContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [copiedNodes, setCopiedNodes] = useState<CopiedNodes | null>(null)
  const [draggingLibraryItem, setDraggingLibraryItem] = useState<DocumentLayoutItem | null>(null)
  const [documentDropTargetId, setDocumentDropTargetId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [rightPanning, setRightPanning] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = Number(localStorage.getItem('mindnprogress-sidebar-width'))
    return Number.isFinite(savedWidth) ? Math.min(420, Math.max(190, savedWidth)) : 226
  })
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const savedWidth = Number(localStorage.getItem('mindnprogress-inspector-width'))
    return Number.isFinite(savedWidth) ? Math.min(520, Math.max(240, savedWidth)) : 278
  })
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [resizingInspector, setResizingInspector] = useState(false)
  const skipChecklistCommit = useRef(false)
  const waitingBlockRef = useRef<HTMLDivElement | null>(null)
  const sidebarResizeStart = useRef({ pointerX: 0, width: 226 })
  const inspectorResizeStart = useRef({ pointerX: 0, width: 278 })
  const dropTargetIdRef = useRef<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState('서버에서 불러오는 중…')
  const [saveError, setSaveError] = useState('')
  const dragSnapshot = useRef<DragSnapshot | null>(null)
  const rightPanGesture = useRef<RightPanGesture | null>(null)
  const suppressNodeContextMenuUntil = useRef(0)
  const serverBaseline = useRef<MapDocument | null>(null)
  const pastedNodeNotificationSuppressions = useRef<Map<string, Set<string>>>(new Map())
  const cursorSendAt = useRef(0)
  const nodeLinkCopyTimer = useRef<number | null>(null)
  const pendingSelection = useRef<string | null>(null)
  const pendingDeepLink = useRef(initialDeepLink)
  const lastLoadedMapId = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const selectedCommentTargetRef = useRef<{ mapId: string; nodeId: string } | null>(null)
  const referenceCommentTargetsRef = useRef<ReferenceCommentTarget[]>([])
  selectedIdRef.current = selectedId
  const { fitView, screenToFlowPosition, setCenter, setViewport } = useReactFlow<MindMapNode, MindMapEdge>()
  const viewport = useViewport()

  useEffect(() => {
    Object.keys(localStorage)
      .filter((key) => key === 'mindnprogress-demo-v1' || key.startsWith('mindnprogress-demo-v1:'))
      .forEach((key) => localStorage.removeItem(key))
  }, [])

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null
  const contextMenuNode = nodeContextMenu ? nodes.find((node) => node.id === nodeContextMenu.nodeId) ?? null : null
  const selectedCommentMapId = selectedNode?.data.reference?.mapId ?? activeMapId
  const selectedCommentNodeId = selectedNode?.data.reference?.nodeId ?? selectedId
  const referenceCommentTargets = nodes.flatMap<ReferenceCommentTarget>((node) => node.data.reference ? [{
    localNodeId: node.id,
    mapId: node.data.reference.mapId,
    nodeId: node.data.reference.nodeId,
  }] : []).sort((left, right) => left.localNodeId.localeCompare(right.localNodeId))
  const referenceCommentTargetsKey = JSON.stringify(referenceCommentTargets)
  referenceCommentTargetsRef.current = referenceCommentTargets
  selectedCommentTargetRef.current = selectedCommentMapId && selectedCommentNodeId
    ? { mapId: selectedCommentMapId, nodeId: selectedCommentNodeId }
    : null
  const selectedPrerequisites = selectedNode ? prerequisiteNodes(selectedNode, nodes) : []
  const selectedBlockingIds = new Set(selectedNode ? blockingNodes(selectedNode, nodes).map((node) => node.id) : [])
  const selectedDependents = selectedNode ? dependentNodes(selectedNode.id, nodes) : []
  const availableDependencies = selectedNode
    ? nodes.filter((node) => node.data.isWork
      && node.id !== selectedNode.id
      && !(selectedNode.data.blockedBy ?? []).includes(node.id)
      && !createsDependencyCycle(selectedNode.id, node.id, nodes))
    : []
  const unreadNotificationCount = notifications.filter((notification) => !notification.readAt).length

  const openWaitingItems = useCallback((nodeId: string) => {
    setSelectedId(nodeId)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        waitingBlockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }, [])

  const activeDocument = documents.find((document) => document.id === activeMapId) ?? null
  const activeRootState = useMemo(() => rootStateOf(nodes, edges), [edges, nodes])
  const teamMembers = useMemo<TeamMember[]>(() => assigneeUsers.map((assignee) => ({
    id: assignee.id,
    name: assignee.name,
    initials: assigneeInitials(assignee.name),
    color: assigneeColor(assignee.id),
    active: assignee.active !== false,
  })), [assigneeUsers])
  const selectableTeamMembers = teamMembers.filter((member) => member.active)
  const normalizedDocumentSearch = searchTerm.trim().toLowerCase()
  const filteredDocuments = documents.filter((document) => document.title.toLowerCase().includes(normalizedDocumentSearch))
  const documentsById = useMemo(() => new Map(documents.map((document) => [document.id, document])), [documents])
  const effectiveDocumentLayout = useMemo<DocumentLayout>(() => documentLayout.items.length > 0 || documents.length === 0
    ? documentLayout
    : { version: 1, items: documents.map((document) => ({ type: 'map', id: document.id })), groups: [] },
  [documentLayout, documents])
  const nodeTypes = useMemo<NodeTypes>(() => ({ mind: MindNode }), [])
  const edgeTypes = useMemo<EdgeTypes>(() => ({ 'knowledge-parallel': KnowledgeEdge }), [])
  const hierarchyEdges = useMemo(() => edges.filter(isHierarchyEdge), [edges])
  const knowledgeEdges = useMemo(() => edges.filter(isKnowledgeEdge), [edges])
  const selectedKnowledgeEdges = useMemo(() => selectedNode
    ? knowledgeEdges.filter((edge) => edge.target === selectedNode.id)
    : [], [knowledgeEdges, selectedNode])
  const availableKnowledgeSources = useMemo(() => selectedNode
    ? nodes.filter((node) => node.id !== selectedNode.id
      && !selectedKnowledgeEdges.some((edge) => edge.source === node.id)
      && !createsKnowledgeCycle(node.id, selectedNode.id, knowledgeEdges))
    : [], [knowledgeEdges, nodes, selectedKnowledgeEdges, selectedNode])
  const childrenById = useMemo(() => {
    const result = new Map<string, string[]>()
    hierarchyEdges.forEach((edge) => result.set(edge.source, [...(result.get(edge.source) ?? []), edge.target]))
    return result
  }, [hierarchyEdges])
  const parentsById = useMemo(() => {
    const result = new Map<string, string[]>()
    hierarchyEdges.forEach((edge) => result.set(edge.target, [...(result.get(edge.target) ?? []), edge.source]))
    return result
  }, [hierarchyEdges])
  const collapsibleNodeIds = useMemo(() => new Set(nodes.filter((node) => (childrenById.get(node.id)?.length ?? 0) > 0).map((node) => node.id)), [childrenById, nodes])
  const descendantCounts = useMemo(() => {
    const result = new Map<string, number>()
    nodes.forEach((node) => {
      const descendants = new Set<string>()
      const stack = [...(childrenById.get(node.id) ?? [])]
      while (stack.length > 0) {
        const currentId = stack.pop() as string
        if (currentId === node.id) continue
        if (descendants.has(currentId)) continue
        descendants.add(currentId)
        stack.push(...(childrenById.get(currentId) ?? []))
      }
      result.set(node.id, descendants.size)
    })
    return result
  }, [childrenById, nodes])
  const collapsedHiddenNodeIds = useMemo(() => {
    const hidden = new Set<string>()
    collapsedNodeIds.forEach((nodeId) => {
      const stack = [...(childrenById.get(nodeId) ?? [])]
      while (stack.length > 0) {
        const currentId = stack.pop() as string
        if (currentId === nodeId) continue
        if (hidden.has(currentId)) continue
        hidden.add(currentId)
        stack.push(...(childrenById.get(currentId) ?? []))
      }
    })
    return hidden
  }, [childrenById, collapsedNodeIds])
  const filterActive = nodeFilter !== 'all' || assigneeFilter !== 'all'
  const filterMatchedNodeIds = useMemo(() => new Set(nodes.filter((node) => {
    const status = node.data.progress >= 100 ? 'done' : node.data.status
    const statusMatches = nodeFilter === 'all'
      || nodeFilter === 'work' && Boolean(node.data.isWork)
      || nodeFilter === 'blocked' && blockingNodes(node, nodes).length > 0
      || nodeFilter === status
    const assigneeMatches = assigneeFilter === 'all'
      || Boolean(node.data.isWork) && assigneeFilter === 'unassigned' && !node.data.assigneeId
      || Boolean(node.data.isWork) && node.data.assigneeId === assigneeFilter
    return statusMatches && assigneeMatches
  }).map((node) => node.id)), [assigneeFilter, nodeFilter, nodes])
  const filterVisibleNodeIds = useMemo(() => {
    if (!filterActive) return new Set(nodes.map((node) => node.id))
    const visible = new Set(filterMatchedNodeIds)
    const stack = [...filterMatchedNodeIds]
    while (stack.length > 0) {
      const currentId = stack.pop() as string
      for (const parentId of parentsById.get(currentId) ?? []) {
        if (visible.has(parentId)) continue
        visible.add(parentId)
        stack.push(parentId)
      }
    }
    return visible
  }, [filterActive, filterMatchedNodeIds, nodes, parentsById])
  const normalizedNodeSearch = nodeSearchTerm.trim().toLowerCase()
  const searchMatchedNodeIds = useMemo(() => new Set(nodes.filter((node) => {
    if (!normalizedNodeSearch || !filterMatchedNodeIds.has(node.id)) return false
    const assignee = teamMembers.find((member) => member.id === node.data.assigneeId)?.name ?? ''
    return [node.data.label, node.data.description, node.data.sharedKnowledge ?? '', node.data.taskUrl ?? '', assignee]
      .some((value) => value.toLowerCase().includes(normalizedNodeSearch))
  }).map((node) => node.id)), [filterMatchedNodeIds, nodes, normalizedNodeSearch, teamMembers])
  const searchContextNodeIds = useMemo(() => {
    const visible = new Set(searchMatchedNodeIds)
    const stack = [...searchMatchedNodeIds]
    while (stack.length > 0) {
      const currentId = stack.pop() as string
      for (const parentId of parentsById.get(currentId) ?? []) {
        if (visible.has(parentId)) continue
        visible.add(parentId)
        stack.push(parentId)
      }
    }
    return visible
  }, [parentsById, searchMatchedNodeIds])
  const nodeSearchMatches = useMemo(() => nodes.filter((node) => searchMatchedNodeIds.has(node.id)), [nodes, searchMatchedNodeIds])
  const flowNodes = useMemo(() => nodes.map((node) => {
    const hiddenByCollapse = collapsedHiddenNodeIds.has(node.id)
      && !searchContextNodeIds.has(node.id)
      && !(filterActive && filterVisibleNodeIds.has(node.id))
    const hiddenByFilter = filterActive && !filterVisibleNodeIds.has(node.id)
    const hidden = hiddenByCollapse || hiddenByFilter
    return {
      ...node,
      hidden,
      data: {
        ...node.data,
        assignee: teamMembers.find((member) => member.id === node.data.assigneeId),
        unresolvedDependencyCount: blockingNodes(node, nodes).length,
        commentCount: (node.data.reference ? referenceCommentStats[node.id] : commentStats[node.id])?.total ?? 0,
        unresolvedCommentCount: (node.data.reference ? referenceCommentStats[node.id] : commentStats[node.id])?.unresolved ?? 0,
        hasChildren: collapsibleNodeIds.has(node.id),
        collapsed: collapsedNodeIds.has(node.id),
        hiddenDescendantCount: descendantCounts.get(node.id) ?? 0,
        onToggleCollapse: () => setCollapsedNodeIds((current) => {
          const next = new Set(current)
          if (next.has(node.id)) next.delete(node.id)
          else next.add(node.id)
          return next
        }),
        onOpenWaitingItems: () => openWaitingItems(node.id),
      },
      className: [
        node.className,
        node.id === dropTargetId ? 'drop-target' : '',
        normalizedNodeSearch && searchMatchedNodeIds.has(node.id) ? 'search-match' : '',
        normalizedNodeSearch && !searchMatchedNodeIds.has(node.id) && !hidden ? 'search-dim' : '',
        filterActive && filterVisibleNodeIds.has(node.id) && !filterMatchedNodeIds.has(node.id) ? 'filter-context' : '',
      ].filter(Boolean).join(' '),
    }
  }), [collapsedHiddenNodeIds, collapsedNodeIds, collapsibleNodeIds, commentStats, descendantCounts, dropTargetId, filterActive, filterMatchedNodeIds, filterVisibleNodeIds, nodes, normalizedNodeSearch, openWaitingItems, referenceCommentStats, searchContextNodeIds, searchMatchedNodeIds, teamMembers])
  const visibleFlowNodeIds = useMemo(() => new Set(flowNodes.filter((node) => !node.hidden).map((node) => node.id)), [flowNodes])
  const flowEdges = useMemo(() => {
    const pairKey = (edge: MindMapEdge) => JSON.stringify([edge.source, edge.target])
    const hierarchyPairs = new Set(edges.filter(isHierarchyEdge).map(pairKey))
    return edges.map((edge) => {
      const hidden = !visibleFlowNodeIds.has(edge.source) || !visibleFlowNodeIds.has(edge.target)
      if (!isKnowledgeEdge(edge)) return { ...edge, hidden }
      const primary = knowledgePolicyOf(edge) === 'reuse-first'
      return {
        ...edge,
        type: 'knowledge-parallel',
        hidden,
        reconnectable: false,
        data: {
          ...edge.data,
          parallelOffset: hierarchyPairs.has(pairKey(edge)) ? 18 : undefined,
        },
        className: `knowledge-edge ${primary ? 'reuse-first' : 'inspect-if-insufficient'}`,
        label: primary ? '주요 지식' : '부족할 때 확인',
        labelStyle: { fill: primary ? '#316d5a' : '#9a6a24', fontSize: 9, fontWeight: 700 },
        labelBgStyle: { fill: primary ? '#e7f7f1' : '#fff5df', fillOpacity: .96 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 5,
        style: { stroke: primary ? '#43a684' : '#d59a3a', strokeWidth: 2.2, strokeDasharray: primary ? undefined : '6 5' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: primary ? '#43a684' : '#d59a3a' },
      }
    })
  }, [edges, visibleFlowNodeIds])

  const navigateNodeSearch = (direction: 1 | -1) => {
    if (nodeSearchMatches.length === 0) return
    const nextIndex = nodeSearchIndex < 0
      ? direction === 1 ? 0 : nodeSearchMatches.length - 1
      : (nodeSearchIndex + direction + nodeSearchMatches.length) % nodeSearchMatches.length
    const target = nodeSearchMatches[nextIndex]
    setNodeSearchIndex(nextIndex)
    setSelectedId(target.id)
    setCenter(target.position.x + 109, target.position.y + 65, { zoom: Math.max(.85, Math.min(1.2, viewport.zoom)), duration: 420 })
  }

  useEffect(() => {
    setNodeSearchTerm('')
    setNodeSearchIndex(-1)
    setNodeFilter('all')
    setAssigneeFilter('all')
    setCollapsedNodeIds(new Set())
  }, [activeMapId])

  useEffect(() => {
    setNodeSearchIndex(-1)
  }, [assigneeFilter, nodeFilter, nodeSearchTerm])

  useEffect(() => {
    const availableTrashIds = new Set(trashedDocuments.map((document) => document.id))
    setSelectedTrashIds((current) => {
      const next = new Set([...current].filter((mapId) => availableTrashIds.has(mapId)))
      return next.size === current.size ? current : next
    })
  }, [trashedDocuments])

  useEffect(() => {
    localStorage.setItem(
      `mindnprogress-collapsed-document-groups:${user.id}`,
      JSON.stringify([...collapsedDocumentGroupIds]),
    )
  }, [collapsedDocumentGroupIds, user.id])

  useEffect(() => {
    const activeGroup = documentLayout.groups.find((group) => group.mapIds.includes(activeMapId))
    if (!activeGroup) return
    setCollapsedDocumentGroupIds((current) => {
      if (!current.has(activeGroup.id)) return current
      const next = new Set(current)
      next.delete(activeGroup.id)
      return next
    })
  }, [activeMapId, documentLayout.groups])

  useEffect(() => {
    if (selectedId && !visibleFlowNodeIds.has(selectedId)) setSelectedId(null)
  }, [selectedId, visibleFlowNodeIds])

  useEffect(() => {
    let active = true
    void Promise.all([
      apiRequest<DocumentLibraryResponse>('/api/maps'),
      mode === 'editor'
        ? apiRequest<{ maps: MapSummary[] }>('/api/maps/trash')
        : Promise.resolve({ maps: [] as MapSummary[] }),
    ])
      .then(async ([{ maps, documentLayout: loadedDocumentLayout }, { maps: trash }]) => {
        if (!active) return
        setTrashedDocuments(trash)
        setDocumentLayout(loadedDocumentLayout)
        if (maps.length > 0) {
          setDocuments(maps)
          const deepLink = pendingDeepLink.current
          const requestedDocument = deepLink?.mapId
            ? maps.find((map) => map.id === deepLink.mapId) ?? null
            : null
          const targetDocument = requestedDocument ?? maps[0]
          if (deepLink) {
            pendingDeepLink.current = {
              ...deepLink,
              mapId: targetDocument.id,
              nodeId: requestedDocument ? deepLink.nodeId : null,
            }
          }
          setActiveMapId(targetDocument.id)
          return
        }

        setDocuments([])
        setDocumentLayout(EMPTY_DOCUMENT_LAYOUT)
        setActiveMapId('')
        setNodes([])
        setEdges([])
        setSelectedId(null)
        setSavedAt('생성된 문서 없음')
      })
      .catch((error) => {
        if (!active) return
        setSaveError(error instanceof Error ? error.message : '문서 목록을 불러오지 못했습니다.')
      })
    return () => { active = false }
  }, [mode, setEdges, setNodes])

  useEffect(() => {
    void Promise.all([
      apiRequest<{ notifications: UserNotification[] }>('/api/notifications'),
      apiRequest<{ users: AuthUser[] }>('/api/users'),
      apiRequest<{ users: AuthUser[] }>('/api/assignees'),
    ])
      .then(([notificationResult, userResult, assigneeResult]) => {
        setNotifications(notificationResult.notifications)
        setCollaborators(userResult.users)
        setAssigneeUsers(assigneeResult.users)
      })
      .catch(() => {
        setNotifications([])
        setCollaborators([user])
        setAssigneeUsers(user.role === 'editor' ? [{ ...user, active: true }] : [])
      })
  }, [user])

  useEffect(() => {
    if (!activeMapId) {
      setCommentStats({})
      return
    }
    let active = true
    void apiRequest<{ comments: NodeComment[] }>(`/api/maps/${encodeURIComponent(activeMapId)}/comments`)
      .then((result) => { if (active) setCommentStats(buildCommentStats(result.comments)) })
      .catch(() => { if (active) setCommentStats({}) })
    return () => { active = false }
  }, [activeMapId])

  useEffect(() => {
    const targets = JSON.parse(referenceCommentTargetsKey) as ReferenceCommentTarget[]
    if (targets.length === 0) {
      setReferenceCommentStats({})
      return
    }
    let active = true
    const mapIds = [...new Set(targets.map((target) => target.mapId))]
    void Promise.all(mapIds.map(async (mapId) => {
      try {
        const result = await apiRequest<{ comments: NodeComment[] }>(`/api/maps/${encodeURIComponent(mapId)}/comments`)
        return [mapId, buildCommentStats(result.comments)] as const
      } catch {
        return [mapId, {}] as const
      }
    })).then((results) => {
      if (!active) return
      const statsByMap = new Map<string, NodeCommentStats>(results)
      setReferenceCommentStats(Object.fromEntries(targets.map((target) => [
        target.localNodeId,
        statsByMap.get(target.mapId)?.[target.nodeId] ?? { total: 0, unresolved: 0 },
      ])))
    })
    return () => { active = false }
  }, [referenceCommentTargetsKey])

  useEffect(() => {
    setReplyTarget(null)
    setNewComment('')
    if (!selectedCommentMapId || !selectedCommentNodeId) {
      setComments([])
      return
    }
    let active = true
    setComments([])
    setCommentsLoading(true)
    setCommentError('')
    void apiRequest<{ comments: NodeComment[] }>(`/api/maps/${encodeURIComponent(selectedCommentMapId)}/comments?nodeId=${encodeURIComponent(selectedCommentNodeId)}`)
      .then((result) => { if (active) setComments(result.comments) })
      .catch((error) => { if (active) setCommentError(error instanceof Error ? error.message : '댓글을 불러오지 못했습니다.') })
      .finally(() => { if (active) setCommentsLoading(false) })
    return () => { active = false }
  }, [selectedCommentMapId, selectedCommentNodeId, selectedId])

  useEffect(() => {
    if (!selectedId || !selectedNode?.data.reference) return
    const stats = buildCommentStats(comments)[selectedNode.data.reference.nodeId] ?? { total: 0, unresolved: 0 }
    setReferenceCommentStats((current) => {
      const previous = current[selectedId]
      if (previous?.total === stats.total && previous.unresolved === stats.unresolved) return current
      return { ...current, [selectedId]: stats }
    })
  }, [comments, selectedId, selectedNode?.data.reference])

  useEffect(() => {
    const eventSource = new EventSource(`/api/events?clientId=${encodeURIComponent(CLIENT_ID)}&mapId=${encodeURIComponent(activeMapId)}`)
    eventSource.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as MapChangeEvent | PresenceEvent | CursorEvent | CommentChangeEvent | AiConversationLinkedEvent | NotificationEvent | NotificationsReadEvent | NotificationsRemovedEvent | { type: 'connected' }
        if (event.type === 'presence') {
          if (event.mapId === activeMapId) setPresenceClients(event.clients)
          return
        }
        if (event.type === 'cursor') {
          if (event.mapId !== activeMapId || event.sourceClientId === CLIENT_ID || !event.sourceClientId) return
          setLiveCursors((current) => ({ ...current, [event.sourceClientId as string]: { ...event, receivedAt: Date.now() } }))
          return
        }
        if (event.type === 'comment-changed') {
          if (event.mapId === activeMapId) {
            void apiRequest<{ comments: NodeComment[] }>(`/api/maps/${encodeURIComponent(activeMapId)}/comments`)
              .then((result) => setCommentStats(buildCommentStats(result.comments)))
              .catch(() => undefined)
          }
          const referencedLocalNodeIds = referenceCommentTargetsRef.current
            .filter((target) => target.mapId === event.mapId && target.nodeId === event.nodeId)
            .map((target) => target.localNodeId)
          if (referencedLocalNodeIds.length > 0) {
            void apiRequest<{ comments: NodeComment[] }>(`/api/maps/${encodeURIComponent(event.mapId)}/comments?nodeId=${encodeURIComponent(event.nodeId)}`)
              .then((result) => {
                const stats = buildCommentStats(result.comments)[event.nodeId] ?? { total: 0, unresolved: 0 }
                setReferenceCommentStats((current) => ({
                  ...current,
                  ...Object.fromEntries(referencedLocalNodeIds.map((localNodeId) => [localNodeId, stats])),
                }))
              })
              .catch(() => undefined)
          }
          const commentTarget = selectedCommentTargetRef.current
          if (!commentTarget || event.mapId !== commentTarget.mapId || event.nodeId !== commentTarget.nodeId) return
          if (event.action === 'created' && event.comment) {
            setComments((current) => current.some((comment) => comment.id === event.comment?.id) ? current : [...current, event.comment as NodeComment])
          } else if (event.action === 'updated' && event.comment) {
            setComments((current) => current.map((comment) => comment.id === event.comment?.id ? event.comment as NodeComment : comment))
          } else if (event.action === 'deleted' && event.commentIds) {
            setComments((current) => current.filter((comment) => !event.commentIds?.includes(comment.id)))
          }
          return
        }
        if (event.type === 'ai-conversation-linked') {
          if (event.mapId !== activeMapId) return
          setNodes((current) => current.map((node) => node.id === event.nodeId
            ? { ...node, data: { ...node.data, aiConversationId: event.conversationId } }
            : node))
          void apiRequest<{ map: MapDocument }>(`/api/maps/${encodeURIComponent(activeMapId)}`)
            .then(({ map }) => {
              serverBaseline.current = structuredClone(map)
              setDocuments((current) => current.map((document) => document.id === map.id
                ? { ...document, version: map.version, updatedAt: map.updatedAt, updatedBy: map.updatedBy }
                : document))
            })
            .catch(() => undefined)
          return
        }
        if (event.type === 'notification') {
          setNotifications((current) => current.some((notification) => notification.id === event.notification.id)
            ? current.map((notification) => notification.id === event.notification.id ? event.notification : notification)
            : [event.notification, ...current])
          return
        }
        if (event.type === 'notifications-read') {
          if (event.userId !== user.id) return
          setNotifications((current) => current.map((notification) => (
            !event.notificationId || notification.id === event.notificationId
              ? { ...notification, readAt: notification.readAt ?? event.readAt }
              : notification
          )))
          return
        }
        if (event.type === 'notifications-removed') {
          if (event.userId === user.id) setNotifications((current) => current.filter((notification) => !event.notificationIds.includes(notification.id)))
          return
        }
        if (event.type !== 'map-changed' || event.sourceClientId === CLIENT_ID) return
        void (async () => {
          const [library, trashResult] = await Promise.all([
            apiRequest<DocumentLibraryResponse>('/api/maps'),
            mode === 'editor'
              ? apiRequest<{ maps: MapSummary[] }>('/api/maps/trash')
              : Promise.resolve({ maps: [] as MapSummary[] }),
          ])
          setDocuments(library.maps)
          setDocumentLayout(library.documentLayout)
          if (mode === 'editor') setTrashedDocuments(trashResult.maps)

          if (event.action === 'trashed' && event.mapId === activeMapId) {
            setActiveMapId(library.maps[0]?.id ?? '')
            return
          }
          if (event.mapId !== activeMapId || !['content', 'history-restored', 'daily-backup-restored'].includes(event.action)) return
          if (mode === 'viewer') setMapReloadToken((current) => current + 1)
          else setExternalChange(event)
        })().catch(() => undefined)
      } catch {
        // 연결 확인 이벤트 외의 잘못된 메시지는 무시합니다.
      }
    }
    return () => eventSource.close()
  }, [activeMapId, mode, setNodes, user.id])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const staleBefore = Date.now() - 4_000
      setLiveCursors((current) => Object.fromEntries(Object.entries(current).filter(([, cursor]) => cursor.receivedAt >= staleBefore)))
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!activeMapId) return
    let active = true
    setLoadedMapId(null)
    setSavedAt('서버에서 불러오는 중…')
    setSaveError('')

    void apiRequest<{ map: MapDocument }>(`/api/maps/${encodeURIComponent(activeMapId)}`)
      .then(({ map }) => {
        if (!active) return
        const deepLink = pendingDeepLink.current
        const deepLinkTargetsMap = deepLink?.mapId === map.id
        const requestedNode = deepLink?.mapId === map.id && deepLink.nodeId
          ? map.nodes.find((node) => node.id === deepLink.nodeId) ?? null
          : null
        const deepLinkedNodeId = requestedNode && deepLink && canSelectNodeInView(requestedNode, deepLink.viewMode)
          ? requestedNode.id
          : null
        const retainedNodeId = lastLoadedMapId.current === map.id ? selectedIdRef.current : null
        const requestedNodeId = pendingSelection.current ?? retainedNodeId
        const nextSelectedId = deepLinkTargetsMap
          ? deepLinkedNodeId
          : requestedNodeId && map.nodes.some((node) => node.id === requestedNodeId)
            ? requestedNodeId
            : map.nodes[0]?.id ?? null
        const loadedNodes = synchronizeNodeSelection(map.nodes, nextSelectedId)
        serverBaseline.current = structuredClone(map)
        resetHistory(loadedNodes, map.edges)
        setNodes(loadedNodes)
        setEdges(map.edges)
        setSelectedId(nextSelectedId)
        if (deepLinkTargetsMap) {
          pendingDeepLink.current = null
        }
        pendingSelection.current = null
        lastLoadedMapId.current = map.id
        localStorage.setItem(storageKeyForMap(activeMapId), JSON.stringify({ nodes: loadedNodes, edges: map.edges }))
        setDocuments((current) => current.map((document) => document.id === map.id
          ? { ...document, title: map.title, color: map.color, nodeCount: map.nodes.length }
          : document))
        setRenameTitle(map.title)
        setLoadedMapId(activeMapId)
        setExternalChange(null)
        setSavedAt(mode === 'editor' ? '서버와 동기화됨' : '읽기 전용')
      })
      .catch((error) => {
        if (!active) return
        const localMap = readSavedMap(activeMapId)
        if (localMap) {
          const retainedNodeId = lastLoadedMapId.current === activeMapId ? selectedIdRef.current : null
          const nextSelectedId = retainedNodeId && localMap.nodes.some((node) => node.id === retainedNodeId)
            ? retainedNodeId
            : localMap.nodes[0]?.id ?? null
          const loadedNodes = synchronizeNodeSelection(localMap.nodes, nextSelectedId)
          serverBaseline.current = null
          resetHistory(loadedNodes, localMap.edges)
          setNodes(loadedNodes)
          setEdges(localMap.edges)
          setSelectedId(nextSelectedId)
          lastLoadedMapId.current = activeMapId
          setLoadedMapId(activeMapId)
          setSavedAt('로컬 백업 사용 중')
        }
        setSaveError(error instanceof Error ? error.message : '마인드맵을 불러오지 못했습니다.')
      })
    return () => { active = false }
  }, [activeMapId, mapReloadToken, mode, resetHistory, setEdges, setNodes])

  useEffect(() => {
    if (!activeMapId || loadedMapId !== activeMapId) return
    const timer = window.setTimeout(() => {
      localStorage.setItem(storageKeyForMap(activeMapId), JSON.stringify({ nodes, edges }))
      if (mode === 'viewer') {
        setSavedAt('읽기 전용')
        return
      }

      setSavedAt('서버에 저장 중…')
      setSaveError('')
      const savingMapId = activeMapId
      const localContent = { nodes, edges }
      const suppressedNotificationNodeIds = [...(pastedNodeNotificationSuppressions.current.get(savingMapId) ?? [])]
        .filter((nodeId) => localContent.nodes.some((node) => node.id === nodeId))
      const clearPastedNodeNotificationSuppressions = () => {
        const current = pastedNodeNotificationSuppressions.current.get(savingMapId)
        if (!current) return
        suppressedNotificationNodeIds.forEach((nodeId) => current.delete(nodeId))
        if (current.size === 0) pastedNodeNotificationSuppressions.current.delete(savingMapId)
      }
      void apiRequest<{ map: MapDocument; summary: MapSummary }>(`/api/maps/${encodeURIComponent(savingMapId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          map: localContent,
          baseVersion: serverBaseline.current?.version,
          suppressWorkNotificationNodeIds: suppressedNotificationNodeIds,
        }),
      })
        .then(({ map, summary }) => {
          clearPastedNodeNotificationSuppressions()
          serverBaseline.current = structuredClone(map)
          setDocuments((current) => current.map((document) => document.id === summary.id ? summary : document))
          setSavedAt('서버와 동기화됨')
        })
        .catch(async (error) => {
          const conflictBody = error instanceof ApiRequestError
            ? error.body as { code?: string; map?: MapDocument }
            : null
          const base = serverBaseline.current
          const remote = conflictBody?.code === 'VERSION_CONFLICT' ? conflictBody.map : null
          if (error instanceof ApiRequestError && error.status === 409 && base && remote && base.id === savingMapId) {
            try {
              const merged = mergeMapContent(base, localContent, remote)
              const result = await apiRequest<{ map: MapDocument; summary: MapSummary }>(`/api/maps/${encodeURIComponent(savingMapId)}`, {
                method: 'PUT',
                body: JSON.stringify({
                  map: { nodes: merged.nodes, edges: merged.edges },
                  baseVersion: remote.version,
                  force: true,
                  suppressWorkNotificationNodeIds: suppressedNotificationNodeIds,
                }),
              })
              clearPastedNodeNotificationSuppressions()
              serverBaseline.current = structuredClone(result.map)
              setNodes(merged.nodes)
              setEdges(merged.edges)
              setDocuments((current) => current.map((document) => document.id === result.summary.id ? result.summary : document))
              setExternalChange(null)
              setMergeNotice(merged.conflicts > 0
                ? `동시 변경을 병합했습니다. 겹친 ${merged.conflicts}개 항목은 내 변경을 유지했습니다.`
                : '서로 다른 동시 변경을 자동으로 병합했습니다.')
              setSavedAt('동시 변경 병합됨')
              window.setTimeout(() => setMergeNotice(''), 5000)
              return
            } catch (mergeError) {
              setSaveError(mergeError instanceof Error ? mergeError.message : '동시 변경을 병합하지 못했습니다.')
              setSavedAt('병합 실패')
              return
            }
          }
          setSaveError(error instanceof Error ? error.message : '저장하지 못했습니다.')
          setSavedAt('저장 실패')
        })
    }, 600)
    return () => window.clearTimeout(timer)
  }, [activeMapId, edges, loadedMapId, mode, nodes, setEdges, setNodes])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (mode === 'viewer') return
      setEdges((current) => addEdge({
        ...connection,
        type: 'bezier',
        data: { relation: 'hierarchy' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      }, current))
    },
    [mode, setEdges],
  )

  const updateNode = useCallback((id: string, patch: Partial<MindNodeData>) => {
    const completesWork = patch.status === 'done' || (patch.progress ?? -1) >= 100
    const normalizedPatch = completesWork && patch.waitingItems === undefined
      ? { ...patch, waitingItems: [] }
      : patch
    setNodes((current) => current.map((node) => (
      node.id === id ? { ...node, data: { ...node.data, ...normalizedPatch } } : node
    )))
    setSavedAt('저장 중…')
  }, [setNodes])

  const updateSharedKnowledge = useCallback((id: string, sharedKnowledge: string) => {
    const hasSharedKnowledge = Boolean(sharedKnowledge.trim())
    updateNode(id, {
      sharedKnowledge,
      sharedKnowledgeUpdatedAt: hasSharedKnowledge ? new Date().toISOString() : undefined,
      sharedKnowledgeUpdatedBy: hasSharedKnowledge ? { id: user.id, name: user.name } : undefined,
    })
  }, [updateNode, user.id, user.name])

  const openAiConversation = (conversationId: string, cardId = selectedId) => {
    if (activeMapId && cardId) {
      void apiRequest(`/api/integrations/aionui/conversations/${encodeURIComponent(conversationId)}/attribution`, {
        method: 'POST',
        body: JSON.stringify({ mapId: activeMapId, cardId }),
        keepalive: true,
      }).catch((error) => {
        console.warn('[AI conversation attribution refresh]', error)
      })
    }
    const route = encodeURIComponent(`/conversation/${conversationId}`)
    window.location.href = `aionui://navigate?route=${route}`
  }

  const startOrOpenContextNodeAiConversation = () => {
    if (!contextMenuNode) return
    setNodeContextMenu(null)
    setSelectedId(contextMenuNode.id)
    if (contextMenuNode.data.aiConversationId) {
      void openAiConversation(contextMenuNode.data.aiConversationId, contextMenuNode.id)
      return
    }
    setAiDialogOpen(true)
  }

  const openAiConversationContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setNodeContextMenu(null)
    setDocumentContextMenu(null)
    setAiConversationContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 110),
    })
  }

  const startNewAiConversation = () => {
    setAiConversationContextMenu(null)
    setAiDialogOpen(true)
  }

  const showAiEditorOnlyAlert = () => {
    window.alert('AI 대화 기능은 편집자만 사용할 수 있습니다.')
  }

  const applyChecklist = (items: ChecklistItem[]) => {
    if (!selectedNode) return
    if (items.length === 0) {
      updateNode(selectedNode.id, { checklist: items })
      return
    }

    const completedCount = items.filter((item) => item.done).length
    const progress = Math.round((completedCount / items.length) * 100)
    updateNode(selectedNode.id, {
      checklist: items,
      progress,
      status: progress >= 100 ? 'done' : progress > 0 ? 'in-progress' : 'planned',
    })
  }

  const addChecklistItem = () => {
    const text = newChecklistText.trim()
    if (!selectedNode || !text || mode !== 'editor') return
    applyChecklist([
      ...(selectedNode.data.checklist ?? []),
      { id: `check-${Date.now()}`, text, done: false },
    ])
    setNewChecklistText('')
  }

  const updateWaitingItems = (items: WaitingItem[]) => {
    if (!selectedNode || mode !== 'editor') return
    updateNode(selectedNode.id, { waitingItems: items })
  }

  const addWaitingItem = () => {
    const label = newWaitingLabel.trim()
    if (!selectedNode || !label || mode !== 'editor') return
    updateWaitingItems([
      ...(selectedNode.data.waitingItems ?? []),
      {
        id: `wait-${crypto.randomUUID()}`,
        label,
        since: new Date().toISOString(),
      },
    ])
    setNewWaitingLabel('')
  }

  const commitWaitingLabel = (item: WaitingItem) => {
    const label = (waitingLabelDrafts[item.id] ?? item.label).trim()
    updateWaitingItems(label
      ? (selectedNode?.data.waitingItems ?? []).map((current) => current.id === item.id ? { ...current, label } : current)
      : (selectedNode?.data.waitingItems ?? []).filter((current) => current.id !== item.id))
    setWaitingLabelDrafts((current) => {
      const next = { ...current }
      delete next[item.id]
      return next
    })
  }

  const addDependency = () => {
    if (!selectedNode || !dependencyCandidate || mode !== 'editor') return
    if (createsDependencyCycle(selectedNode.id, dependencyCandidate, nodes)) {
      setDependencyError('순환 의존성은 추가할 수 없습니다.')
      return
    }
    updateNode(selectedNode.id, {
      blockedBy: [...new Set([...(selectedNode.data.blockedBy ?? []), dependencyCandidate])],
    })
    setDependencyCandidate('')
    setDependencyError('')
  }

  const removeDependency = (nodeId: string) => {
    if (!selectedNode || mode !== 'editor') return
    updateNode(selectedNode.id, { blockedBy: (selectedNode.data.blockedBy ?? []).filter((id) => id !== nodeId) })
    setDependencyError('')
  }

  const addKnowledgeSource = () => {
    if (!selectedNode || !knowledgeCandidate || mode !== 'editor') return
    if (createsKnowledgeCycle(knowledgeCandidate, selectedNode.id, knowledgeEdges)) {
      setKnowledgeError('순환 지식선은 추가할 수 없습니다.')
      return
    }
    if (selectedKnowledgeEdges.some((edge) => edge.source === knowledgeCandidate)) {
      setKnowledgeError('이미 연결된 선행 지식입니다.')
      return
    }
    setEdges((current) => [...current, {
      id: `knowledge-${knowledgeCandidate}-${selectedNode.id}-${Date.now()}`,
      source: knowledgeCandidate,
      target: selectedNode.id,
      type: 'bezier',
      reconnectable: false,
      data: { relation: 'knowledge', knowledgePolicy },
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    }])
    setKnowledgeCandidate('')
    setKnowledgeError('')
    setSavedAt('저장 중…')
  }

  const updateKnowledgePolicy = (edgeId: string, policy: KnowledgePolicy) => {
    if (mode !== 'editor') return
    setEdges((current) => current.map((edge) => edge.id === edgeId
      ? { ...edge, data: { ...edge.data, relation: 'knowledge', knowledgePolicy: policy } }
      : edge))
    setSavedAt('저장 중…')
  }

  const removeKnowledgeSource = (edgeId: string) => {
    if (mode !== 'editor') return
    setEdges((current) => current.filter((edge) => edge.id !== edgeId))
    setKnowledgeError('')
    setSavedAt('저장 중…')
  }

  const commitChecklistEdit = () => {
    if (skipChecklistCommit.current) {
      skipChecklistCommit.current = false
      setEditingChecklist(null)
      return
    }
    if (!selectedNode || !editingChecklist || mode !== 'editor') return
    const text = editingChecklist.text.trim()
    if (text) {
      applyChecklist((selectedNode.data.checklist ?? []).map((item) => (
        item.id === editingChecklist.id ? { ...item, text } : item
      )))
    }
    setEditingChecklist(null)
  }

  useEffect(() => {
    setNewChecklistText('')
    setNewWaitingLabel('')
    setWaitingLabelDrafts({})
    setEditingChecklist(null)
    setChecklistTooltip(null)
    setDependencyCandidate('')
    setDependencyError('')
    setKnowledgeCandidate('')
    setKnowledgePolicy('reuse-first')
    setKnowledgeError('')
    skipChecklistCommit.current = false
  }, [selectedId])

  useEffect(() => {
    localStorage.setItem('mindnprogress-sidebar-width', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem('mindnprogress-inspector-width', String(inspectorWidth))
  }, [inspectorWidth])

  const addNode = useCallback((parentId?: string, position?: { x: number; y: number }) => {
    if (mode === 'viewer') return
    const parent = nodes.find((node) => node.id === parentId) ?? selectedNode
    const childCount = parent ? hierarchyEdges.filter((edge) => edge.source === parent.id).length : 0
    const id = `node-${Date.now()}`
    const nextPosition = position ?? (parent
      ? { x: parent.position.x + 320, y: parent.position.y + childCount * 150 - 40 }
      : { x: 160, y: 120 })
    const node: MindMapNode = {
      id,
      type: 'mind',
      position: nextPosition,
      data: {
        label: '새로운 아이디어',
        description: '설명을 입력해 주세요',
        sharedKnowledge: '',
        progress: 0,
        status: 'planned',
        kind: parent ? 'task' : 'branch',
      },
    }
    setNodes((current) => [...current, node])
    if (parent) {
      setEdges((current) => [...current, {
        id: `edge-${parent.id}-${id}`,
        source: parent.id,
        target: id,
        type: 'bezier',
        data: { relation: 'hierarchy' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      }])
    }
    setSelectedId(id)
  }, [hierarchyEdges, mode, nodes, selectedNode, setEdges, setNodes])

  useEffect(() => {
    const handleInsert = (event: KeyboardEvent) => {
      if (event.key !== 'Insert' || mode !== 'editor' || !selectedId) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return

      event.preventDefault()
      addNode(selectedId)
    }

    window.addEventListener('keydown', handleInsert)
    return () => window.removeEventListener('keydown', handleInsert)
  }, [addNode, mode, selectedId])

  useEffect(() => {
    const handleFitViewShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'Home' || viewMode !== 'mindmap' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return

      event.preventDefault()
      void fitView({ padding: 0.2, duration: 500 })
    }

    window.addEventListener('keydown', handleFitViewShortcut)
    return () => window.removeEventListener('keydown', handleFitViewShortcut)
  }, [fitView, viewMode])

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (mode !== 'editor' || (!event.ctrlKey && !event.metaKey)) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()

      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (key === 'y') {
        event.preventDefault()
        redo()
      }
    }

    window.addEventListener('keydown', handleHistoryShortcut)
    return () => window.removeEventListener('keydown', handleHistoryShortcut)
  }, [mode, redo, undo])

  const deleteNodeById = useCallback((nodeId: string) => {
    if (mode === 'viewer') return
    setNodes((current) => current
      .filter((node) => node.id !== nodeId)
      .map((node) => (node.data.blockedBy ?? []).includes(nodeId)
        ? { ...node, data: { ...node.data, blockedBy: (node.data.blockedBy ?? []).filter((id) => id !== nodeId) } }
        : node))
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    setCollapsedNodeIds((current) => {
      const next = new Set(current)
      next.delete(nodeId)
      return next
    })
    setSelectedId((current) => current === nodeId ? null : current)
  }, [mode, setEdges, setNodes])

  const deleteSelected = useCallback(() => {
    if (selectedId) deleteNodeById(selectedId)
  }, [deleteNodeById, selectedId])

  const startNodeRightPan = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 2 || viewMode !== 'mindmap') return
    const target = event.target as HTMLElement
    if (!target.closest('.react-flow__node') || target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return
    event.preventDefault()
    event.stopPropagation()
    setNodeContextMenu(null)
    setDocumentContextMenu(null)
    setAiConversationContextMenu(null)
    rightPanGesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
      moved: false,
      contextMenuSuppressed: false,
    }
  }, [viewMode, viewport.x, viewport.y, viewport.zoom])

  const openNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
    const gesture = rightPanGesture.current
    if (gesture?.moved || Date.now() < suppressNodeContextMenuUntil.current) {
      event.preventDefault()
      event.stopPropagation()
      if (gesture) gesture.contextMenuSuppressed = true
      suppressNodeContextMenuUntil.current = 0
      return
    }
    if (mode !== 'editor') return
    event.preventDefault()
    event.stopPropagation()
    setDocumentContextMenu(null)
    setAiConversationContextMenu(null)
    setSelectedId(nodeId)
    setNodeContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 330)),
      nodeId,
    })
  }, [mode])

  useEffect(() => {
    const moveRightPan = (event: PointerEvent) => {
      const gesture = rightPanGesture.current
      if (!gesture || (event.buttons & 2) === 0) return
      const deltaX = event.clientX - gesture.startX
      const deltaY = event.clientY - gesture.startY
      if (!gesture.moved && Math.hypot(deltaX, deltaY) < 5) return
      if (!gesture.moved) {
        gesture.moved = true
        setRightPanning(true)
      }
      event.preventDefault()
      void setViewport({
        x: gesture.viewport.x + deltaX,
        y: gesture.viewport.y + deltaY,
        zoom: gesture.viewport.zoom,
      }, { duration: 0 })
    }

    const completeRightPan = (suppressContextMenu: boolean) => {
      const gesture = rightPanGesture.current
      if (!gesture) return
      if (suppressContextMenu && gesture.moved && !gesture.contextMenuSuppressed) {
        suppressNodeContextMenuUntil.current = Date.now() + 400
      }
      rightPanGesture.current = null
      setRightPanning(false)
    }

    const finishRightPan = (event: PointerEvent) => {
      if (event.button === 2) completeRightPan(true)
    }
    const cancelRightPan = () => completeRightPan(false)

    window.addEventListener('pointermove', moveRightPan, { passive: false })
    window.addEventListener('pointerup', finishRightPan)
    window.addEventListener('pointercancel', cancelRightPan)
    window.addEventListener('blur', cancelRightPan)
    return () => {
      window.removeEventListener('pointermove', moveRightPan)
      window.removeEventListener('pointerup', finishRightPan)
      window.removeEventListener('pointercancel', cancelRightPan)
      window.removeEventListener('blur', cancelRightPan)
    }
  }, [setViewport])

  const copyNode = useCallback((nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node || !activeMapId) return
    const selectedNodes = nodes.filter((candidate) => candidate.selected)
    const nodesToCopy = selectedNodes.some((candidate) => candidate.id === nodeId) ? selectedNodes : [node]
    const copiedNodeIds = new Set(nodesToCopy.map((candidate) => candidate.id))
    setCopiedNodes({
      sourceMapId: activeMapId,
      nodes: nodesToCopy.map((candidate) => {
        const copiedData = structuredClone(candidate.data)
        delete copiedData.aiConversationId
        return {
          sourceNodeId: candidate.id,
          position: { ...candidate.position },
          data: copiedData,
        }
      }),
      edges: edges
        .filter((edge) => copiedNodeIds.has(edge.source) && copiedNodeIds.has(edge.target))
        .map((edge) => structuredClone(edge)),
    })
    setNodeContextMenu(null)
  }, [activeMapId, edges, nodes])

  const pasteNodeAsChild = useCallback((parentId: string, pasteMode: NodePasteMode = 'copy') => {
    if (!copiedNodes || copiedNodes.nodes.length === 0 || mode !== 'editor' || !activeMapId) return
    const parent = nodes.find((node) => node.id === parentId)
    if (!parent) return
    const isCrossDocument = copiedNodes.sourceMapId !== activeMapId
    if ((isCrossDocument && pasteMode === 'copy') || (!isCrossDocument && pasteMode !== 'copy')) return
    const childCount = hierarchyEdges.filter((edge) => edge.source === parentId).length
    const timestamp = Date.now()
    const sourceMinX = Math.min(...copiedNodes.nodes.map((item) => item.position.x))
    const sourceMinY = Math.min(...copiedNodes.nodes.map((item) => item.position.y))
    const targetOrigin = {
      x: parent.position.x + 320,
      y: parent.position.y + childCount * 150 - 40,
    }
    const nodeIdMap = new Map(copiedNodes.nodes.map((item, index) => [item.sourceNodeId, `node-${timestamp}-${index}`]))
    const pastedNodes = copiedNodes.nodes.map((item, nodeIndex): MindMapNode => {
      const copiedData = structuredClone(item.data)
      const originalReference = copiedData.reference ?? {
        mapId: copiedNodes.sourceMapId,
        nodeId: item.sourceNodeId,
      }
      const baseLabel = copiedData.reference
        ? copiedData.label.replace(/\s*\(ref\)\s*$/i, '').trim()
        : copiedData.label
      const label = pasteMode === 'copy'
        ? `${copiedData.label} 복사본`
        : pasteMode === 'reference'
          ? `${baseLabel} (ref)`
          : baseLabel
      const remappedBlockedBy = (copiedData.blockedBy ?? [])
        .flatMap((blockedById) => nodeIdMap.get(blockedById) ?? [])
      return {
        id: nodeIdMap.get(item.sourceNodeId) as string,
        type: 'mind',
        position: {
          x: targetOrigin.x + item.position.x - sourceMinX,
          y: targetOrigin.y + item.position.y - sourceMinY,
        },
        selected: true,
        data: {
          ...copiedData,
          label,
          kind: 'task',
          aiConversationId: undefined,
          reference: pasteMode === 'reference' ? originalReference : pasteMode === 'clone' ? undefined : copiedData.reference,
          blockedBy: remappedBlockedBy.length > 0 ? remappedBlockedBy : undefined,
          unresolvedDependencyCount: undefined,
          checklist: copiedData.checklist?.map((checklistItem, checklistIndex) => ({
            ...checklistItem,
            id: `check-${timestamp}-${nodeIndex}-${checklistIndex}`,
          })),
          waitingItems: copiedData.waitingItems?.map((waitingItem, waitingIndex) => ({
            ...waitingItem,
            id: `wait-${timestamp}-${nodeIndex}-${waitingIndex}`,
          })),
        },
      }
    })
    const copiedHierarchyTargets = new Set(copiedNodes.edges
      .filter(isHierarchyEdge)
      .map((edge) => edge.target))
    const pastedInternalEdges = copiedNodes.edges.flatMap((edge, index) => {
      const source = nodeIdMap.get(edge.source)
      const target = nodeIdMap.get(edge.target)
      if (!source || !target) return []
      return [{
        ...structuredClone(edge),
        id: `edge-${timestamp}-internal-${index}`,
        source,
        target,
      }]
    })
    const pastedRootEdges = copiedNodes.nodes
      .filter((item) => !copiedHierarchyTargets.has(item.sourceNodeId))
      .map((item, index): MindMapEdge => ({
        id: `edge-${parentId}-${timestamp}-root-${index}`,
        source: parentId,
        target: nodeIdMap.get(item.sourceNodeId) as string,
        type: 'bezier',
        data: { relation: 'hierarchy' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      }))
    const suppressedNodeIds = pastedNodeNotificationSuppressions.current.get(activeMapId) ?? new Set<string>()
    pastedNodes.forEach((pastedNode) => suppressedNodeIds.add(pastedNode.id))
    pastedNodeNotificationSuppressions.current.set(activeMapId, suppressedNodeIds)
    setNodes((current) => [...current.map((node) => node.selected ? { ...node, selected: false } : node), ...pastedNodes])
    setEdges((current) => [...current, ...pastedInternalEdges, ...pastedRootEdges])
    setSelectedId(pastedNodes[0].id)
    setNodeContextMenu(null)
  }, [activeMapId, copiedNodes, hierarchyEdges, mode, nodes, setEdges, setNodes])

  useEffect(() => {
    const closeContextMenu = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target?.closest('.node-context-menu')) {
        setNodeContextMenu(null)
        setDocumentContextMenu(null)
        setAiConversationContextMenu(null)
      }
      if (!target?.closest('.notification-center')) setNotificationsOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNodeContextMenu(null)
        setDocumentContextMenu(null)
        setAiConversationContextMenu(null)
        setHistoryOpen(false)
        setNotificationsOpen(false)
      }
    }
    window.addEventListener('pointerdown', closeContextMenu)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeContextMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [])

  useEffect(() => {
    setNodeContextMenu(null)
    setDocumentContextMenu(null)
    setAiConversationContextMenu(null)
  }, [activeMapId, viewMode])

  useEffect(() => {
    setAiConversationContextMenu(null)
    setNodeLinkCopyStatus('idle')
    if (nodeLinkCopyTimer.current !== null) window.clearTimeout(nodeLinkCopyTimer.current)
    return () => {
      if (nodeLinkCopyTimer.current !== null) window.clearTimeout(nodeLinkCopyTimer.current)
    }
  }, [activeMapId, selectedId, viewMode])

  useEffect(() => {
    setHistoryOpen(false)
    setMapRevisions([])
    setHistoryHasMore(false)
    setHistoryNextOffset(null)
    setHistoryLoadingMore(false)
    setHistoryPaginationError('')
    setExternalChange(null)
    setPresenceClients([])
    setLiveCursors({})
  }, [activeMapId])

  const createMap = async () => {
    const title = newMapTitle.trim()
    if (!title || mode !== 'editor') return
    const rootId = `root-${Date.now()}`
    const map: Pick<MapDocument, 'nodes' | 'edges'> = {
      nodes: [{
        id: rootId,
        type: 'mind',
        position: { x: 0, y: 0 },
        data: {
          label: title,
          description: '새로운 마인드맵의 중심 주제',
          sharedKnowledge: '',
          progress: 0,
          status: 'planned',
          kind: 'root',
        },
      }],
      edges: [],
    }

    setSaveError('')
    try {
      const created = await apiRequest<{ map: MapDocument; summary: MapSummary; documentLayout: DocumentLayout }>('/api/maps', {
        method: 'POST',
        body: JSON.stringify({ title, map }),
      })
      setDocuments((current) => [...current, created.summary])
      setDocumentLayout(created.documentLayout)
      setCreatingMap(false)
      setNewMapTitle('')
      setActiveMapId(created.summary.id)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '새 문서를 만들지 못했습니다.')
    }
  }

  const renameActiveMap = async () => {
    const title = renameTitle.trim()
    if (!activeMapId || !title || mode !== 'editor') return
    setSaveError('')
    try {
      const updated = await apiRequest<{ map: MapDocument; summary: MapSummary }>(`/api/maps/${encodeURIComponent(activeMapId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title, baseVersion: serverBaseline.current?.version }),
      })
      serverBaseline.current = structuredClone(updated.map)
      setDocuments((current) => current.map((document) => document.id === updated.summary.id ? updated.summary : document))
      setRenamingMap(false)
      setSavedAt('이름 변경됨')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '문서 이름을 변경하지 못했습니다.')
    }
  }

  const changeDocumentColor = async (mapId: string, color: DocumentColorId) => {
    if (mode !== 'editor') return
    const document = documents.find((item) => item.id === mapId)
    if (!document || document.color === color) return
    const previousColor = document.color
    setDocuments((current) => current.map((item) => item.id === mapId ? { ...item, color } : item))
    setSaveError('')

    try {
      const updated = await apiRequest<{ map: MapDocument; summary: MapSummary }>(`/api/maps/${encodeURIComponent(mapId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ color, baseVersion: mapId === activeMapId ? serverBaseline.current?.version : document.version }),
      })
      if (mapId === activeMapId) serverBaseline.current = structuredClone(updated.map)
      setDocuments((current) => current.map((item) => item.id === updated.summary.id ? updated.summary : item))
      setSavedAt('문서 색상 변경됨')
    } catch (error) {
      setDocuments((current) => current.map((item) => item.id === mapId ? { ...item, color: previousColor } : item))
      setSaveError(error instanceof Error ? error.message : '문서 색상을 변경하지 못했습니다.')
    }
  }

  const openMapHistory = async () => {
    if (!activeMapId) return
    setHistoryOpen(true)
    setHistoryTab('changes')
    setHistoryLoading(true)
    setHistoryError('')
    setHistoryPaginationError('')
    setHistoryHasMore(false)
    setHistoryNextOffset(null)
    try {
      const [historyResult, backupResult] = await Promise.all([
        apiRequest<MapRevisionPage>(`/api/maps/${encodeURIComponent(activeMapId)}/history`),
        apiRequest<{ dailyBackups: DailyBackupSummary[] }>(`/api/maps/${encodeURIComponent(activeMapId)}/backups/daily`),
      ])
      setMapRevisions(historyResult.revisions)
      setHistoryHasMore(historyResult.hasMore)
      setHistoryNextOffset(historyResult.nextOffset)
      setDailyBackups(backupResult.dailyBackups)
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '변경 이력을 불러오지 못했습니다.')
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadMoreMapHistory = async () => {
    if (!activeMapId || historyLoading || historyLoadingMore || !historyHasMore || historyNextOffset === null) return
    setHistoryLoadingMore(true)
    setHistoryPaginationError('')
    try {
      const result = await apiRequest<MapRevisionPage>(
        `/api/maps/${encodeURIComponent(activeMapId)}/history?offset=${historyNextOffset}&limit=50`,
      )
      setMapRevisions((current) => {
        const existingIds = new Set(current.map((revision) => revision.id))
        return [...current, ...result.revisions.filter((revision) => !existingIds.has(revision.id))]
      })
      setHistoryHasMore(result.hasMore)
      setHistoryNextOffset(result.nextOffset)
    } catch (error) {
      setHistoryPaginationError(error instanceof Error ? error.message : '이전 변경 이력을 더 불러오지 못했습니다.')
    } finally {
      setHistoryLoadingMore(false)
    }
  }

  const restoreMapRevision = async (revision: MapRevisionSummary) => {
    if (mode !== 'editor' || !activeMapId) return
    const savedTime = new Date(revision.mapUpdatedAt ?? revision.archivedAt).toLocaleString('ko-KR')
    if (!window.confirm(`${savedTime} 버전으로 복원할까요? 현재 상태도 변경 이력에 보관됩니다.`)) return
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const result = await apiRequest<{ map: MapDocument; summary: MapSummary; revisions: MapRevisionSummary[]; historyHasMore: boolean; historyNextOffset: number | null }>(
        `/api/maps/${encodeURIComponent(activeMapId)}/history/${encodeURIComponent(revision.id)}/restore`,
        { method: 'POST' },
      )
      serverBaseline.current = structuredClone(result.map)
      resetHistory(result.map.nodes, result.map.edges)
      setNodes(result.map.nodes)
      setEdges(result.map.edges)
      setSelectedId(result.map.nodes[0]?.id ?? null)
      setDocuments((current) => current.map((document) => document.id === result.summary.id ? result.summary : document))
      setMapRevisions(result.revisions)
      setHistoryHasMore(result.historyHasMore)
      setHistoryNextOffset(result.historyNextOffset)
      setHistoryPaginationError('')
      setExternalChange(null)
      localStorage.setItem(storageKeyForMap(activeMapId), JSON.stringify({ nodes: result.map.nodes, edges: result.map.edges }))
      setSavedAt('이전 버전 복원됨')
      window.setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 0)
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '이전 버전을 복원하지 못했습니다.')
    } finally {
      setHistoryLoading(false)
    }
  }

  const restoreDailyBackup = async (backup: DailyBackupSummary) => {
    if (mode !== 'editor' || !activeMapId) return
    const savedTime = backup.mapUpdatedAt ? new Date(backup.mapUpdatedAt).toLocaleString('ko-KR') : backup.date
    if (!window.confirm(`${backup.date} 일일 백업(${savedTime})으로 복원할까요? 현재 상태도 복원 가능한 이력으로 보관됩니다.`)) return
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const result = await apiRequest<{ map: MapDocument; summary: MapSummary; dailyBackups: DailyBackupSummary[]; revisions: MapRevisionSummary[]; historyHasMore: boolean; historyNextOffset: number | null }>(
        `/api/maps/${encodeURIComponent(activeMapId)}/backups/daily/${encodeURIComponent(backup.date)}/restore`,
        { method: 'POST' },
      )
      serverBaseline.current = structuredClone(result.map)
      resetHistory(result.map.nodes, result.map.edges)
      setNodes(result.map.nodes)
      setEdges(result.map.edges)
      setSelectedId(result.map.nodes[0]?.id ?? null)
      setDocuments((current) => current.map((document) => document.id === result.summary.id ? result.summary : document))
      setDailyBackups(result.dailyBackups)
      setMapRevisions(result.revisions)
      setHistoryHasMore(result.historyHasMore)
      setHistoryNextOffset(result.historyNextOffset)
      setHistoryPaginationError('')
      setExternalChange(null)
      localStorage.setItem(storageKeyForMap(activeMapId), JSON.stringify({ nodes: result.map.nodes, edges: result.map.edges }))
      setSavedAt(`${backup.date} 일일 백업 복원됨`)
      window.setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 0)
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '일일 백업을 복원하지 못했습니다.')
    } finally {
      setHistoryLoading(false)
    }
  }

  const saveDocumentLayout = async (nextLayout: DocumentLayout, successMessage: string) => {
    if (mode !== 'editor') return
    const previousLayout = documentLayout
    setDocumentLayout(nextLayout)
    setSaveError('')
    try {
      const result = await apiRequest<DocumentLibraryResponse>('/api/maps/layout', {
        method: 'PATCH',
        body: JSON.stringify({ documentLayout: nextLayout }),
      })
      setDocuments(result.maps)
      setDocumentLayout(result.documentLayout)
      setSavedAt(successMessage)
    } catch (error) {
      setDocumentLayout(previousLayout)
      setSaveError(error instanceof Error ? error.message : '문서 그룹과 순서를 저장하지 못했습니다.')
    }
  }

  const moveLibraryItem = (dragged: DocumentLayoutItem, destination: { type: 'top'; target?: DocumentLayoutItem } | { type: 'group'; groupId: string; targetMapId?: string }) => {
    if (mode !== 'editor') return
    if (dragged.type === 'group' && destination.type === 'group') return
    if (destination.type === 'top' && destination.target?.type === dragged.type && destination.target.id === dragged.id) return
    if (dragged.type === 'map' && destination.type === 'group' && destination.targetMapId === dragged.id) return
    const nextLayout = structuredClone(documentLayout)

    if (dragged.type === 'group') {
      if (destination.type !== 'top') return
      const currentIndex = nextLayout.items.findIndex((item) => item.type === 'group' && item.id === dragged.id)
      if (currentIndex < 0) return
      const [item] = nextLayout.items.splice(currentIndex, 1)
      const targetIndex = destination.target
        ? nextLayout.items.findIndex((candidate) => candidate.type === destination.target?.type && candidate.id === destination.target.id)
        : nextLayout.items.length
      nextLayout.items.splice(targetIndex < 0 ? nextLayout.items.length : targetIndex, 0, item)
    } else {
      nextLayout.items = nextLayout.items.filter((item) => !(item.type === 'map' && item.id === dragged.id))
      nextLayout.groups = nextLayout.groups.map((group) => ({
        ...group,
        mapIds: group.mapIds.filter((mapId) => mapId !== dragged.id),
      }))
      if (destination.type === 'group') {
        const group = nextLayout.groups.find((candidate) => candidate.id === destination.groupId)
        if (!group) return
        const targetIndex = destination.targetMapId ? group.mapIds.indexOf(destination.targetMapId) : group.mapIds.length
        group.mapIds.splice(targetIndex < 0 ? group.mapIds.length : targetIndex, 0, dragged.id)
      } else {
        const item: DocumentLayoutItem = { type: 'map', id: dragged.id }
        const targetIndex = destination.target
          ? nextLayout.items.findIndex((candidate) => candidate.type === destination.target?.type && candidate.id === destination.target.id)
          : nextLayout.items.length
        nextLayout.items.splice(targetIndex < 0 ? nextLayout.items.length : targetIndex, 0, item)
      }
    }

    setDraggingLibraryItem(null)
    setDocumentDropTargetId(null)
    void saveDocumentLayout(nextLayout, dragged.type === 'group' ? '그룹 순서 저장됨' : '문서 위치 저장됨')
  }

  const createDocumentGroup = () => {
    const name = newGroupName.trim()
    if (!name || mode !== 'editor') return
    const group: DocumentGroup = {
      id: `group-${crypto.randomUUID()}`,
      name,
      mapIds: [],
    }
    const nextLayout: DocumentLayout = {
      ...documentLayout,
      items: [...documentLayout.items, { type: 'group', id: group.id }],
      groups: [...documentLayout.groups, group],
    }
    setCreatingGroup(false)
    setNewGroupName('')
    void saveDocumentLayout(nextLayout, '문서 그룹 생성됨')
  }

  const renameDocumentGroup = (group: DocumentGroup) => {
    if (mode !== 'editor') return
    const name = window.prompt('그룹 이름을 입력하세요.', group.name)?.trim()
    if (!name || name === group.name) return
    void saveDocumentLayout({
      ...documentLayout,
      groups: documentLayout.groups.map((candidate) => candidate.id === group.id ? { ...candidate, name } : candidate),
    }, '문서 그룹 이름 변경됨')
  }

  const deleteDocumentGroup = (group: DocumentGroup) => {
    if (mode !== 'editor' || !window.confirm(`“${group.name}” 그룹을 삭제할까요?\n그룹 안의 문서는 삭제되지 않고 현재 위치에 개별 문서로 배치됩니다.`)) return
    const groupIndex = documentLayout.items.findIndex((item) => item.type === 'group' && item.id === group.id)
    const items = documentLayout.items.filter((item) => !(item.type === 'group' && item.id === group.id))
    items.splice(Math.max(0, groupIndex), 0, ...group.mapIds.map((id): DocumentLayoutItem => ({ type: 'map', id })))
    setCollapsedDocumentGroupIds((current) => {
      const next = new Set(current)
      next.delete(group.id)
      return next
    })
    void saveDocumentLayout({
      version: 1,
      items,
      groups: documentLayout.groups.filter((candidate) => candidate.id !== group.id),
    }, '문서 그룹 삭제됨')
  }

  const completeDocument = async (mapId: string) => {
    if (mode !== 'editor') return
    if (!window.confirm('이 문서의 모든 노드와 체크리스트를 완료 처리할까요?')) return
    setDocumentContextMenu(null)
    setSaveError('')

    try {
      const sourceMap = mapId === activeMapId && loadedMapId === activeMapId
        ? { nodes, edges, version: serverBaseline.current?.version }
        : (await apiRequest<{ map: MapDocument }>(`/api/maps/${encodeURIComponent(mapId)}`)).map
      const completedNodes = sourceMap.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          progress: 100,
          status: 'done' as const,
          checklist: node.data.checklist?.map((item) => ({ ...item, done: true })),
          waitingItems: [],
        },
      }))
      const result = await apiRequest<{ map: MapDocument; summary: MapSummary }>(`/api/maps/${encodeURIComponent(mapId)}`, {
        method: 'PUT',
        body: JSON.stringify({ map: { nodes: completedNodes, edges: sourceMap.edges }, baseVersion: sourceMap.version }),
      })
      setDocuments((current) => current.map((document) => document.id === result.summary.id ? result.summary : document))
      if (mapId === activeMapId) {
        serverBaseline.current = structuredClone(result.map)
        setNodes(completedNodes)
        setEdges(sourceMap.edges)
      }
      setSavedAt('전체 완료됨')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '문서를 완료 처리하지 못했습니다.')
    }
  }

  const trashDocument = async (mapId: string) => {
    if (mode !== 'editor') return
    const document = documents.find((item) => item.id === mapId)
    if (!document || !window.confirm(`“${document.title}” 문서를 휴지통으로 이동할까요? 휴지통에서 복원할 수 있습니다.`)) return
    setDocumentContextMenu(null)
    setSaveError('')

    try {
      const result = await apiRequest<{ trashedId: string; maps: MapSummary[]; documentLayout: DocumentLayout; trash: MapSummary[] }>(`/api/maps/${encodeURIComponent(mapId)}`, { method: 'DELETE' })
      setDocuments(result.maps)
      setDocumentLayout(result.documentLayout)
      setTrashedDocuments(result.trash)
      if (mapId === activeMapId) {
        setLoadedMapId(null)
        setActiveMapId(result.maps[0]?.id ?? '')
      }
      setSavedAt('휴지통으로 이동됨')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '문서를 휴지통으로 이동하지 못했습니다.')
    }
  }

  const restoreDocument = async (mapId: string) => {
    if (mode !== 'editor') return
    setSaveError('')
    try {
      const result = await apiRequest<{ maps: MapSummary[]; documentLayout: DocumentLayout; trash: MapSummary[] }>(`/api/maps/${encodeURIComponent(mapId)}/restore`, { method: 'POST' })
      setDocuments(result.maps)
      setDocumentLayout(result.documentLayout)
      setTrashedDocuments(result.trash)
      setSelectedTrashIds((current) => {
        const next = new Set(current)
        next.delete(mapId)
        return next
      })
      setTrashOpen(false)
      setActiveMapId(mapId)
      setSavedAt('문서 복원됨')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '문서를 복원하지 못했습니다.')
    }
  }

  const deleteTrashedDocuments = async (deleteAll = false) => {
    if (mode !== 'editor' || trashDeleting) return
    const mapIds = deleteAll ? trashedDocuments.map((document) => document.id) : [...selectedTrashIds]
    if (mapIds.length === 0) return
    const targetLabel = deleteAll ? `휴지통의 문서 ${mapIds.length}개를 모두` : `선택한 문서 ${mapIds.length}개를`
    if (!window.confirm(`${targetLabel} 영구 삭제할까요?\n\n문서, 댓글, 변경 이력이 함께 삭제되며 이 작업은 되돌릴 수 없습니다.`)) return

    setTrashDeleting(true)
    setSaveError('')
    try {
      const result = await apiRequest<{ deletedIds: string[]; trash: MapSummary[] }>('/api/maps/trash', {
        method: 'DELETE',
        body: JSON.stringify(deleteAll ? { all: true } : { mapIds }),
      })
      setTrashedDocuments(result.trash)
      setSelectedTrashIds(new Set())
      setSavedAt(deleteAll ? '휴지통 비움' : `${result.deletedIds.length}개 문서 영구 삭제됨`)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '휴지통 문서를 영구 삭제하지 못했습니다.')
    } finally {
      setTrashDeleting(false)
    }
  }

  const openDocumentContextMenu = (event: ReactMouseEvent, mapId: string) => {
    if (mode !== 'editor') return
    event.preventDefault()
    event.stopPropagation()
    setNodeContextMenu(null)
    setAiConversationContextMenu(null)
    setDocumentContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 335)),
      mapId,
    })
  }

  const shareCursorPosition = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!activeMapId || viewMode !== 'mindmap') return
    const now = Date.now()
    if (now - cursorSendAt.current < 80) return
    cursorSendAt.current = now
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    void apiRequest('/api/presence/cursor', {
      method: 'POST',
      body: JSON.stringify({ mapId: activeMapId, x: position.x, y: position.y }),
    }).catch(() => undefined)
  }, [activeMapId, screenToFlowPosition, viewMode])

  const submitComment = async () => {
    const text = newComment.trim()
    if (!selectedCommentMapId || !selectedCommentNodeId || !text) return
    setCommentError('')
    try {
      const result = await apiRequest<{ comment: NodeComment }>(`/api/maps/${encodeURIComponent(selectedCommentMapId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ nodeId: selectedCommentNodeId, text, parentId: replyTarget?.id ?? null }),
      })
      setComments((current) => current.some((comment) => comment.id === result.comment.id) ? current : [...current, result.comment])
      setNewComment('')
      setReplyTarget(null)
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : '댓글을 등록하지 못했습니다.')
    }
  }

  const deleteComment = async (comment: NodeComment) => {
    const replyCount = comments.filter((item) => item.parentId === comment.id).length
    if (!window.confirm(replyCount > 0 ? `댓글과 답글 ${replyCount}개를 모두 삭제할까요?` : '이 댓글을 삭제할까요?')) return
    setCommentError('')
    try {
      const result = await apiRequest<{ deletedIds: string[] }>(`/api/maps/${encodeURIComponent(comment.mapId)}/comments/${encodeURIComponent(comment.id)}`, { method: 'DELETE' })
      setComments((current) => current.filter((item) => !result.deletedIds.includes(item.id)))
      if (replyTarget && result.deletedIds.includes(replyTarget.id)) setReplyTarget(null)
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : '댓글을 삭제하지 못했습니다.')
    }
  }

  const toggleCommentResolved = async (comment: NodeComment) => {
    setCommentError('')
    try {
      const result = await apiRequest<{ comment: NodeComment }>(`/api/maps/${encodeURIComponent(comment.mapId)}/comments/${encodeURIComponent(comment.id)}/resolve`, {
        method: 'PATCH',
        body: JSON.stringify({ resolved: !comment.resolvedAt }),
      })
      setComments((current) => current.map((item) => item.id === result.comment.id ? result.comment : item))
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : '댓글 해결 상태를 변경하지 못했습니다.')
    }
  }

  const toggleCommentReaction = async (comment: NodeComment, emoji: CommentReaction) => {
    setCommentError('')
    try {
      const result = await apiRequest<{ comment: NodeComment }>(`/api/maps/${encodeURIComponent(comment.mapId)}/comments/${encodeURIComponent(comment.id)}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      })
      setComments((current) => current.map((item) => item.id === result.comment.id ? result.comment : item))
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : '댓글 반응을 변경하지 못했습니다.')
    }
  }

  const insertMention = (collaborator: AuthUser) => {
    setNewComment((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${collaborator.name} `)
  }

  const markNotificationRead = async (notification: UserNotification) => {
    if (notification.readAt) return
    const readAt = new Date().toISOString()
    setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt } : item))
    try {
      await apiRequest(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: 'PATCH' })
    } catch {
      setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, readAt: null } : item))
    }
  }

  const openNotification = (notification: UserNotification) => {
    void markNotificationRead(notification)
    pendingSelection.current = notification.nodeId
    setViewMode('mindmap')
    setTrashOpen(false)
    setNotificationsOpen(false)
    if (notification.mapId === activeMapId) setSelectedId(notification.nodeId)
    else setActiveMapId(notification.mapId)
  }

  const copySelectedNodeLink = async () => {
    if (!activeMapId || !selectedId) return
    const path = [viewMode, activeMapId, selectedId].map((segment) => encodeURIComponent(segment)).join('/')
    try {
      const health = await apiRequest<{ publicBaseUrl: string }>('/api/health')
      const publicBaseUrl = health.publicBaseUrl?.replace(/\/+$/, '')
      if (!publicBaseUrl) throw new Error('공개 접근 주소를 확인하지 못했습니다.')
      await copyTextToClipboard(`${publicBaseUrl}/${path}`)
      setNodeLinkCopyStatus('copied')
    } catch {
      setNodeLinkCopyStatus('failed')
    }
    if (nodeLinkCopyTimer.current !== null) window.clearTimeout(nodeLinkCopyTimer.current)
    nodeLinkCopyTimer.current = window.setTimeout(() => setNodeLinkCopyStatus('idle'), 1_800)
  }

  const markAllNotificationsRead = async () => {
    const readAt = new Date().toISOString()
    setNotifications((current) => current.map((notification) => ({ ...notification, readAt: notification.readAt ?? readAt })))
    try {
      const result = await apiRequest<{ notifications: UserNotification[] }>('/api/notifications/read-all', { method: 'POST' })
      setNotifications(result.notifications)
    } catch {
      const result = await apiRequest<{ notifications: UserNotification[] }>('/api/notifications').catch(() => null)
      if (result) setNotifications(result.notifications)
    }
  }

  const onSelectionChange = useCallback(({ nodes: selected }: OnSelectionChangeParams<MindMapNode, MindMapEdge>) => {
    const currentSelectedId = selectedIdRef.current
    if (currentSelectedId && selected.some((node) => node.id === currentSelectedId)) return

    setSelectedId(selected.at(-1)?.id ?? null)
  }, [])

  const onNodeClick = useCallback((_event: ReactMouseEvent, node: MindMapNode) => {
    setSelectedId(node.id)
  }, [])

  const onNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, draggedNode: MindMapNode) => {
    beginHistoryTransaction()
    dropTargetIdRef.current = null
    setDropTargetId(null)
    const descendantIds = new Set<string>()
    const pendingIds = [draggedNode.id]

    while (pendingIds.length > 0) {
      const parentId = pendingIds.shift()
      if (!parentId) continue

      for (const edge of hierarchyEdges) {
        if (edge.source !== parentId || descendantIds.has(edge.target) || edge.target === draggedNode.id) continue
        descendantIds.add(edge.target)
        pendingIds.push(edge.target)
      }
    }

    const descendantPositions = new Map<string, { x: number; y: number }>()
    const selectedPositions = new Map<string, { x: number; y: number }>()
    const draggedNodeIsSelected = draggedNode.selected
      || nodes.some((node) => node.id === draggedNode.id && node.selected)

    for (const node of nodes) {
      if (descendantIds.has(node.id)) {
        descendantPositions.set(node.id, { ...node.position })
      }
      if (draggedNodeIsSelected && node.selected && node.id !== draggedNode.id) {
        selectedPositions.set(node.id, { ...node.position })
      }
    }

    dragSnapshot.current = {
      rootId: draggedNode.id,
      rootPosition: { ...draggedNode.position },
      descendantPositions,
      selectedPositions,
    }
  }, [beginHistoryTransaction, hierarchyEdges, nodes])

  const onNodeDrag = useCallback((event: MouseEvent | TouchEvent, draggedNode: MindMapNode) => {
    const snapshot = dragSnapshot.current
    if (!snapshot || snapshot.rootId !== draggedNode.id) return

    const draggedPosition = event.altKey ? snapMindMapPosition(draggedNode.position) : draggedNode.position
    const deltaX = draggedPosition.x - snapshot.rootPosition.x
    const deltaY = draggedPosition.y - snapshot.rootPosition.y

    setNodes((current) => current.map((node) => {
      if (node.id === draggedNode.id) {
        return { ...node, position: { ...draggedPosition } }
      }

      const initialPosition = snapshot.descendantPositions.get(node.id)
        ?? (event.altKey ? snapshot.selectedPositions.get(node.id) : undefined)
      if (!initialPosition) return node

      return {
        ...node,
        position: {
          x: initialPosition.x + deltaX,
          y: initialPosition.y + deltaY,
        },
      }
    }))

    const draggedWidth = draggedNode.measured?.width ?? draggedNode.width ?? 218
    const draggedHeight = draggedNode.measured?.height ?? draggedNode.height ?? 112
    const center = {
      x: draggedPosition.x + draggedWidth / 2,
      y: draggedPosition.y + draggedHeight / 2,
    }
    const currentParentId = hierarchyEdges.find((edge) => edge.target === draggedNode.id)?.source
    const invalidTargetIds = new Set([
      draggedNode.id,
      ...snapshot.descendantPositions.keys(),
      ...snapshot.selectedPositions.keys(),
    ])
    const target = nodes
      .filter((node) => !invalidTargetIds.has(node.id) && node.id !== currentParentId && !node.hidden)
      .filter((node) => {
        const width = node.measured?.width ?? node.width ?? 218
        const height = node.measured?.height ?? node.height ?? 112
        return center.x >= node.position.x
          && center.x <= node.position.x + width
          && center.y >= node.position.y
          && center.y <= node.position.y + height
      })
      .sort((first, second) => {
        const firstX = first.position.x + (first.measured?.width ?? first.width ?? 218) / 2
        const firstY = first.position.y + (first.measured?.height ?? first.height ?? 112) / 2
        const secondX = second.position.x + (second.measured?.width ?? second.width ?? 218) / 2
        const secondY = second.position.y + (second.measured?.height ?? second.height ?? 112) / 2
        return Math.hypot(center.x - firstX, center.y - firstY) - Math.hypot(center.x - secondX, center.y - secondY)
      })[0]
    const nextTargetId = target?.id ?? null
    if (dropTargetIdRef.current !== nextTargetId) {
      dropTargetIdRef.current = nextTargetId
      setDropTargetId(nextTargetId)
    }
    setSavedAt('저장 중…')
  }, [hierarchyEdges, nodes, setNodes])

  const onNodeDragStop = useCallback((event: MouseEvent | TouchEvent, draggedNode: MindMapNode) => {
    const snapshot = dragSnapshot.current
    const targetId = dropTargetIdRef.current
    const draggedPosition = event.altKey ? snapMindMapPosition(draggedNode.position) : draggedNode.position

    if (snapshot && targetId) {
      const target = nodes.find((node) => node.id === targetId)
      if (target) {
        const childCount = hierarchyEdges.filter((edge) => edge.source === targetId && edge.target !== draggedNode.id).length
        const automaticPosition = {
          x: target.position.x + 320,
          y: target.position.y + childCount * 150 - 40,
        }
        const desiredPosition = event.altKey ? snapMindMapPosition(automaticPosition) : automaticPosition
        const rootDelta = {
          x: desiredPosition.x - snapshot.rootPosition.x,
          y: desiredPosition.y - snapshot.rootPosition.y,
        }
        const descendantIds = new Set(snapshot.descendantPositions.keys())

        setNodes((current) => current.map((node) => {
          if (node.id === draggedNode.id) return { ...node, position: desiredPosition }
          if (!descendantIds.has(node.id)) return node
          const initialPosition = snapshot.descendantPositions.get(node.id)
          if (!initialPosition) return node
          return {
            ...node,
            position: {
              x: initialPosition.x + rootDelta.x,
              y: initialPosition.y + rootDelta.y,
            },
          }
        }))
        setEdges((current) => [
          ...current.filter((edge) => !isHierarchyEdge(edge) || edge.target !== draggedNode.id),
          {
            id: `edge-${targetId}-${draggedNode.id}-${Date.now()}`,
            source: targetId,
            target: draggedNode.id,
            type: 'bezier',
            data: { relation: 'hierarchy' },
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          },
        ])
        setSelectedId(draggedNode.id)
        setSavedAt('부모 노드 변경됨')
      }
    } else if (snapshot && event.altKey) {
      const deltaX = draggedPosition.x - snapshot.rootPosition.x
      const deltaY = draggedPosition.y - snapshot.rootPosition.y
      setNodes((current) => current.map((node) => {
        if (node.id === draggedNode.id) return { ...node, position: draggedPosition }
        const initialPosition = snapshot.descendantPositions.get(node.id)
          ?? snapshot.selectedPositions.get(node.id)
        return initialPosition ? {
          ...node,
          position: { x: initialPosition.x + deltaX, y: initialPosition.y + deltaY },
        } : node
      }))
    }

    dragSnapshot.current = null
    dropTargetIdRef.current = null
    setDropTargetId(null)
    endHistoryTransaction()
  }, [endHistoryTransaction, hierarchyEdges, nodes, setEdges, setNodes])

  const renderDocumentListItem = (document: MapSummary, location: { type: 'top'; item: DocumentLayoutItem } | { type: 'group'; groupId: string }) => {
    const hasLoadedActiveDocument = document.id === activeMapId && loadedMapId === activeMapId
    const rootProgress = hasLoadedActiveDocument ? activeRootState.progress : document.rootProgress
    const rootStatus = hasLoadedActiveDocument ? activeRootState.status : document.rootStatus
    const nodeCount = hasLoadedActiveDocument ? nodes.length : document.nodeCount
    const waitingCount = hasLoadedActiveDocument
      ? nodes.reduce((count, node) => count + (node.data.waitingItems ?? []).filter((item) => item.label.trim()).length, 0)
      : document.waitingCount
    const dropKey = location.type === 'top' ? `top-map:${document.id}` : `group-map:${location.groupId}:${document.id}`

    return (
      <button
        key={document.id}
        draggable={mode === 'editor' && !normalizedDocumentSearch}
        className={`map-item ${location.type === 'group' ? 'group-document' : ''} ${document.id === activeMapId ? 'active' : ''} ${rootStatus === 'planned' ? 'root-planned' : ''} ${draggingLibraryItem?.type === 'map' && draggingLibraryItem.id === document.id ? 'dragging' : ''} ${documentDropTargetId === dropKey ? 'document-drop-target' : ''}`}
        onClick={() => { setRenamingMap(false); setActiveMapId(document.id) }}
        onContextMenu={(event) => openDocumentContextMenu(event, document.id)}
        onDragStart={(event) => {
          if (mode !== 'editor' || normalizedDocumentSearch) return
          const item: DocumentLayoutItem = { type: 'map', id: document.id }
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-mindnprogress-library', JSON.stringify(item))
          setDraggingLibraryItem(item)
        }}
        onDragOver={(event) => {
          if (mode !== 'editor' || !draggingLibraryItem || draggingLibraryItem.type !== 'map' || normalizedDocumentSearch) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDocumentDropTargetId(dropKey)
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (!draggingLibraryItem) return
          if (location.type === 'group') {
            moveLibraryItem(draggingLibraryItem, { type: 'group', groupId: location.groupId, targetMapId: document.id })
          } else {
            moveLibraryItem(draggingLibraryItem, { type: 'top', target: location.item })
          }
        }}
        onDragEnd={() => { setDraggingLibraryItem(null); setDocumentDropTargetId(null) }}
      >
        <span className="map-dot" style={documentColorStyle(document.color, documents.findIndex((candidate) => candidate.id === document.id))} />
        <span>
          <strong>{document.title}</strong>
          <small>
            <span>{nodeCount}개 항목</span>
            {rootProgress !== null && (
              <span className={`map-root-progress ${rootProgress === 100 ? 'complete' : ''}`}>
                {rootProgress}%
              </span>
            )}
            {waitingCount > 0 && (
              <span className="map-waiting-indicator" title={`대기 항목 ${waitingCount}건`} aria-label={`대기 항목 ${waitingCount}건`}>⏸️</span>
            )}
          </small>
        </span>
        {document.id === activeMapId && <Icon name="chevron" size={15} />}
      </button>
    )
  }

  return (
    <div className={`app-shell ${resizingSidebar ? 'resizing-sidebar' : ''} ${resizingInspector ? 'resizing-inspector' : ''}`}>
      <header className="topbar">
        <div className="brand-mark"><Icon name="map" size={20} /></div>
        <div className="brand-copy">
          <strong>Mind & Progress</strong>
          <span>Workspace</span>
        </div>
        <div className="topbar-divider" />
        <div className="document-title">
          {renamingMap ? (
            <form className="rename-form" onSubmit={(event) => { event.preventDefault(); void renameActiveMap() }}>
              <input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} maxLength={80} autoFocus />
              <button type="submit" aria-label="이름 변경 완료"><Icon name="check" size={14} /></button>
              <button type="button" onClick={() => setRenamingMap(false)} aria-label="이름 변경 취소"><Icon name="close" size={13} /></button>
            </form>
          ) : (
            <div className="document-title-row">
              <span>{activeDocument?.title ?? '마인드맵 선택'}</span>
              {mode === 'editor' && activeDocument && (
                <button onClick={() => { setRenameTitle(activeDocument.title); setRenamingMap(true) }} aria-label="문서 이름 변경">
                  <Icon name="edit" size={13} />
                </button>
              )}
            </div>
          )}
          <small className={saveError ? 'save-error' : ''}>{saveError || savedAt}</small>
        </div>
        <nav className="view-switcher" aria-label="업무 보기 전환">
          {([
            ['mindmap', 'map', '마인드맵'],
            ['kanban', 'board', '칸반'],
            ['timeline', 'timeline', '타임라인'],
            ['dashboard', 'chart', '대시보드'],
          ] as const).map(([id, icon, label]) => (
            <button
              key={id}
              className={viewMode === id ? 'active' : ''}
              onClick={() => {
                if (id !== 'mindmap' && selectedNode && !selectedNode.data.isWork) setSelectedId(null)
                setViewMode(id)
                if (id === 'mindmap') window.setTimeout(() => fitView({ padding: 0.2, duration: 400 }), 0)
              }}
              aria-pressed={viewMode === id}
              title={label}
            >
              <Icon name={icon} size={14} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-actions">
          {user.role === 'admin' && (
            <button className={`admin-panel-trigger ${adminOpen ? 'active' : ''}`} onClick={() => { setAdminOpen((current) => !current); setNotificationsOpen(false) }} title="편집자 계정 관리">
              <Icon name="users" size={15} /><span>계정 관리</span>
            </button>
          )}
          {mode === 'editor' && (
            <div className="history-controls" aria-label="실행 취소와 다시 실행">
              <button onClick={undo} disabled={!canUndo} title="실행 취소 (Ctrl+Z)" aria-label="실행 취소"><Icon name="undo" size={15} /></button>
              <button onClick={redo} disabled={!canRedo} title="다시 실행 (Ctrl+Y)" aria-label="다시 실행"><Icon name="redo" size={15} /></button>
            </div>
          )}
          <button className="icon-button" onClick={() => { void openMapHistory() }} disabled={!activeMapId} aria-label="서버 변경 이력" title="서버 변경 이력">
            <Icon name="history" size={16} />
          </button>
          {!user.publicAccess && <div className="notification-center">
            <button className="icon-button notification-trigger" onClick={() => setNotificationsOpen((current) => !current)} aria-label={`알림 ${unreadNotificationCount}개`} title="알림">
              <Icon name="bell" size={16} />
              {unreadNotificationCount > 0 && <span>{unreadNotificationCount > 99 ? '99+' : unreadNotificationCount}</span>}
            </button>
            {notificationsOpen && (
              <div className="notification-popover">
                <header><div><span>내 알림</span><strong>알림</strong></div>{unreadNotificationCount > 0 && <button onClick={() => { void markAllNotificationsRead() }}>모두 읽음</button>}</header>
                <div className="notification-list">
                  {notifications.slice(0, 30).map((notification) => (
                    <button className={`notification-item ${notification.type} ${notification.readAt ? '' : 'unread'}`} key={notification.id} onClick={() => openNotification(notification)}>
                      <span className="notification-avatar">{notification.actor.name.replace(/\s/g, '').slice(0, 2)}</span>
                      <span>
                        <strong>{notification.type === 'assignment'
                          ? `${notification.actor.name}님이 담당자로 지정했습니다.`
                          : notification.type === 'schedule'
                            ? '담당 업무 일정 알림'
                            : notification.type === 'mention'
                              ? `${notification.actor.name}님이 회원님을 멘션했습니다.`
                              : notification.type === 'reply'
                                ? `${notification.actor.name}님이 답글을 남겼습니다.`
                                : `${notification.actor.name}님이 댓글을 남겼습니다.`}</strong>
                        <small>{notification.mapTitle} · {notification.nodeLabel}</small>
                        <em>{notification.message}</em>
                        <time>{new Date(notification.createdAt).toLocaleString('ko-KR')}</time>
                      </span>
                      {!notification.readAt && <i />}
                    </button>
                  ))}
                  {notifications.length === 0 && <div className="empty-notifications"><Icon name="bell" size={22} /><span>새로운 알림이 없습니다.</span></div>}
                </div>
              </div>
            )}
          </div>}
          {activeMapId && (
            <div className="presence-summary" title={presenceClients.map((client) => client.user.name).join(', ')}>
              <div className="presence-avatars">
                {presenceClients.slice(0, 3).map((client) => (
                  <span key={client.clientId} style={{ '--presence-color': presenceColor(client.clientId) } as CSSProperties}>
                    {client.user.name.replace(/\s/g, '').slice(0, 2)}
                  </span>
                ))}
              </div>
              <small>{presenceClients.length || 1}명 접속</small>
            </div>
          )}
          <div className={`role-badge ${user.role}`}>
            <span className={`access-dot ${user.role}`} />
            {user.role === 'admin' ? '관리자' : mode === 'editor' ? '편집자' : '뷰어'}
          </div>
          <button className="share-button" onClick={() => window.alert('공유 기능은 현재 준비 중입니다.')}><Icon name="share" size={16} />공유</button>
          <div className="account-menu-wrap">
            <button className="user-menu" onClick={() => setAccountMenuOpen((current) => !current)} title={`${user.email} · 계정 메뉴`} aria-expanded={accountMenuOpen}>
              <span className="avatar">{user.name.replace(/\s/g, '').slice(0, 2)}</span>
              <span><strong>{user.name}</strong><small>계정 메뉴</small></span>
              <Icon name="chevron-down" size={12} />
            </button>
            {accountMenuOpen && (
              <div className="account-popover">
                <div className="account-summary"><strong>{user.name}</strong><span>{user.email}</span></div>
                {!user.publicAccess && <button onClick={() => { setAccountMenuOpen(false); setPasswordDialogOpen(true) }}><Icon name="lock" size={14} /><span>비밀번호 변경</span></button>}
                <button className="account-logout" onClick={onLogout}><Icon name="logout" size={14} /><span>{user.publicAccess ? '로그인 화면으로 이동' : '로그아웃'}</span></button>
              </div>
            )}
          </div>
        </div>
      </header>

      {adminOpen && user.role === 'admin' && <AdminEditorPanel onClose={closeAdminPanel} />}
      {passwordDialogOpen && !user.publicAccess && <PasswordChangeDialog onClose={() => setPasswordDialogOpen(false)} />}

      {externalChange && (
        <div className="external-change-banner" role="status">
          <span><Icon name="history" size={15} /><strong>{externalChange.updatedBy.name}</strong>님이 이 문서를 변경했습니다.</span>
          <button onClick={() => setMapReloadToken((current) => current + 1)}>변경 내용 불러오기</button>
          <button className="banner-close" onClick={() => setExternalChange(null)} aria-label="알림 닫기"><Icon name="close" size={13} /></button>
        </div>
      )}
      {mergeNotice && (
        <div className="merge-notice" role="status">
          <Icon name="check" size={15} /><span>{mergeNotice}</span>
          <button onClick={() => setMergeNotice('')} aria-label="병합 알림 닫기"><Icon name="close" size={12} /></button>
        </div>
      )}

      <main
        className="workspace"
        style={{
          '--sidebar-width': `${sidebarWidth}px`,
          '--inspector-width': `${inspectorWidth}px`,
        } as CSSProperties}
      >
        <aside className="sidebar">
          <div className="sidebar-header">
            <span>{trashOpen ? '휴지통' : '마인드맵'} <small>{trashOpen ? trashedDocuments.length : documents.length}</small></span>
            {mode === 'editor' && !trashOpen && (
              <div className="sidebar-create-actions">
                <button
                  aria-label="새 문서 그룹"
                  title="새 문서 그룹"
                  onClick={() => { setCreatingGroup((current) => !current); setCreatingMap(false) }}
                >
                  <Icon name="folder" size={15} />
                </button>
                <button
                  aria-label="새 마인드맵"
                  title="새 마인드맵"
                  onClick={() => { setCreatingMap((current) => !current); setCreatingGroup(false) }}
                >
                  <Icon name={creatingMap ? 'close' : 'plus'} size={16} />
                </button>
              </div>
            )}
          </div>
          {!trashOpen ? (
            <>
              <label className="search-box">
                <Icon name="search" size={16} />
                <input placeholder="문서 검색" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} />
              </label>
              {creatingMap && (
                <form className="new-map-form" onSubmit={(event) => { event.preventDefault(); void createMap() }}>
                  <input value={newMapTitle} onChange={(event) => setNewMapTitle(event.target.value)} placeholder="새 마인드맵 이름" maxLength={80} autoFocus />
                  <button type="submit" disabled={!newMapTitle.trim()}><Icon name="plus" size={14} />생성</button>
                </form>
              )}
              {creatingGroup && (
                <form className="new-map-form new-group-form" onSubmit={(event) => { event.preventDefault(); createDocumentGroup() }}>
                  <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="새 그룹 이름" maxLength={80} autoFocus />
                  <button type="submit" disabled={!newGroupName.trim()}><Icon name="folder" size={14} />그룹 생성</button>
                </form>
              )}
              <nav className="map-list">
                {mode === 'editor' && draggingLibraryItem && !normalizedDocumentSearch && effectiveDocumentLayout.items.length > 0 && (
                  <div
                    className={`library-top-insertion-target ${documentDropTargetId === 'top-start' ? 'active' : ''}`}
                    title="목록 처음으로 이동"
                    onDragOver={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      event.dataTransfer.dropEffect = 'move'
                      setDocumentDropTargetId('top-start')
                    }}
                    onDragLeave={() => setDocumentDropTargetId((current) => current === 'top-start' ? null : current)}
                    onDrop={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      moveLibraryItem(draggingLibraryItem, { type: 'top', target: effectiveDocumentLayout.items[0] })
                    }}
                  />
                )}
                {effectiveDocumentLayout.items.map((layoutItem, layoutIndex) => {
                  if (layoutItem.type === 'map') {
                    const document = documentsById.get(layoutItem.id)
                    if (!document || !document.title.toLowerCase().includes(normalizedDocumentSearch)) return null
                    return (
                      <div className="library-top-item" key={`map-${layoutItem.id}`}>
                        {mode === 'editor' && !normalizedDocumentSearch && (
                          <div
                            className={`library-drop-line ${documentDropTargetId === `top-before:map:${layoutItem.id}` ? 'active' : ''}`}
                            title={layoutIndex === 0 ? '목록 처음으로 이동' : '이 위치로 이동'}
                            onDragOver={(event) => {
                              if (!draggingLibraryItem) return
                              event.preventDefault()
                              setDocumentDropTargetId(`top-before:map:${layoutItem.id}`)
                            }}
                            onDrop={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              if (draggingLibraryItem) moveLibraryItem(draggingLibraryItem, { type: 'top', target: layoutItem })
                            }}
                          />
                        )}
                        {renderDocumentListItem(document, { type: 'top', item: layoutItem })}
                      </div>
                    )
                  }

                  const group = effectiveDocumentLayout.groups.find((candidate) => candidate.id === layoutItem.id)
                  if (!group) return null
                  const groupNameMatches = group.name.toLowerCase().includes(normalizedDocumentSearch)
                  const groupDocuments = group.mapIds.map((mapId) => documentsById.get(mapId)).filter((document): document is MapSummary => Boolean(document))
                  const visibleGroupDocuments = normalizedDocumentSearch && !groupNameMatches
                    ? groupDocuments.filter((document) => document.title.toLowerCase().includes(normalizedDocumentSearch))
                    : groupDocuments
                  if (normalizedDocumentSearch && !groupNameMatches && visibleGroupDocuments.length === 0) return null
                  const collapsed = !normalizedDocumentSearch && collapsedDocumentGroupIds.has(group.id)
                  const groupDropKey = `group:${group.id}`
                  return (
                    <section
                      className={`document-group ${collapsed ? 'collapsed' : ''}`}
                      key={`group-${group.id}`}
                      onDragOver={(event) => {
                        if (draggingLibraryItem?.type !== 'group' || normalizedDocumentSearch) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        setDocumentDropTargetId(groupDropKey)
                      }}
                      onDrop={(event) => {
                        if (draggingLibraryItem?.type !== 'group') return
                        event.preventDefault()
                        moveLibraryItem(draggingLibraryItem, { type: 'top', target: layoutItem })
                      }}
                    >
                      {mode === 'editor' && !normalizedDocumentSearch && (
                        <div
                          className={`library-drop-line ${documentDropTargetId === `top-before:group:${group.id}` ? 'active' : ''}`}
                          title={layoutIndex === 0 ? '목록 처음으로 이동' : '이 위치로 이동'}
                          onDragOver={(event) => {
                            if (!draggingLibraryItem) return
                            event.preventDefault()
                            event.stopPropagation()
                            setDocumentDropTargetId(`top-before:group:${group.id}`)
                          }}
                          onDrop={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            if (draggingLibraryItem) moveLibraryItem(draggingLibraryItem, { type: 'top', target: layoutItem })
                          }}
                        />
                      )}
                      <div
                        className={`document-group-header ${draggingLibraryItem?.type === 'group' && draggingLibraryItem.id === group.id ? 'dragging' : ''} ${documentDropTargetId === groupDropKey ? 'document-drop-target' : ''}`}
                        draggable={mode === 'editor' && !normalizedDocumentSearch}
                        onDragStart={(event) => {
                          const item: DocumentLayoutItem = { type: 'group', id: group.id }
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('application/x-mindnprogress-library', JSON.stringify(item))
                          setDraggingLibraryItem(item)
                        }}
                        onDragOver={(event) => {
                          if (!draggingLibraryItem || normalizedDocumentSearch) return
                          if (draggingLibraryItem.type === 'group') return
                          event.preventDefault()
                          setDocumentDropTargetId(groupDropKey)
                        }}
                        onDrop={(event) => {
                          if (draggingLibraryItem?.type !== 'map') return
                          event.preventDefault()
                          event.stopPropagation()
                          moveLibraryItem(draggingLibraryItem, { type: 'group', groupId: group.id })
                        }}
                        onDragEnd={() => { setDraggingLibraryItem(null); setDocumentDropTargetId(null) }}
                      >
                        <button
                          type="button"
                          className="document-group-toggle"
                          onClick={() => setCollapsedDocumentGroupIds((current) => {
                            const next = new Set(current)
                            if (next.has(group.id)) next.delete(group.id)
                            else next.add(group.id)
                            return next
                          })}
                          aria-expanded={!collapsed}
                        >
                          <Icon name={collapsed ? 'chevron' : 'chevron-down'} size={12} />
                          <Icon name="folder" size={14} />
                          <span className="document-group-label">
                            <strong>{group.name}</strong>
                            <span className="document-group-count">{group.mapIds.length}</span>
                          </span>
                        </button>
                        {mode === 'editor' && (
                          <div className="document-group-actions">
                            <button type="button" onClick={() => renameDocumentGroup(group)} aria-label={`${group.name} 이름 변경`}><Icon name="edit" size={11} /></button>
                            <button type="button" onClick={() => deleteDocumentGroup(group)} aria-label={`${group.name} 그룹 삭제`}><Icon name="close" size={11} /></button>
                          </div>
                        )}
                      </div>
                      {!collapsed && (
                        <div className="document-group-items">
                          {visibleGroupDocuments.map((document) => renderDocumentListItem(document, { type: 'group', groupId: group.id }))}
                          {visibleGroupDocuments.length === 0 && <div className="empty-document-group">문서를 이 그룹으로 드래그하세요.</div>}
                        </div>
                      )}
                    </section>
                  )
                })}
                {mode === 'editor' && !normalizedDocumentSearch && effectiveDocumentLayout.items.length > 0 && (
                  <div
                    className={`library-drop-boundary library-drop-end ${documentDropTargetId === 'top-end' ? 'active' : ''}`}
                    onDragOver={(event) => {
                      if (!draggingLibraryItem) return
                      event.preventDefault()
                      setDocumentDropTargetId('top-end')
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (draggingLibraryItem) moveLibraryItem(draggingLibraryItem, { type: 'top' })
                    }}
                  >목록 끝으로 이동</div>
                )}
                {filteredDocuments.length === 0 && !effectiveDocumentLayout.groups.some((group) => group.name.toLowerCase().includes(normalizedDocumentSearch)) && (
                  <div className="empty-map-list">{documents.length === 0 ? '생성된 마인드맵이 없습니다.' : '검색 결과가 없습니다.'}</div>
                )}
              </nav>
            </>
          ) : (
            <section className="trash-list" aria-label="휴지통 문서">
              <p>휴지통의 문서는 일반 목록과 저장 대상에서 제외됩니다. 영구 삭제한 문서는 복원할 수 없습니다.</p>
              {trashedDocuments.length > 0 && mode === 'editor' && (
                <div className="trash-toolbar">
                  <label className="trash-select-all">
                    <input
                      type="checkbox"
                      checked={selectedTrashIds.size === trashedDocuments.length}
                      onChange={(event) => setSelectedTrashIds(event.target.checked
                        ? new Set(trashedDocuments.map((document) => document.id))
                        : new Set())}
                    />
                    전체 선택
                  </label>
                  <button
                    type="button"
                    className="trash-delete-selected"
                    disabled={selectedTrashIds.size === 0 || trashDeleting}
                    onClick={() => { void deleteTrashedDocuments(false) }}
                  >
                    선택 삭제{selectedTrashIds.size > 0 ? ` (${selectedTrashIds.size})` : ''}
                  </button>
                  <button
                    type="button"
                    className="trash-empty-all"
                    disabled={trashDeleting}
                    onClick={() => { void deleteTrashedDocuments(true) }}
                  >
                    전체 비우기
                  </button>
                </div>
              )}
              {trashedDocuments.map((document) => (
                <div className={`trash-item ${selectedTrashIds.has(document.id) ? 'selected' : ''}`} key={document.id}>
                  {mode === 'editor' && (
                    <input
                      className="trash-item-select"
                      type="checkbox"
                      aria-label={`${document.title} 선택`}
                      checked={selectedTrashIds.has(document.id)}
                      disabled={trashDeleting}
                      onChange={(event) => setSelectedTrashIds((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(document.id)
                        else next.delete(document.id)
                        return next
                      })}
                    />
                  )}
                  <span><strong>{document.title}</strong><small>{document.nodeCount}개 항목 · {document.trashedAt ? new Date(document.trashedAt).toLocaleDateString('ko-KR') : ''}</small></span>
                  {mode === 'editor' && <button disabled={trashDeleting} onClick={() => { void restoreDocument(document.id) }} title="문서 복원"><Icon name="restore" size={14} />복원</button>}
                </div>
              ))}
              {trashedDocuments.length === 0 && <div className="empty-map-list">휴지통이 비어 있습니다.</div>}
            </section>
          )}
          {mode === 'editor' && (
            <button className={`sidebar-trash ${trashOpen ? 'active' : ''}`} onClick={() => { setTrashOpen((current) => !current); setCreatingMap(false) }}>
              <span><Icon name="trash" size={15} />휴지통</span><small>{trashedDocuments.length}</small>
            </button>
          )}
          <div className="sidebar-footer">
            <span>현재 보기</span>
            <strong><span className={`access-dot ${mode}`} />{mode === 'editor' ? '편집 가능' : '읽기 전용'}</strong>
          </div>
        </aside>

        <div
          className="sidebar-resizer"
          role="separator"
          aria-label="문서 목록 패널 너비 조절"
          aria-orientation="vertical"
          aria-valuemin={190}
          aria-valuemax={420}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            sidebarResizeStart.current = { pointerX: event.clientX, width: sidebarWidth }
            setResizingSidebar(true)
          }}
          onPointerMove={(event) => {
            if (!resizingSidebar) return
            const centerMinWidth = window.innerWidth <= 1200 ? 500 : 520
            const maxWidth = Math.min(420, Math.max(190, window.innerWidth - inspectorWidth - centerMinWidth))
            const nextWidth = sidebarResizeStart.current.width + event.clientX - sidebarResizeStart.current.pointerX
            setSidebarWidth(Math.min(maxWidth, Math.max(190, nextWidth)))
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            setResizingSidebar(false)
          }}
          onPointerCancel={() => setResizingSidebar(false)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const delta = event.key === 'ArrowLeft' ? -20 : 20
            setSidebarWidth((current) => Math.min(420, Math.max(190, current + delta)))
          }}
        >
          <span />
        </div>

        {viewMode === 'mindmap' ? (
        <section
          className={`canvas-wrap ${rightPanning ? 'right-panning' : ''}`}
          onPointerDownCapture={startNodeRightPan}
          onPointerMove={shareCursorPosition}
        >
          <ReactFlow<MindMapNode, MindMapEdge>
            key={activeMapId}
            nodes={loadedMapId === activeMapId ? flowNodes : []}
            edges={loadedMapId === activeMapId ? flowEdges : []}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeContextMenu={(event, node) => openNodeContextMenu(event, node.id)}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onSelectionChange={onSelectionChange}
            onPaneClick={() => { setSelectedId(null); setNodeContextMenu(null) }}
            onPaneContextMenu={(event) => event.preventDefault()}
            onDoubleClick={(event) => {
              if (mode === 'editor' && (event.target as HTMLElement).classList.contains('react-flow__pane')) {
                addNode(undefined, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
              }
            }}
            nodesDraggable={mode === 'editor'}
            nodesConnectable={mode === 'editor'}
            edgesReconnectable={mode === 'editor'}
            nodeClickDistance={4}
            nodeDragThreshold={4}
            panOnDrag={[0, 1, 2]}
            deleteKeyCode={mode === 'editor' ? ['Backspace', 'Delete'] : null}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.25}
            maxZoom={1.8}
            defaultEdgeOptions={{ style: { strokeWidth: 2, stroke: '#b8b5c7' } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={MINDMAP_GRID_SIZE} size={1.2} color="#d8d6df" />
            <MiniMap
              className="mini-map"
              style={{ width: 160, height: 100 }}
              pannable
              zoomable
              ariaLabel="미니맵 뷰 영역을 드래그하여 화면 이동"
              nodeColor={(node) => (node.data as MindNodeData).progress >= 100 ? '#43b78e' : node.data.kind === 'root' ? '#6657d9' : '#b9b4ef'}
              maskColor="rgba(248, 247, 251, 0.78)"
              maskStrokeColor="#6657d9"
              maskStrokeWidth={2}
            />
            <Controls position="bottom-center" showInteractive={false} />
            <Panel position="top-left" className="canvas-toolbar">
              {mode === 'editor' && (
                <>
                  <button className="primary-tool" onClick={() => addNode()}><Icon name="plus" size={16} />하위 노드 <kbd>Insert</kbd></button>
                  <span className="tool-divider" />
                </>
              )}
              <button onClick={() => fitView({ padding: 0.2, duration: 500 })} title="전체 보기 (Home)" aria-label="전체 보기 (Home)"><Icon name="fit" size={17} /></button>
              {collapsibleNodeIds.size > 0 && (
                <button
                  onClick={() => setCollapsedNodeIds(collapsedNodeIds.size > 0 ? new Set() : new Set(collapsibleNodeIds))}
                  title={collapsedNodeIds.size > 0 ? '모든 가지 펼치기' : '모든 가지 접기'}
                >
                  <Icon name={collapsedNodeIds.size > 0 ? 'expand' : 'collapse'} size={17} />
                </button>
              )}
              {mode === 'editor' && <button onClick={deleteSelected} disabled={!selectedId} title="선택 삭제"><Icon name="trash" size={17} /></button>}
            </Panel>
            <Panel position="top-right" className="node-explorer">
              <label className="node-search-box">
                <Icon name="search" size={14} />
                <input
                  value={nodeSearchTerm}
                  onChange={(event) => setNodeSearchTerm(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    navigateNodeSearch(event.shiftKey ? -1 : 1)
                  }}
                  placeholder="노드 검색"
                  aria-label="노드 제목과 설명 검색"
                />
                {normalizedNodeSearch && <span>{nodeSearchMatches.length > 0 ? `${nodeSearchIndex < 0 ? 1 : nodeSearchIndex + 1}/${nodeSearchMatches.length}` : '0개'}</span>}
                {normalizedNodeSearch && <button type="button" onClick={() => navigateNodeSearch(-1)} disabled={nodeSearchMatches.length === 0} aria-label="이전 검색 결과">‹</button>}
                {normalizedNodeSearch && <button type="button" onClick={() => navigateNodeSearch(1)} disabled={nodeSearchMatches.length === 0} aria-label="다음 검색 결과">›</button>}
                {normalizedNodeSearch && <button type="button" className="node-search-clear" onClick={() => setNodeSearchTerm('')} aria-label="노드 검색 지우기"><Icon name="close" size={11} /></button>}
              </label>
              <select value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value as NodeFilter)} aria-label="업무 상태 필터" title="업무 상태 필터">
                <option value="all">전체 상태</option>
                <option value="work">업무만</option>
                <option value="planned">예정</option>
                <option value="in-progress">진행 중</option>
                <option value="done">완료</option>
                <option value="blocked">차단됨</option>
              </select>
              <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} aria-label="담당자 필터" title="담당자 필터">
                <option value="all">전체 담당자</option>
                <option value="unassigned">담당자 미지정</option>
                {teamMembers.map((member) => <option value={member.id} key={member.id}>{member.name}{member.active ? '' : ' (비활성)'}</option>)}
              </select>
              {filterActive && <button type="button" className="filter-reset" onClick={() => { setNodeFilter('all'); setAssigneeFilter('all') }}>초기화</button>}
            </Panel>
            <Panel position="bottom-right" className="hint-pill">
              {mode === 'editor' ? 'Alt+드래그로 눈금 맞춤 · 우클릭 드래그로 이동 · Insert로 하위 노드 추가' : '우클릭 드래그로 이동 · 읽기 전용'}
            </Panel>
          </ReactFlow>
          <div className="live-cursors" aria-hidden="true">
            {Object.values(liveCursors).map((cursor) => (
              <div
                className="live-cursor"
                key={cursor.sourceClientId ?? cursor.user.id}
                style={{
                  left: cursor.x * viewport.zoom + viewport.x,
                  top: cursor.y * viewport.zoom + viewport.y,
                  '--cursor-color': presenceColor(cursor.sourceClientId ?? cursor.user.id),
                } as CSSProperties}
              >
                <svg width="18" height="22" viewBox="0 0 18 22"><path d="M2 2 15 12l-7 1.5L5 20Z" /></svg>
                <span>{cursor.user.name}</span>
              </div>
            ))}
          </div>
        </section>
        ) : (
          <section className="work-view-wrap">
            {viewMode === 'kanban' && (
              <KanbanView
                nodes={flowNodes}
                mode={mode}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onUpdate={updateNode}
                onOpenMindMap={() => setViewMode('mindmap')}
                onContextMenu={openNodeContextMenu}
                teamMembers={teamMembers}
              />
            )}
            {viewMode === 'timeline' && (
              <TimelineView
                nodes={flowNodes}
                mode={mode}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onUpdate={updateNode}
                onOpenMindMap={() => setViewMode('mindmap')}
                onContextMenu={openNodeContextMenu}
                teamMembers={teamMembers}
              />
            )}
            {viewMode === 'dashboard' && (
              <DashboardView
                nodes={flowNodes}
                documentProgress={activeRootState.progress}
                mode={mode}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onUpdate={updateNode}
                onOpenMindMap={() => setViewMode('mindmap')}
                onContextMenu={openNodeContextMenu}
                teamMembers={teamMembers}
              />
            )}
          </section>
        )}

        <div
          className="inspector-resizer"
          role="separator"
          aria-label="세부정보 패널 너비 조절"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={520}
          aria-valuenow={Math.round(inspectorWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            inspectorResizeStart.current = { pointerX: event.clientX, width: inspectorWidth }
            setResizingInspector(true)
          }}
          onPointerMove={(event) => {
            if (!resizingInspector) return
            const centerMinWidth = window.innerWidth <= 1200 ? 500 : 520
            const maxWidth = Math.min(520, Math.max(240, window.innerWidth - sidebarWidth - centerMinWidth))
            const nextWidth = inspectorResizeStart.current.width + inspectorResizeStart.current.pointerX - event.clientX
            setInspectorWidth(Math.min(maxWidth, Math.max(240, nextWidth)))
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            setResizingInspector(false)
          }}
          onPointerCancel={() => setResizingInspector(false)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const delta = event.key === 'ArrowLeft' ? 20 : -20
            setInspectorWidth((current) => Math.min(520, Math.max(240, current + delta)))
          }}
        >
          <span />
        </div>

        <aside className={`inspector ${selectedNode ? 'open' : ''}`}>
          {selectedNode ? (
            <>
              <div className="inspector-header">
                <div><span>선택한 항목</span><strong>세부 정보</strong></div>
                <div className="inspector-header-actions">
                  <button
                    className={`node-link-copy-button ${nodeLinkCopyStatus}`}
                    onClick={() => { void copySelectedNodeLink() }}
                    aria-label={nodeLinkCopyStatus === 'copied' ? '노드 링크 복사됨' : nodeLinkCopyStatus === 'failed' ? '노드 링크 복사 실패' : '노드 링크 복사'}
                    title={nodeLinkCopyStatus === 'copied' ? '링크가 복사되었습니다' : nodeLinkCopyStatus === 'failed' ? '링크를 복사하지 못했습니다' : '현재 탭의 노드 링크 복사'}
                  >
                    <Icon name={nodeLinkCopyStatus === 'copied' ? 'check' : 'copy'} size={15} />
                  </button>
                  {selectedNode.data.aiConversationId ? (
                    <button
                      className="ai-conversation-button"
                      onClick={() => {
                        if (mode === 'editor') void openAiConversation(selectedNode.data.aiConversationId as string)
                        else showAiEditorOnlyAlert()
                      }}
                      onContextMenu={mode === 'editor' ? openAiConversationContextMenu : undefined}
                      title={mode === 'editor' ? '좌클릭: 기존 대화 열기 · 우클릭: 새 대화 시작' : '편집자만 사용 가능'}
                    >
                      <Icon name="sparkles" size={15} /><span>AI 대화 열기</span>
                    </button>
                  ) : (
                    <button
                      className="ai-conversation-button"
                      onClick={() => {
                        if (mode === 'editor') setAiDialogOpen(true)
                        else showAiEditorOnlyAlert()
                      }}
                      title={mode === 'editor' ? 'AI 대화 시작' : '편집자만 사용 가능'}
                    >
                      <Icon name="sparkles" size={15} /><span>AI 대화 시작</span>
                    </button>
                  )}
                  <button onClick={() => setSelectedId(null)} aria-label="닫기"><Icon name="close" size={17} /></button>
                </div>
              </div>
              <div className="inspector-content">
                {selectedNode.data.reference && (
                  <div className="task-link-field">
                    <div className="field-heading">
                      <span>참조 원본</span>
                      <small>Ref</small>
                    </div>
                    <a
                      className="task-link"
                      href={`${mode === 'viewer' ? '/viewer' : ''}/mindmap/${encodeURIComponent(selectedNode.data.reference.mapId)}/${encodeURIComponent(selectedNode.data.reference.nodeId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="원본 노드를 새 탭에서 열기"
                    >
                      <Icon name="external" size={15} />
                      <span>{documents.find((document) => document.id === selectedNode.data.reference?.mapId)?.title ?? selectedNode.data.reference.mapId}: {selectedNode.data.label.replace(/\s*\(ref\)\s*$/i, '')}</span>
                      <strong>원본 열기</strong>
                    </a>
                  </div>
                )}
                <div className="task-link-field">
                  <div className="field-heading">
                    <span>업무 링크</span>
                    <small>선택사항</small>
                  </div>
                  {mode === 'editor' && (
                    <input
                      type="url"
                      value={selectedNode.data.taskUrl ?? ''}
                      onChange={(event) => updateNode(selectedNode.id, { taskUrl: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        event.currentTarget.blur()
                      }}
                      placeholder="https://example.com/task/123"
                      aria-label="업무 URL"
                    />
                  )}
                  {getOpenableUrl(selectedNode.data.taskUrl) ? (
                    <a
                      className="task-link"
                      href={getOpenableUrl(selectedNode.data.taskUrl) ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={selectedNode.data.taskUrl}
                    >
                      <Icon name="external" size={15} />
                      <span>{selectedNode.data.taskUrl}</span>
                      <strong>열기</strong>
                    </a>
                  ) : (
                    <div className="empty-task-link">
                      {selectedNode.data.taskUrl ? '올바른 웹 URL을 입력해 주세요' : '연결된 업무 링크 없음'}
                    </div>
                  )}
                </div>
                <label>
                  <span>제목</span>
                  <input
                    value={selectedNode.data.label}
                    onChange={(event) => updateNode(selectedNode.id, { label: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                      event.preventDefault()
                      event.currentTarget.blur()
                    }}
                    readOnly={mode === 'viewer'}
                  />
                </label>
                <label className="description-field">
                  <span>업무 설명</span>
                  {mode === 'editor' ? (
                    <>
                      <textarea value={selectedNode.data.description} onChange={(event) => updateNode(selectedNode.id, { description: event.target.value })} rows={3} />
                      {extractTextLinks(selectedNode.data.description).length > 0 && (
                        <div className="description-links">
                          {extractTextLinks(selectedNode.data.description).map((link) => (
                            <a key={`${link.start}-${link.label}`} href={link.href} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /><span>{link.label}</span></a>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="description-rich-text"><LinkifiedText text={selectedNode.data.description} /></div>
                  )}
                </label>
                <section className="shared-knowledge-field">
                  <div className="shared-knowledge-heading">
                    <div>
                      <span>공유 지식</span>
                      <small>다른 카드와 후속 AI 세션에서 재사용할 결정, 제약과 결과를 기록합니다.</small>
                    </div>
                    {selectedNode.data.sharedKnowledgeUpdatedAt && selectedNode.data.sharedKnowledgeUpdatedBy && (
                      <time dateTime={selectedNode.data.sharedKnowledgeUpdatedAt}>
                        {selectedNode.data.sharedKnowledgeUpdatedBy.name} · {new Date(selectedNode.data.sharedKnowledgeUpdatedAt).toLocaleString('ko-KR')}
                      </time>
                    )}
                  </div>
                  {mode === 'editor' ? (
                    <>
                      <textarea
                        value={selectedNode.data.sharedKnowledge ?? ''}
                        onChange={(event) => updateSharedKnowledge(selectedNode.id, event.target.value)}
                        rows={4}
                        maxLength={10_000}
                        placeholder="예: 적용하기로 한 정책, 재사용할 조사 결과, 구현 제약과 사용 방법"
                        aria-label="공유 지식"
                      />
                      {extractTextLinks(selectedNode.data.sharedKnowledge ?? '').length > 0 && (
                        <div className="description-links">
                          {extractTextLinks(selectedNode.data.sharedKnowledge ?? '').map((link) => (
                            <a key={`${link.start}-${link.label}`} href={link.href} target="_blank" rel="noopener noreferrer"><Icon name="external" size={12} /><span>{link.label}</span></a>
                          ))}
                        </div>
                      )}
                    </>
                  ) : selectedNode.data.sharedKnowledge ? (
                    <div className="description-rich-text shared-knowledge-rich-text"><LinkifiedText text={selectedNode.data.sharedKnowledge} /></div>
                  ) : (
                    <div className="empty-shared-knowledge">등록된 공유 지식이 없습니다.</div>
                  )}
                </section>
                <section className="knowledge-block">
                  <div className="knowledge-heading">
                    <div><span>선행 지식</span><small>이 카드를 수행할 때 먼저 활용할 결과를 연결합니다.</small></div>
                    <strong>{selectedKnowledgeEdges.length}</strong>
                  </div>
                  <div className="knowledge-list">
                    {selectedKnowledgeEdges.map((edge) => {
                      const source = nodes.find((node) => node.id === edge.source)
                      if (!source) return null
                      return (
                        <div className={`knowledge-item ${knowledgePolicyOf(edge)}`} key={edge.id}>
                          <div><strong>{source.data.label}</strong><small>{knowledgePolicyOf(edge) === 'reuse-first' ? '주요 지식 · 결과와 댓글을 먼저 활용' : '부족할 때 확인 · 원본 자료는 필요할 때만 조사'}</small></div>
                          {mode === 'editor' && (
                            <div className="knowledge-item-actions">
                              <select
                                value={knowledgePolicyOf(edge)}
                                onChange={(event) => updateKnowledgePolicy(edge.id, event.target.value as KnowledgePolicy)}
                                aria-label={`${source.data.label} 지식 사용 정책`}
                              >
                                <option value="reuse-first">주요 지식</option>
                                <option value="inspect-if-insufficient">부족할 때 확인</option>
                              </select>
                              <button type="button" onClick={() => removeKnowledgeSource(edge.id)} aria-label={`${source.data.label} 지식선 제거`}><Icon name="close" size={11} /></button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {selectedKnowledgeEdges.length === 0 && <div className="empty-knowledge">연결된 선행 지식이 없습니다. 기존 AI 시작 절차를 사용합니다.</div>}
                  </div>
                  {mode === 'editor' && (
                    <form className="knowledge-add" onSubmit={(event) => { event.preventDefault(); addKnowledgeSource() }}>
                      <select value={knowledgeCandidate} onChange={(event) => { setKnowledgeCandidate(event.target.value); setKnowledgeError('') }} aria-label="선행 지식 카드 선택">
                        <option value="">지식 카드 선택</option>
                        {availableKnowledgeSources.map((node) => <option key={node.id} value={node.id}>{node.data.label}</option>)}
                      </select>
                      <select value={knowledgePolicy} onChange={(event) => setKnowledgePolicy(event.target.value as KnowledgePolicy)} aria-label="지식 사용 정책 선택">
                        <option value="reuse-first">주요 지식</option>
                        <option value="inspect-if-insufficient">부족할 때 확인</option>
                      </select>
                      <button type="submit" disabled={!knowledgeCandidate}><Icon name="plus" size={13} />연결</button>
                    </form>
                  )}
                  {knowledgeError && <em>{knowledgeError}</em>}
                </section>
                <label>
                  <span>상태</span>
                  <select
                    value={selectedNode.data.progress >= 100 ? 'done' : selectedNode.data.status}
                    onChange={(event) => {
                      const status = event.target.value as MindNodeData['status']
                      updateNode(selectedNode.id, {
                        status,
                        progress: status === 'done'
                          ? 100
                          : selectedNode.data.progress >= 100 ? 95 : selectedNode.data.progress,
                      })
                    }}
                    disabled={mode === 'viewer'}
                  >
                    <option value="planned">예정</option>
                    <option value="in-progress">진행 중</option>
                    <option value="done">완료</option>
                  </select>
                </label>
                <label className="progress-field">
                  <span>진행률 <strong>{selectedNode.data.progress >= 100 ? '완료' : `${selectedNode.data.progress}%`}</strong></span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="5"
                    value={selectedNode.data.progress}
                    onChange={(event) => {
                      const progress = Number(event.target.value)
                      updateNode(selectedNode.id, {
                        progress,
                        status: progress >= 100
                          ? 'done'
                          : selectedNode.data.status === 'done' ? 'in-progress' : selectedNode.data.status,
                      })
                    }}
                    disabled={mode === 'viewer'}
                  />
                </label>
                <section className={`work-section ${selectedNode.data.isWork ? 'enabled' : ''}`}>
                  <div className="work-section-heading">
                    <div>
                      <span>업무 관리</span>
                      <small>{selectedNode.data.isWork ? '담당자와 실행 항목을 관리합니다.' : '이 노드를 실행 가능한 업무로 전환합니다.'}</small>
                    </div>
                    <button
                      type="button"
                      className={`work-switch ${selectedNode.data.isWork ? 'on' : ''}`}
                      onClick={() => updateNode(selectedNode.id, { isWork: !selectedNode.data.isWork })}
                      disabled={mode === 'viewer'}
                      aria-label={selectedNode.data.isWork ? '업무 관리 해제' : '업무로 전환'}
                      aria-pressed={Boolean(selectedNode.data.isWork)}
                    >
                      <span />
                    </button>
                  </div>

                  {selectedNode.data.isWork && (
                    <div className="work-fields">
                      <label>
                        <span>담당자</span>
                        <select
                          value={selectedNode.data.assigneeId ?? ''}
                          onChange={(event) => updateNode(selectedNode.id, { assigneeId: event.target.value || undefined })}
                          disabled={mode === 'viewer'}
                        >
                          <option value="">담당자 미지정</option>
                          {selectedNode.data.assigneeId && !selectableTeamMembers.some((member) => member.id === selectedNode.data.assigneeId) && (
                            <option value={selectedNode.data.assigneeId} disabled>{teamMembers.find((member) => member.id === selectedNode.data.assigneeId)?.name ?? '알 수 없는 담당자'} (비활성)</option>
                          )}
                          {selectableTeamMembers.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>마감일</span>
                        <input
                          type="date"
                          value={selectedNode.data.dueDate ?? ''}
                          onChange={(event) => updateNode(selectedNode.id, { dueDate: event.target.value || undefined })}
                          readOnly={mode === 'viewer'}
                        />
                      </label>

                      <div className="dependency-block">
                        <div className="dependency-heading">
                          <span>업무 의존성</span>
                          <strong className={selectedBlockingIds.size > 0 ? 'blocked' : ''}>{selectedBlockingIds.size > 0 ? `차단됨 ${selectedBlockingIds.size}` : '진행 가능'}</strong>
                        </div>
                        <div className="dependency-group">
                          <small>선행 업무</small>
                          <div className="dependency-list">
                            {selectedPrerequisites.map((node) => {
                              const blocking = selectedBlockingIds.has(node.id)
                              return (
                                <div className={blocking ? 'blocking' : 'complete'} key={node.id}>
                                  <span><i>{blocking ? '!' : '✓'}</i><span><strong>{node.data.label}</strong><small>{blocking ? `${node.data.progress}% · 완료 대기` : '완료됨'}</small></span></span>
                                  {mode === 'editor' && <button onClick={() => removeDependency(node.id)} aria-label={`${node.data.label} 선행 업무 제거`}><Icon name="close" size={11} /></button>}
                                </div>
                              )
                            })}
                            {selectedPrerequisites.length === 0 && <div className="empty-dependency">지정된 선행 업무가 없습니다.</div>}
                          </div>
                          {mode === 'editor' && (
                            <form className="dependency-add" onSubmit={(event) => { event.preventDefault(); addDependency() }}>
                              <select value={dependencyCandidate} onChange={(event) => { setDependencyCandidate(event.target.value); setDependencyError('') }}>
                                <option value="">선행 업무 선택</option>
                                {availableDependencies.map((node) => <option key={node.id} value={node.id}>{node.data.label}</option>)}
                              </select>
                              <button type="submit" disabled={!dependencyCandidate}><Icon name="plus" size={13} /></button>
                            </form>
                          )}
                          {dependencyError && <em>{dependencyError}</em>}
                        </div>
                        {selectedDependents.length > 0 && (
                          <div className="dependency-group dependents">
                            <small>후속 업무</small>
                            <div className="dependent-tags">{selectedDependents.map((node) => <span key={node.id}>{node.data.label}</span>)}</div>
                          </div>
                        )}
                      </div>

                      <div className="waiting-block" ref={waitingBlockRef}>
                        <div className="waiting-heading">
                          <div>
                            <span>대기 항목</span>
                            <small>외부 전달물이나 결정처럼 이 문서의 선행 업무로 표현할 수 없는 대기를 기록합니다.</small>
                          </div>
                          <strong className={(selectedNode.data.waitingItems ?? []).length > 0 ? 'active' : ''}>
                            {(selectedNode.data.waitingItems ?? []).length > 0 ? `${selectedNode.data.waitingItems?.length}건` : '없음'}
                          </strong>
                        </div>
                        <div className="waiting-items">
                          {(selectedNode.data.waitingItems ?? []).map((item) => (
                            <div className="waiting-item" key={item.id}>
                              <div className="waiting-item-heading">
                                <span aria-hidden="true">⏸️</span>
                                <input
                                  value={waitingLabelDrafts[item.id] ?? item.label}
                                  onChange={(event) => setWaitingLabelDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                                  onBlur={() => commitWaitingLabel(item)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                      event.preventDefault()
                                      event.currentTarget.blur()
                                    }
                                  }}
                                  placeholder="무엇을 기다리고 있나요?"
                                  maxLength={120}
                                  readOnly={mode === 'viewer'}
                                  aria-label="대기 항목 이름"
                                />
                                {mode === 'editor' && (
                                  <button
                                    type="button"
                                    onClick={() => updateWaitingItems((selectedNode.data.waitingItems ?? []).filter((current) => current.id !== item.id))}
                                    aria-label={`${item.label || '대기 항목'} 삭제`}
                                  >
                                    <Icon name="close" size={11} />
                                  </button>
                                )}
                              </div>
                              <input
                                value={item.note ?? ''}
                                onChange={(event) => updateWaitingItems((selectedNode.data.waitingItems ?? []).map((current) => (
                                  current.id === item.id ? { ...current, note: event.target.value || undefined } : current
                                )))}
                                placeholder="메모 (선택)"
                                maxLength={1000}
                                readOnly={mode === 'viewer'}
                                aria-label={`${item.label} 대기 메모`}
                              />
                              <input
                                value={item.resumeCondition ?? ''}
                                onChange={(event) => updateWaitingItems((selectedNode.data.waitingItems ?? []).map((current) => (
                                  current.id === item.id ? { ...current, resumeCondition: event.target.value || undefined } : current
                                )))}
                                placeholder="재개 조건 (선택)"
                                maxLength={500}
                                readOnly={mode === 'viewer'}
                                aria-label={`${item.label} 재개 조건`}
                              />
                              <small>{new Date(item.since).toLocaleString('ko-KR')}부터 대기</small>
                            </div>
                          ))}
                          {(selectedNode.data.waitingItems ?? []).length === 0 && <div className="empty-waiting">현재 대기 중인 항목이 없습니다.</div>}
                        </div>
                        {mode === 'editor' && (
                          <form className="waiting-add" onSubmit={(event) => { event.preventDefault(); addWaitingItem() }}>
                            <input
                              value={newWaitingLabel}
                              onChange={(event) => setNewWaitingLabel(event.target.value)}
                              placeholder="예: 서버 API 완료, 캐릭터 아트 전달"
                              maxLength={120}
                              disabled={selectedNode.data.progress >= 100}
                            />
                            <button type="submit" disabled={!newWaitingLabel.trim() || selectedNode.data.progress >= 100}><Icon name="plus" size={13} /></button>
                          </form>
                        )}
                        <small className="waiting-help">대기 항목은 상태와 진행률을 바꾸지 않으며, 업무를 완료하면 자동으로 정리됩니다. 문서 내부 선행 업무는 위의 업무 의존성을 사용하세요.</small>
                      </div>

                      <div className="checklist-block">
                        <div className="checklist-heading">
                          <span>체크리스트</span>
                          <strong>
                            {(selectedNode.data.checklist ?? []).filter((item) => item.done).length}/{(selectedNode.data.checklist ?? []).length}
                          </strong>
                        </div>
                        <div className="checklist-items">
                          {(selectedNode.data.checklist ?? []).map((item) => (
                            <div className={`checklist-item ${item.done ? 'done' : ''}`} key={item.id}>
                              <button
                                type="button"
                                className="check-toggle"
                                onClick={() => applyChecklist((selectedNode.data.checklist ?? []).map((current) => current.id === item.id ? { ...current, done: !current.done } : current))}
                                disabled={mode === 'viewer'}
                                aria-label={`${item.text} ${item.done ? '완료 취소' : '완료'}`}
                              >
                                {item.done && <Icon name="check" size={11} />}
                              </button>
                              {editingChecklist?.id === item.id ? (
                                <form className="checklist-edit-form" onSubmit={(event) => { event.preventDefault(); commitChecklistEdit() }}>
                                  <input
                                    value={editingChecklist.text}
                                    onChange={(event) => setEditingChecklist({ id: item.id, text: event.target.value })}
                                    onBlur={commitChecklistEdit}
                                    onKeyDown={(event) => {
                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        skipChecklistCommit.current = true
                                        setEditingChecklist(null)
                                      }
                                    }}
                                    maxLength={120}
                                    autoFocus
                                    aria-label="체크리스트 항목 수정"
                                  />
                                </form>
                              ) : (
                                <span
                                  className="checklist-text"
                                  onMouseEnter={(event) => {
                                    if (isTextTruncated(event.currentTarget)) {
                                      setChecklistTooltip({ text: item.text, x: event.clientX, y: event.clientY })
                                    }
                                  }}
                                  onMouseMove={(event) => {
                                    setChecklistTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null)
                                  }}
                                  onMouseLeave={() => setChecklistTooltip(null)}
                                  onDoubleClick={() => {
                                  if (mode === 'editor') {
                                    setChecklistTooltip(null)
                                    skipChecklistCommit.current = false
                                    setEditingChecklist({ id: item.id, text: item.text })
                                  }
                                  }}
                                >{item.text}</span>
                              )}
                              {mode === 'editor' && (
                                <div className="check-actions">
                                  <button
                                    type="button"
                                    className="check-edit"
                                    onClick={() => {
                                      skipChecklistCommit.current = false
                                      setEditingChecklist({ id: item.id, text: item.text })
                                    }}
                                    aria-label={`${item.text} 수정`}
                                  >
                                    <Icon name="edit" size={11} />
                                  </button>
                                  <button
                                    type="button"
                                    className="check-delete"
                                    onClick={() => applyChecklist((selectedNode.data.checklist ?? []).filter((current) => current.id !== item.id))}
                                    aria-label={`${item.text} 삭제`}
                                  >
                                    <Icon name="close" size={11} />
                                  </button>
                                </div>
                              )}
                            </div>
                          ))}
                          {(selectedNode.data.checklist ?? []).length === 0 && <div className="empty-checklist">등록된 실행 항목이 없습니다.</div>}
                        </div>
                        {mode === 'editor' && (
                          <form className="checklist-add" onSubmit={(event) => { event.preventDefault(); addChecklistItem() }}>
                            <input value={newChecklistText} onChange={(event) => setNewChecklistText(event.target.value)} placeholder="실행 항목 추가" maxLength={120} />
                            <button type="submit" disabled={!newChecklistText.trim()}><Icon name="plus" size={13} /></button>
                          </form>
                        )}
                        <small className="checklist-help">완료 비율이 노드 진행률에 자동 반영됩니다.</small>
                      </div>
                    </div>
                  )}
                </section>
                <section className="node-comments">
                  <div className="node-comments-heading">
                    <span><Icon name="comment" size={14} />{selectedNode.data.reference ? '원본 댓글' : '댓글'}</span><strong>{comments.length}</strong>
                  </div>
                  <div className="comment-list">
                    {commentsLoading && <div className="comment-message">댓글을 불러오는 중…</div>}
                    {!commentsLoading && comments.filter((comment) => !comment.parentId).map((comment) => {
                      const replies = comments.filter((reply) => reply.parentId === comment.id)
                      return (
                        <div className={`comment-thread ${comment.resolvedAt ? 'resolved' : ''}`} key={comment.id}>
                          <CommentCard comment={comment} mode={mode} user={user} collaborators={collaborators} readOnly={Boolean(user.publicAccess)} onReply={setReplyTarget} onDelete={(target) => { void deleteComment(target) }} onResolve={(target) => { void toggleCommentResolved(target) }} onReaction={(target, emoji) => { void toggleCommentReaction(target, emoji) }} />
                          {replies.length > 0 && (
                            <div className="comment-replies">
                              {replies.map((reply) => <CommentCard key={reply.id} comment={reply} isReply mode={mode} user={user} collaborators={collaborators} readOnly={Boolean(user.publicAccess)} onReply={setReplyTarget} onDelete={(target) => { void deleteComment(target) }} onResolve={(target) => { void toggleCommentResolved(target) }} onReaction={(target, emoji) => { void toggleCommentReaction(target, emoji) }} />)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                    {!commentsLoading && comments.length === 0 && <div className="comment-message">{user.publicAccess ? '등록된 댓글이 없습니다.' : '첫 댓글을 남겨보세요.'}</div>}
                  </div>
                  {commentError && <div className="comment-error">{commentError}</div>}
                  {user.publicAccess ? <div className="public-viewer-comment-note"><Icon name="lock" size={12} /><span>공개 뷰어에서는 댓글을 조회만 할 수 있습니다.</span></div> : <form className="comment-form" onSubmit={(event) => { event.preventDefault(); void submitComment() }}>
                    {replyTarget && <div className="reply-target"><span><strong>{replyTarget.author.name}</strong>님에게 답글</span><button type="button" onClick={() => setReplyTarget(null)} aria-label="답글 취소"><Icon name="close" size={11} /></button></div>}
                    <textarea value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder={replyTarget ? '답글을 입력하세요' : '댓글을 입력하세요'} maxLength={1000} rows={3} />
                    <div className="mention-tools">
                      <span>멘션</span>
                      {collaborators.filter((collaborator) => collaborator.id !== user.id).map((collaborator) => <button type="button" key={collaborator.id} onClick={() => insertMention(collaborator)}>@{collaborator.name}</button>)}
                    </div>
                    <div><small>{newComment.length}/1000 · {selectedNode.data.reference ? '원본 노드에 등록' : '편집자와 뷰어 모두 작성 가능'}</small><button type="submit" disabled={!newComment.trim()}><Icon name="send" size={13} />{replyTarget ? '답글' : '등록'}</button></div>
                  </form>}
                </section>
                <div className="meta-card">
                  <span>문서 생성자</span><strong><span className="mini-avatar">{assigneeInitials(activeDocument?.createdBy?.name ?? '?')}</span>{activeDocument?.createdBy?.name ?? '기록 없음'}</strong>
                  <span>문서 생성</span><strong>{formatDocumentDate(activeDocument?.createdAt)}</strong>
                  <span>마지막 수정</span><strong>{formatDocumentDate(activeDocument?.updatedAt)}</strong>
                </div>
              </div>
              {mode === 'editor' && (
                <div className="inspector-footer">
                  <button onClick={() => addNode(selectedNode.id)}><Icon name="plus" size={16} />하위 노드 추가</button>
                </div>
              )}
            </>
          ) : (
            <div className="empty-inspector">
              <div className="empty-icon"><Icon name="map" size={24} /></div>
              <strong>노드를 선택하세요</strong>
              <span>세부 정보와 진행률을 확인할 수 있습니다.</span>
            </div>
          )}
        </aside>
      </main>
      {historyOpen && (
        <div className="history-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) setHistoryOpen(false) }}>
          <section className="history-modal" role="dialog" aria-modal="true" aria-label="문서 변경 이력">
            <header>
              <div><span>문서 보호</span><strong>백업과 변경 이력</strong></div>
              <button onClick={() => setHistoryOpen(false)} aria-label="변경 이력 닫기"><Icon name="close" size={16} /></button>
            </header>
            <div className="history-tabs" role="tablist" aria-label="이력 종류">
              <button className={historyTab === 'changes' ? 'active' : ''} role="tab" aria-selected={historyTab === 'changes'} onClick={() => setHistoryTab('changes')}>변경 이력 <strong>{mapRevisions.length}{historyHasMore ? '+' : ''}</strong></button>
              <button className={historyTab === 'daily' ? 'active' : ''} role="tab" aria-selected={historyTab === 'daily'} onClick={() => setHistoryTab('daily')}>일일 백업 <strong>{dailyBackups.length}</strong></button>
            </div>
            <div className="history-current">
              <span className="history-dot current" />
              <div><strong>현재 버전</strong><small>{activeDocument?.updatedAt ? new Date(activeDocument.updatedAt).toLocaleString('ko-KR') : '저장된 시간 없음'} · {activeDocument?.nodeCount ?? 0}개 항목</small></div>
              <span>사용 중</span>
            </div>
            <div className="history-list">
              {historyLoading && <div className="history-message">{historyTab === 'changes' ? '변경 이력' : '일일 백업'}을 불러오는 중…</div>}
              {!historyLoading && historyError && <div className="history-message error">{historyError}</div>}
              {!historyLoading && !historyError && historyTab === 'changes' && mapRevisions.map((revision) => (
                <article className="history-item" key={revision.id}>
                  <span className="history-dot" />
                  <div>
                    <strong>{revisionReasonLabel(revision.reason)}</strong>
                    <small>{new Date(revision.mapUpdatedAt ?? revision.archivedAt).toLocaleString('ko-KR')}</small>
                    <small>{revision.mapUpdatedBy?.name ?? revision.archivedBy.name} · {revision.nodeCount}개 항목</small>
                  </div>
                  {mode === 'editor' && <button disabled={historyLoading} onClick={() => { void restoreMapRevision(revision) }}>복원</button>}
                </article>
              ))}
              {!historyLoading && !historyError && historyTab === 'changes' && mapRevisions.length === 0 && (
                <div className="history-message">아직 보관된 이전 버전이 없습니다.</div>
              )}
              {!historyLoading && !historyError && historyTab === 'changes' && historyPaginationError && (
                <div className="history-message error">{historyPaginationError}</div>
              )}
              {!historyLoading && !historyError && historyTab === 'changes' && historyHasMore && (
                <button className="history-load-more" disabled={historyLoadingMore} onClick={() => { void loadMoreMapHistory() }}>
                  {historyLoadingMore ? '불러오는 중…' : '더 보기'}
                </button>
              )}
              {!historyLoading && !historyError && historyTab === 'daily' && dailyBackups.map((backup) => (
                <article className="history-item daily" key={backup.date}>
                  <span className="history-dot" />
                  <div>
                    <strong>{backup.date} 백업</strong>
                    <small>문서 상태 {backup.mapUpdatedAt ? new Date(backup.mapUpdatedAt).toLocaleString('ko-KR') : '시간 기록 없음'}</small>
                    <small>{backup.mapUpdatedBy?.name ?? backup.backedUpBy.name} · {backup.nodeCount}개 항목</small>
                  </div>
                  {mode === 'editor' && <button disabled={historyLoading} onClick={() => { void restoreDailyBackup(backup) }}>복원</button>}
                </article>
              ))}
              {!historyLoading && !historyError && historyTab === 'daily' && dailyBackups.length === 0 && (
                <div className="history-message">아직 생성된 일일 백업이 없습니다.</div>
              )}
            </div>
            <footer>{mode === 'editor' ? '일일 백업은 날짜별 최신 상태를 자동 보관하며, 복원 전 현재 상태도 이력에 저장됩니다.' : '뷰어는 변경 이력과 일일 백업을 확인할 수 있지만 복원할 수 없습니다.'}</footer>
          </section>
        </div>
      )}
      {aiDialogOpen && selectedNode && activeDocument && (
        <AiConversationDialog
          key={activeDocument.id}
          documentId={activeDocument.id}
          documentTitle={activeDocument.title}
          cardId={selectedNode.id}
          cardTitle={selectedNode.data.label}
          knowledgeSources={selectedKnowledgeEdges.flatMap((edge) => {
            const source = nodes.find((node) => node.id === edge.source)
            return source ? [{ id: source.id, label: source.data.label, policy: knowledgePolicyOf(edge) }] : []
          })}
          onClose={() => setAiDialogOpen(false)}
        />
      )}
      {checklistTooltip && (
        <div
          className="checklist-tooltip"
          style={{
            left: Math.max(8, Math.min(checklistTooltip.x + 12, window.innerWidth - 340)),
            top: Math.max(8, Math.min(checklistTooltip.y + 14, window.innerHeight - 90)),
          }}
          role="tooltip"
        >
          {checklistTooltip.text}
        </div>
      )}
      {nodeContextMenu && mode === 'editor' && (
        <div
          className="node-context-menu"
          style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
        >
          <div className="context-menu-title">
            <span>노드 메뉴</span>
            <strong>{contextMenuNode?.data.label}</strong>
          </div>
          <button role="menuitem" onClick={startOrOpenContextNodeAiConversation}>
            <span className="context-icon"><Icon name="sparkles" size={15} /></span>
            <span>
              <strong>{contextMenuNode?.data.aiConversationId ? 'AI 대화 열기' : 'AI 대화 시작'}</strong>
              <small>{contextMenuNode?.data.aiConversationId ? '연결된 AionUi 대화 열기' : '현재 카드를 기준으로 옵션 선택'}</small>
            </span>
          </button>
          <div className="context-divider" />
          <button role="menuitem" onClick={() => copyNode(nodeContextMenu.nodeId)}>
            <span className="context-icon"><Icon name="copy" size={15} /></span>
            <span><strong>복사{nodes.some((node) => node.id === nodeContextMenu.nodeId && node.selected) && nodes.filter((node) => node.selected).length > 1 ? ` (${nodes.filter((node) => node.selected).length}개)` : ''}</strong><small>선택 노드와 내부 연결 관계 복사</small></span>
          </button>
          {copiedNodes && copiedNodes.sourceMapId !== activeMapId ? (
            <>
              <button role="menuitem" disabled={!copiedNodes} onClick={() => pasteNodeAsChild(nodeContextMenu.nodeId, 'clone')}>
                <span className="context-icon"><Icon name="paste" size={15} /></span>
                <span><strong>Clone으로 붙여넣기</strong><small>{copiedNodes.nodes.length === 1 ? `“${copiedNodes.nodes[0].data.reference ? copiedNodes.nodes[0].data.label.replace(/\s*\(ref\)\s*$/i, '') : copiedNodes.nodes[0].data.label}” 독립 복제` : `${copiedNodes.nodes.length}개 노드 독립 복제`}</small></span>
              </button>
              <button role="menuitem" disabled={!copiedNodes} onClick={() => pasteNodeAsChild(nodeContextMenu.nodeId, 'reference')}>
                <span className="context-icon"><Icon name="share" size={15} /></span>
                <span><strong>Ref로 붙여넣기</strong><small>{copiedNodes.nodes.length === 1 ? `“${copiedNodes.nodes[0].data.reference ? copiedNodes.nodes[0].data.label.replace(/\s*\(ref\)\s*$/i, '') : copiedNodes.nodes[0].data.label} (ref)” 원본 참조` : `${copiedNodes.nodes.length}개 노드 원본 참조`}</small></span>
              </button>
            </>
          ) : (
            <button role="menuitem" disabled={!copiedNodes} onClick={() => pasteNodeAsChild(nodeContextMenu.nodeId)}>
              <span className="context-icon"><Icon name="paste" size={15} /></span>
              <span><strong>자식으로 붙여넣기</strong><small>{copiedNodes ? copiedNodes.nodes.length === 1 ? `“${copiedNodes.nodes[0].data.label}” 복사본 생성` : `${copiedNodes.nodes.length}개 노드 복사본 생성` : '먼저 노드를 복사해 주세요'}</small></span>
            </button>
          )}
          <div className="context-divider" />
          <button className="danger" role="menuitem" onClick={() => { deleteNodeById(nodeContextMenu.nodeId); setNodeContextMenu(null) }}>
            <span className="context-icon"><Icon name="trash" size={15} /></span>
            <span><strong>삭제</strong><small>노드와 연결선 삭제</small></span>
          </button>
        </div>
      )}
      {aiConversationContextMenu && selectedNode && mode === 'editor' && (
        <div
          className="node-context-menu ai-conversation-context-menu"
          style={{ left: aiConversationContextMenu.x, top: aiConversationContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
        >
          <div className="context-menu-title">
            <span>AI 대화</span>
            <strong>{selectedNode.data.label}</strong>
          </div>
          <button role="menuitem" onClick={startNewAiConversation}>
            <span className="context-icon"><Icon name="sparkles" size={15} /></span>
            <span><strong>AI 대화를 새로 시작</strong><small>현재 카드를 기준으로 옵션 선택</small></span>
          </button>
        </div>
      )}
      {documentContextMenu && mode === 'editor' && (
        <div
          className="node-context-menu document-context-menu"
          style={{ left: documentContextMenu.x, top: documentContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
        >
          <div className="context-menu-title">
            <span>문서 메뉴</span>
            <strong>{documents.find((document) => document.id === documentContextMenu.mapId)?.title}</strong>
          </div>
          <div className="document-color-section">
            <span>아이콘 색상</span>
            <div className="document-color-picker" role="group" aria-label="문서 아이콘 색상">
              {DOCUMENT_COLORS.map((color) => {
                const selected = documents.find((document) => document.id === documentContextMenu.mapId)?.color === color.id
                return (
                  <button
                    key={color.id}
                    className={selected ? 'selected' : ''}
                    style={documentColorStyle(color.id)}
                    onClick={() => { void changeDocumentColor(documentContextMenu.mapId, color.id) }}
                    aria-label={color.label}
                    aria-pressed={selected}
                    title={color.label}
                  >
                    {selected && <Icon name="check" size={12} />}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="context-divider" />
          <button role="menuitem" onClick={() => { void completeDocument(documentContextMenu.mapId) }}>
            <span className="context-icon"><Icon name="check" size={15} /></span>
            <span><strong>전체 완료</strong><small>모든 노드와 체크리스트를 완료 처리</small></span>
          </button>
          <div className="context-divider" />
          <button
            className="danger"
            role="menuitem"
            disabled={documents.length <= 1}
            onClick={() => { void trashDocument(documentContextMenu.mapId) }}
          >
            <span className="context-icon"><Icon name="trash" size={15} /></span>
            <span><strong>휴지통으로 이동</strong><small>{documents.length <= 1 ? '마지막 문서는 보호됩니다' : '나중에 휴지통에서 복원 가능'}</small></span>
          </button>
        </div>
      )}
    </div>
  )
}

function App() {
  const deepLink = parseWorkspaceDeepLink(window.location.pathname)
  const deepLinkEntry = deepLink !== null
  const [user, setUser] = useState<AuthUser | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)

  useEffect(() => {
    void apiRequest<{ user: AuthUser | null }>('/api/auth/me')
      .then(async (result) => {
        if (result.user || !deepLinkEntry) return result.user
        const viewerResult = await apiRequest<{ user: AuthUser }>('/api/auth/viewer-access', { method: 'POST' })
        return viewerResult.user
      })
      .then((authenticatedUser) => setUser(authenticatedUser))
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false))
  }, [deepLinkEntry])

  const logout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } finally {
      setUser(null)
      if (deepLinkEntry) window.location.replace('/')
    }
  }

  if (checkingSession) {
    return (
      <div className="session-loading">
        <div className="login-brand"><Icon name="map" size={27} /></div>
        <span>{deepLinkEntry ? '공유 화면으로 연결 중…' : '워크스페이스 확인 중…'}</span>
      </div>
    )
  }

  if (!user) return <LoginScreen onAuthenticated={setUser} />

  return (
    <ReactFlowProvider>
      <Workspace user={user} onLogout={() => { void logout() }} initialDeepLink={deepLink} />
    </ReactFlowProvider>
  )
}

export default App
