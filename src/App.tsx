import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type FormEvent as ReactFormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction, type TouchEvent as ReactTouchEvent } from 'react'
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
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStoreApi,
  useUpdateNodeInternals,
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
import { DoorayTaskLinkLabel } from './components/DoorayTaskLinkLabel'
import { MentionText } from './components/MentionText'
import { AdminEditorPanel } from './components/AdminEditorPanel'
import { AiConversationDialog } from './components/AiConversationDialog'
import { AiConversationPickerDialog } from './components/AiConversationPickerDialog'
import { AiConversationActivityIndicator } from './components/AiConversationRuntimeBadge'
import { DailyBackupPreviewDialog, type DailyBackupPreview } from './components/DailyBackupPreviewDialog'
import { ImagePreviewDialog } from './components/ImagePreviewDialog'
import { SharedKnowledgeReviewDialog, type SharedKnowledgeReviewApplied } from './components/SharedKnowledgeReviewDialog'
import { DashboardView, KanbanView, TimelineView } from './components/WorkViews'
import type { AiConversationLink, AiConversationRuntime, ChecklistItem, KnowledgePolicy, MindDoorayLinkData, MindDoorayTaskData, MindDoorayWikiData, MindImageData, MindMapEdgeData, MindNodeData, TeamMember, WaitingItem } from './types/mindMap'
import { resolveAiConversationTarget, type AiConversationExplicitTarget } from './utils/aiConversationLaunch.mjs'
import { applyBoxSelection, boxSelectionNodeIds, boxSelectionRect, isBoxSelectionDrag } from './utils/boxSelection.mjs'
import { collectDragDescendantOwners, dragRootIds, hierarchyReparentPairs } from './utils/hierarchyDrag.mjs'
import { blockingNodes, createsDependencyCycle, dependentNodes, prerequisiteNodes } from './utils/dependencies'
import { collapsedDocumentGroupsStorageKey, initialCollapsedDocumentGroupIds, normalizeCollapsedDocumentGroupIds } from './utils/documentGroupCollapse.mjs'
import { createsKnowledgeCycle, isHierarchyEdge, isKnowledgeEdge, knowledgePolicyOf } from './utils/knowledgeEdges'
import { isSameDoorayKnowledgeUrl, normalizedDoorayKnowledgeUrl, taskUrlProvider } from './utils/externalLinks'
import { splitImageFileName, uniqueImageFileName } from './utils/imageFileNames.mjs'
import { copiedImagePlacementOverrides } from './utils/imageClipboard.mjs'
import { shouldReconnectEventStream } from './utils/eventStreamHealth.mjs'
import { aiConversationLinksFromData } from './utils/aiConversations.mjs'
import { revisionReasonLabel, shouldRefreshMapContentForAction } from './utils/mapChangeMetadata.mjs'
import { mapContentsEqual, reconcileRemoteMapContent } from './utils/mapDocumentSync.mjs'
import { mergeMapContent } from './utils/mergeMapContent.mjs'
import { computeProgressRollups } from './utils/progressRollup.mjs'
import { snapAspectResizeToGrid, snapFreeResizeToGrid } from './utils/resizeGrid.mjs'
import type { ResizeSnapRequest } from './utils/resizeGrid.mjs'
import { rootDeletionPlan } from './utils/rootDeletion.mjs'
import { extractTextLinks } from './utils/textLinks.mjs'
import { touchPointCentroid, touchPointDistance, viewportForTouchGesture } from './utils/touchViewport.mjs'
import { normalizeWorkspaceLocation, restorableWorkspaceLocation, workspaceLocationStorageKey } from './utils/workspaceLocation.mjs'
import { appliedUiTheme, applyUiTheme, storedUiTheme, UI_THEME_STORAGE_KEY, type UiTheme } from './theme'

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
const MINDMAP_MIN_ZOOM = 0.25
const MINDMAP_MAX_ZOOM = 1.8
const TOUCH_CARD_LONG_PRESS_MS = 500
const TOUCH_CARD_DOUBLE_TAP_MS = 320
const TOUCH_CARD_DOUBLE_TAP_DISTANCE = 24
const TOUCH_DRAG_MOVE_THRESHOLD = 8
const MINDMAP_CHILD_HORIZONTAL_GAP = MINDMAP_GRID_SIZE * 4
const MINDMAP_WORK_NODE_VERTICAL_STEP = MINDMAP_GRID_SIZE * 6
const MINDMAP_IMAGE_MAX_WIDTH = 480
const MINDMAP_IMAGE_MAX_HEIGHT = 360
const MINDMAP_DOORAY_TASK_DEFAULT_WIDTH = 218
const MINDMAP_DOORAY_TASK_DEFAULT_HEIGHT = 112
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const SUPPORTED_IMAGE_FILE_PATTERN = /\.(?:png|jpe?g|gif|webp)$/i
const SIDEBAR_MIN_WIDTH = 190
const SIDEBAR_AI_ACTIVITY_MIN_WIDTH = 208
const SIDEBAR_MAX_WIDTH = 420
const DOCUMENT_LIST_AUTO_SCROLL_EDGE_PX = 56
const DOCUMENT_LIST_AUTO_SCROLL_MAX_SPEED_PX = 14
const AIONUI_WEB_DEFAULT_PORT = '7777'

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function defaultAionUiWebBaseUrl() {
  const url = new URL(window.location.origin)
  url.port = AIONUI_WEB_DEFAULT_PORT
  return url.toString().replace(/\/+$/, '')
}

function aionUiConversationWebUrl(baseUrl: string, conversationId: string) {
  const url = new URL(baseUrl)
  url.pathname = '/'
  url.search = ''
  url.hash = `/conversation/${encodeURIComponent(conversationId)}`
  return url.toString()
}

function snapMindMapPosition(position: { x: number; y: number }) {
  return {
    x: Math.round(position.x / MINDMAP_GRID_SIZE) * MINDMAP_GRID_SIZE,
    y: Math.round(position.y / MINDMAP_GRID_SIZE) * MINDMAP_GRID_SIZE,
  }
}

function childMindMapHorizontalPosition(parentPosition: { x: number; y: number }, parentWidth = MINDMAP_DOORAY_TASK_DEFAULT_WIDTH) {
  const alignedParentPosition = snapMindMapPosition(parentPosition)
  const normalizedParentWidth = Number.isFinite(parentWidth) && parentWidth > 0
    ? parentWidth
    : MINDMAP_DOORAY_TASK_DEFAULT_WIDTH
  return snapMindMapPosition({
    x: alignedParentPosition.x + normalizedParentWidth + MINDMAP_CHILD_HORIZONTAL_GAP,
    y: alignedParentPosition.y,
  }).x
}

function defaultChildMindMapPosition(parentPosition: { x: number; y: number }, siblingPositions: { x: number; y: number }[], parentWidth = MINDMAP_DOORAY_TASK_DEFAULT_WIDTH) {
  const alignedParentPosition = snapMindMapPosition(parentPosition)
  const nextY = siblingPositions.length > 0
    ? Math.max(...siblingPositions.map((position) => snapMindMapPosition(position).y)) + MINDMAP_WORK_NODE_VERTICAL_STEP
    : alignedParentPosition.y
  return {
    x: childMindMapHorizontalPosition(alignedParentPosition, parentWidth),
    y: nextY,
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

function rootNodeOf(nodes: MindMapNode[], edges: MindMapEdge[]) {
  const hierarchyTargets = new Set(edges.filter(isHierarchyEdge).map((edge) => edge.target))
  return nodes.find((node) => node.data.kind === 'root' && !hierarchyTargets.has(node.id))
    ?? nodes.find((node) => node.data.kind === 'root')
    ?? nodes.find((node) => !hierarchyTargets.has(node.id))
    ?? nodes[0]
}

function rootStateOf(nodes: MindMapNode[], edges: MindMapEdge[]) {
  const root = rootNodeOf(nodes, edges)
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
const INSPECTOR_TEXTAREA_HEIGHTS_STORAGE_PREFIX = 'mindnprogress-inspector-textarea-heights'
const INSPECTOR_TEXTAREA_MIN_HEIGHT = 32
const INSPECTOR_TEXTAREA_MAX_HEIGHT = 10_000

type InspectorTextareaField = 'description' | 'sharedKnowledge'
type InspectorTextareaHeights = Partial<Record<InspectorTextareaField, number>>

function inspectorTextareaHeightsStorageKey(userId: string) {
  return `${INSPECTOR_TEXTAREA_HEIGHTS_STORAGE_PREFIX}:${userId}`
}

function readStoredWorkspaceLocation(userId: string) {
  const storageKey = workspaceLocationStorageKey(userId)
  if (!storageKey) return null
  try {
    return normalizeWorkspaceLocation(JSON.parse(localStorage.getItem(storageKey) ?? 'null'))
  } catch {
    return null
  }
}

function storeWorkspaceLocation(userId: string, location: { mapId: string; viewMode: ViewMode; nodeId: string | null }) {
  const storageKey = workspaceLocationStorageKey(userId)
  const normalizedLocation = normalizeWorkspaceLocation(location)
  if (!storageKey || !normalizedLocation) return null
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalizedLocation))
    return normalizedLocation
  } catch {
    return null
  }
}

function readStoredCollapsedDocumentGroupIds(userId: string) {
  const storageKey = collapsedDocumentGroupsStorageKey(userId)
  if (!storageKey) return null
  const saved = localStorage.getItem(storageKey)
  if (saved === null) return null
  try {
    return normalizeCollapsedDocumentGroupIds(JSON.parse(saved))
  } catch {
    return null
  }
}

function readInspectorTextareaHeights(userId: string): InspectorTextareaHeights {
  try {
    const storedValue: unknown = JSON.parse(
      localStorage.getItem(inspectorTextareaHeightsStorageKey(userId)) ?? '{}',
    )
    if (!storedValue || typeof storedValue !== 'object' || Array.isArray(storedValue)) return {}

    const storedHeights = storedValue as Record<string, unknown>
    return (['description', 'sharedKnowledge'] as const).reduce<InspectorTextareaHeights>((heights, field) => {
      const height = storedHeights[field]
      if (
        typeof height === 'number'
        && Number.isFinite(height)
        && height >= INSPECTOR_TEXTAREA_MIN_HEIGHT
        && height <= INSPECTOR_TEXTAREA_MAX_HEIGHT
      ) {
        heights[field] = height
      }
      return heights
    }, {})
  } catch {
    return {}
  }
}

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

// 카드 위 컨트롤이지만 눌러서 맵을 끌 수 있어야 하는 요소.
// 새 컨트롤을 카드에 추가하면 필요 시 여기에 클래스를 등록한다.
const PAN_ALLOWED_NODE_CONTROLS = ['node-collapse-toggle', 'node-source-open', 'node-waiting', 'node-blocked']
const PAN_ALLOWED_NODE_CONTROL_SELECTOR = PAN_ALLOWED_NODE_CONTROLS.map((name) => `.${name}`).join(', ')
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

type MindMapNode = Node<MindNodeData, 'mind'>
type MindMapEdge = Edge<MindMapEdgeData>
type AccessMode = 'editor' | 'viewer'
type UserRole = 'admin' | AccessMode
type ViewMode = 'mindmap' | 'kanban' | 'timeline' | 'dashboard'
type NodeFilter = 'all' | 'work' | 'planned' | 'in-progress' | 'done' | 'blocked'
type NodePasteMode = 'copy' | 'clone' | 'reference'

type KnowledgeConnectionDraft = {
  sourceId: string
  policy: KnowledgePolicy
}

type CanvasRect = {
  x: number
  y: number
  width: number
  height: number
}

type NodeSide = 'top' | 'right' | 'bottom' | 'left'

type NodeSideAnchor = {
  side: NodeSide
  x: number
  y: number
}

function nodeDimensions(node: MindMapNode) {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : Number.parseFloat(String(node.style?.width ?? ''))
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : Number.parseFloat(String(node.style?.height ?? ''))
  return {
    width: node.data.image?.displayWidth
      ?? node.data.externalLink?.displayWidth
      ?? (Number.isFinite(styleWidth) ? styleWidth : undefined)
      ?? node.measured?.width
      ?? node.width
      ?? MINDMAP_DOORAY_TASK_DEFAULT_WIDTH,
    height: node.data.image?.displayHeight
      ?? node.data.externalLink?.displayHeight
      ?? (Number.isFinite(styleHeight) ? styleHeight : undefined)
      ?? node.measured?.height
      ?? node.height
      ?? MINDMAP_DOORAY_TASK_DEFAULT_HEIGHT,
  }
}

function nodeSideAnchors(node: MindMapNode): NodeSideAnchor[] {
  const { width, height } = nodeDimensions(node)
  const { x, y } = node.position
  return [
    { side: 'top', x: x + width / 2, y },
    { side: 'right', x: x + width, y: y + height / 2 },
    { side: 'bottom', x: x + width / 2, y: y + height },
    { side: 'left', x, y: y + height / 2 },
  ]
}

function nearestKnowledgeHandles(source: MindMapNode, target: MindMapNode, sourceHandlePrefix: string) {
  let nearest: { source: NodeSideAnchor; target: NodeSideAnchor; distance: number } | null = null
  for (const sourceAnchor of nodeSideAnchors(source)) {
    for (const targetAnchor of nodeSideAnchors(target)) {
      const distance = Math.hypot(targetAnchor.x - sourceAnchor.x, targetAnchor.y - sourceAnchor.y)
      if (!nearest || distance < nearest.distance) nearest = { source: sourceAnchor, target: targetAnchor, distance }
    }
  }
  return nearest ? {
    sourceHandle: `${sourceHandlePrefix}-${nearest.source.side}`,
    targetHandle: `knowledge-target-${nearest.target.side}`,
  } : undefined
}

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

type CopiedImageItem = {
  sourceNodeId: string
  file: File
  image: MindImageData
  description: string
  position: { x: number; y: number }
}

type CopiedImages = {
  token: string
  sourceMapId: string
  images: CopiedImageItem[]
}

type ImagePlacementOverride = {
  displayWidth: number
  displayHeight: number
  description: string
  offsetX: number
  offsetY: number
}

const IMAGE_CLIPBOARD_MARKER_PREFIX = 'mindnprogress:image-copy:'

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

type DoorayTaskPreview = Omit<MindDoorayTaskData, 'displayWidth' | 'displayHeight'> & {
  subject: string
}

type DoorayWikiPreview = Omit<MindDoorayWikiData, 'displayWidth' | 'displayHeight'> & {
  subject: string
}

type DoorayKnowledgePreview = DoorayTaskPreview | DoorayWikiPreview

function isDoorayKnowledgeCard(data: MindNodeData): data is MindNodeData & { externalLink: MindDoorayLinkData } {
  const sourceUrl = normalizedDoorayKnowledgeUrl(data.taskUrl ?? '')
  return Boolean(sourceUrl
    && data.externalLink
    && isSameDoorayKnowledgeUrl(data.externalLink.url, sourceUrl))
}

function doorayKnowledgeState(preview: DoorayKnowledgePreview): Pick<MindNodeData, 'status' | 'progress'> {
  if (preview.provider === 'dooray-wiki') return { status: 'planned', progress: 0 }
  return {
    status: preview.closed ? 'done' : preview.workflowClass === 'working' ? 'in-progress' : 'planned',
    progress: preview.closed ? 100 : 0,
  }
}

function isSameDoorayKnowledgePreview(current: MindDoorayLinkData, preview: DoorayKnowledgePreview, subject: string) {
  if (current.provider !== preview.provider
    || current.url !== preview.url
    || current.hostname !== preview.hostname
    || current.title !== subject) return false
  if (current.provider === 'dooray-wiki' && preview.provider === 'dooray-wiki') {
    return current.wikiId === preview.wikiId && current.pageId === preview.pageId
  }
  if (current.provider === 'dooray-task' && preview.provider === 'dooray-task') {
    return current.projectId === preview.projectId
      && current.postId === preview.postId
      && current.taskNumber === preview.taskNumber
      && current.workflowName === preview.workflowName
      && current.workflowClass === preview.workflowClass
      && current.closed === preview.closed
  }
  return false
}

function knowledgeConnectionIssue(sourceId: string, targetId: string, nodes: MindMapNode[], edges: MindMapEdge[]) {
  const source = nodes.find((node) => node.id === sourceId)
  const target = nodes.find((node) => node.id === targetId)
  if (!source || !target) return '연결할 카드를 찾을 수 없습니다.'
  if (sourceId === targetId) return '같은 카드는 지식으로 연결할 수 없습니다.'
  if (target.data.kind === 'image') return '이미지는 대상 카드로 선택할 수 없습니다.'
  const knowledgeEdges = edges.filter(isKnowledgeEdge)
  if (knowledgeEdges.some((edge) => edge.source === sourceId && edge.target === targetId)) {
    return '이미 연결된 선행 지식입니다.'
  }
  if (createsKnowledgeCycle(sourceId, targetId, knowledgeEdges)) return '순환 지식선은 추가할 수 없습니다.'
  return ''
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

type SubscriptionUsageWindow = {
  usedPercent: number
  resetsAt: string | null
}

type AionUiSubscriptionUsage = {
  available: boolean
  state: 'loading' | 'ready' | 'partial' | 'unavailable'
  generatedAt: string | null
  updatedAt: string | null
  retryAfterMs: number | null
  claude: {
    state: 'loading' | 'ready' | 'unavailable'
    updatedAt: string | null
    stale: boolean
    session: SubscriptionUsageWindow | null
    weekly: SubscriptionUsageWindow | null
  } | null
  codex: {
    state: 'loading' | 'ready' | 'unavailable'
    updatedAt: string | null
    stale: boolean
    weekly: (SubscriptionUsageWindow & { windowDurationMins: number | null }) | null
    limitReached: boolean
  } | null
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
  contentFormat?: 'summary-detail'
  summary?: string
  detail?: string
  hasDetail?: boolean
  parentId: string | null
  resolvedAt: string | null
  resolvedBy: AuthUser | null
  reactions: Partial<Record<CommentReaction, string[]>>
  createdAt: string
  author: AuthUser
}
type CommentReaction = typeof COMMENT_REACTIONS[number]
type NodeCommentStats = Record<string, { total: number; unresolved: number }>
type MapDocumentResponse = {
  map: MapDocument
  referenceCommentStats?: NodeCommentStats
  unresolvedReferenceNodeIds?: string[]
}
type UserNotification = {
  id: string
  userId: string
  type: 'comment' | 'mention' | 'reply' | 'assignment' | 'schedule' | 'waiting-released' | 'ai-delegation'
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
  conversation: AiConversationLink | null
  sourceClientId: null
  updatedAt: string
  updatedBy: AuthUser
}
type AiConversationRuntimeEvent = {
  type: 'ai-conversation-runtime'
  mapId: string
  nodeId: string
  runtime: AiConversationRuntime | null
}
type AiConversationRuntimeSnapshotEvent = {
  type: 'ai-conversation-runtime-snapshot'
  mapId: string
  runtimes: { nodeId: string; runtime: AiConversationRuntime }[]
}
type AiConversationRuntimeSummaryEvent = {
  type: 'ai-conversation-runtime-summary'
  mapId: string
  activeCount: number
}
type AiConversationRuntimeSummarySnapshotEvent = {
  type: 'ai-conversation-runtime-summary-snapshot'
  summaries: { mapId: string; activeCount: number }[]
}
type NotificationEvent = { type: 'notification'; notification: UserNotification }
type NotificationsReadEvent = { type: 'notifications-read'; userId: string; notificationId: string | null; readAt: string }
type NotificationsRemovedEvent = { type: 'notifications-removed'; userId: string; notificationIds: string[] }
type HeartbeatEvent = { type: 'heartbeat'; sentAt: string }

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

function isSameCommentStats(current: NodeCommentStats, next: NodeCommentStats) {
  const currentNodeIds = Object.keys(current)
  const nextNodeIds = Object.keys(next)
  return currentNodeIds.length === nextNodeIds.length
    && nextNodeIds.every((nodeId) => (
      current[nodeId]?.total === next[nodeId]?.total
      && current[nodeId]?.unresolved === next[nodeId]?.unresolved
    ))
}

function mergeResolvedReferenceData(localData: MindNodeData, resolvedData: MindNodeData): MindNodeData {
  return {
    ...localData,
    label: resolvedData.label,
    description: resolvedData.description,
    sharedKnowledge: resolvedData.sharedKnowledge,
    sharedKnowledgeUpdatedAt: resolvedData.sharedKnowledgeUpdatedAt,
    sharedKnowledgeUpdatedBy: resolvedData.sharedKnowledgeUpdatedBy,
    sharedKnowledgeReview: resolvedData.sharedKnowledgeReview,
    progress: resolvedData.progress,
    status: resolvedData.status,
    taskUrl: resolvedData.taskUrl,
    externalLink: resolvedData.externalLink,
    aiConversationId: resolvedData.aiConversationId,
    aiConversations: resolvedData.aiConversations,
    isWork: resolvedData.isWork,
    assigneeId: resolvedData.assigneeId,
    dueDate: resolvedData.dueDate,
    checklist: resolvedData.checklist,
    waitingItems: resolvedData.waitingItems,
  }
}

function mergeResolvedReferenceNodes(currentNodes: MindMapNode[], resolvedNodes: MindMapNode[]) {
  const resolvedById = new Map(resolvedNodes.map((node) => [node.id, node]))
  let changed = false
  const nextNodes = currentNodes.map((node) => {
    if (!node.data.reference) return node
    const resolvedNode = resolvedById.get(node.id)
    if (!resolvedNode?.data.reference) return node
    const nextData = mergeResolvedReferenceData(node.data, resolvedNode.data)
    if (JSON.stringify(nextData) === JSON.stringify(node.data)) return node
    changed = true
    return { ...node, data: nextData }
  })
  return changed ? nextNodes : currentNodes
}

const REFERENCE_MANAGED_DATA_KEYS = new Set<keyof MindNodeData>([
  'label',
  'description',
  'sharedKnowledge',
  'sharedKnowledgeUpdatedAt',
  'sharedKnowledgeUpdatedBy',
  'sharedKnowledgeReview',
  'progress',
  'status',
  'taskUrl',
  'externalLink',
  'aiConversationId',
  'aiConversations',
  'isWork',
  'assigneeId',
  'dueDate',
  'checklist',
  'waitingItems',
])

function editableReferencePatch(patch: Partial<MindNodeData>) {
  const editablePatch = { ...patch } as Record<string, unknown>
  for (const key of REFERENCE_MANAGED_DATA_KEYS) delete editablePatch[key]
  return editablePatch as Partial<MindNodeData>
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
  rootIds: string[]
  rootPosition: { x: number; y: number }
  descendantPositions: Map<string, { x: number; y: number }>
  descendantRootIds: Map<string, string>
  selectedPositions: Map<string, { x: number; y: number }>
}

type RightPanGesture = {
  startX: number
  startY: number
  viewport: { x: number; y: number; zoom: number }
  moved: boolean
  contextMenuSuppressed: boolean
}

type BoxSelectionGesture = {
  pointerId: number
  startClient: { x: number; y: number }
  startFlow: { x: number; y: number }
  baseSelectedIds: string[]
  dragging: boolean
}

type TouchPanGesture = {
  startCentroid: { x: number; y: number }
  startDistance: number
  viewport: { x: number; y: number; zoom: number }
}

type TouchCanvasPanGesture = {
  identifier: number
  startClient: { x: number; y: number }
  viewport: { x: number; y: number; zoom: number }
  active: boolean
}

type TouchPaneGesture = {
  identifier: number
  startClient: { x: number; y: number }
  timer: number | null
  menuOpen: boolean
}

type TouchCardGesture = {
  identifier: number
  nodeId: string
  startClient: { x: number; y: number }
  startFlow: { x: number; y: number }
  startPosition: { x: number; y: number }
  currentPosition: { x: number; y: number }
  phase: 'pressing' | 'armed' | 'dragging'
  timer: number | null
}

type TouchCardTap = {
  nodeId: string
  at: number
  client: { x: number; y: number }
}

function touchPointsWithin(
  element: HTMLElement,
  touches: ReactTouchEvent<HTMLElement>['touches'],
) {
  const bounds = element.getBoundingClientRect()
  const points: { x: number; y: number }[] = []
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index)
    if (!touch || !(touch.target instanceof Element) || !element.contains(touch.target)) continue
    points.push({ x: touch.clientX - bounds.left, y: touch.clientY - bounds.top })
  }
  return points
}

function touchWithIdentifier(
  touches: ReactTouchEvent<HTMLElement>['touches'],
  identifier: number,
) {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index)
    if (touch?.identifier === identifier) return touch
  }
  return null
}

type HistorySnapshot = {
  nodes: MindMapNode[]
  edges: MindMapEdge[]
  signature: string
}

function createPersistedMapContent(nodes: MindMapNode[], edges: MindMapEdge[]) {
  const persistedNodes = structuredClone(nodes).map((node) => {
    const persistedNode = node as MindMapNode & { width?: number; height?: number; resizing?: boolean }
    delete persistedNode.width
    delete persistedNode.height
    delete persistedNode.resizing
    delete node.selected
    delete node.dragging
    delete node.measured
    return node
  })
  const persistedEdges = structuredClone(edges).map((edge) => {
    delete edge.selected
    return edge
  })
  return { nodes: persistedNodes, edges: persistedEdges }
}

function createHistorySnapshot(nodes: MindMapNode[], edges: MindMapEdge[]): HistorySnapshot {
  const content = createPersistedMapContent(nodes, edges)
  return {
    ...content,
    signature: JSON.stringify(content),
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

  // 서버 정규화(진행률 롤업·Ref 원본 동기화) 결과는 사용자 편집이 아니므로
  // 새 undo 단계로 쌓지 않고 기준선만 옮긴다. 확정 대기 중인 사용자 편집은 먼저 단계로 남긴다.
  const rebaseline = useCallback((nextNodes: MindMapNode[], nextEdges: MindMapEdge[]) => {
    commitPending()
    clearCommitTimer()
    baseline.current = createHistorySnapshot(nextNodes, nextEdges)
    pending.current = null
    refreshAvailability()
  }, [clearCommitTimer, commitPending, refreshAvailability])

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

  const cancelTransaction = useCallback(() => {
    transactionActive.current = false
    clearCommitTimer()
    pending.current = null
    refreshAvailability()
  }, [clearCommitTimer, refreshAvailability])

  return { ...availability, undo, redo, resetHistory, rebaseline, beginTransaction, endTransaction, cancelTransaction }
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
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    moon: <path d="M20.4 15.2A8.5 8.5 0 0 1 8.8 3.6 8.5 8.5 0 1 0 20.4 15.2Z"/>,
  }

  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

function KnowledgeConnectionPreview({ canvas, source, policy, issue }: {
  canvas: HTMLElement | null
  source: CanvasRect
  policy: KnowledgePolicy
  issue: string
}) {
  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  }
  const [pointer, setPointer] = useState(sourceCenter)

  useEffect(() => {
    if (!canvas) return
    const followPointer = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect()
      setPointer({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
    }
    window.addEventListener('pointermove', followPointer)
    return () => window.removeEventListener('pointermove', followPointer)
  }, [canvas])

  const deltaX = pointer.x - sourceCenter.x
  const deltaY = pointer.y - sourceCenter.y
  const boundaryRatio = Math.max(
    Math.abs(deltaX) / Math.max(1, source.width / 2),
    Math.abs(deltaY) / Math.max(1, source.height / 2),
  )
  const boundaryScale = boundaryRatio > 1 ? 1 / boundaryRatio : 0
  const start = {
    x: sourceCenter.x + deltaX * boundaryScale,
    y: sourceCenter.y + deltaY * boundaryScale,
  }
  const direction = deltaX >= 0 ? 1 : -1
  const controlOffset = Math.min(220, Math.max(55, Math.abs(deltaX) * .5))
  const path = `M ${start.x} ${start.y} C ${start.x + direction * controlOffset} ${start.y}, ${pointer.x - direction * controlOffset} ${pointer.y}, ${pointer.x} ${pointer.y}`
  const primary = policy === 'reuse-first'

  return (
    <>
      <svg className={`knowledge-connection-preview ${primary ? 'primary' : 'secondary'} ${issue ? 'invalid' : ''}`} aria-hidden="true">
        <defs>
          <marker id="knowledge-connection-preview-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        <path d={path} markerEnd="url(#knowledge-connection-preview-arrow)" />
        <circle cx={pointer.x} cy={pointer.y} r="4" />
      </svg>
      <div
        className={`knowledge-connection-guide ${primary ? 'primary' : 'secondary'} ${issue ? 'invalid' : ''}`}
        style={{ left: pointer.x, top: pointer.y }}
        role="status"
      >
        <strong>{primary ? '주요 지식 연결' : '보조 지식 연결'}</strong>
        <span>{issue || '대상 카드 클릭 · Esc로 취소'}</span>
      </div>
    </>
  )
}

function ThemeToggle({ theme, onToggle, className = '' }: { theme: UiTheme; onToggle: () => void; className?: string }) {
  const darkMode = theme === 'dark'
  const nextThemeLabel = darkMode ? '라이트 모드' : '다크 모드'

  return (
    <button
      className={`theme-switch ${className}`.trim()}
      type="button"
      role="switch"
      aria-checked={darkMode}
      aria-label={`화면 테마: ${darkMode ? '다크 모드' : '라이트 모드'}. ${nextThemeLabel}로 전환`}
      title={`${nextThemeLabel}로 전환`}
      onClick={onToggle}
    >
      <span className="theme-switch-icon theme-switch-sun"><Icon name="sun" size={13} /></span>
      <span className="theme-switch-track" aria-hidden="true"><span className="theme-switch-thumb" /></span>
      <span className="theme-switch-icon theme-switch-moon"><Icon name="moon" size={13} /></span>
    </button>
  )
}

function usageResetLabel(value: string | null) {
  if (!value) return '초기화 시각 알 수 없음'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '초기화 시각 알 수 없음'
  return `${new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)} 초기화`
}

function usageTone(...values: Array<number | null | undefined>) {
  const highest = Math.max(...values.filter((value): value is number => Number.isFinite(value)), 0)
  if (highest >= 100) return 'limit'
  if (highest >= 80) return 'warning'
  return 'normal'
}

function LoadingUsageDots() {
  return <span className="subscription-usage-loading" aria-label="조회 중"><i /><i /><i /></span>
}

const SUBSCRIPTION_USAGE_READY_POLL_MS = 10_000

function AionUiSubscriptionUsageIndicator({ onOpen }: { onOpen?: () => void }) {
  const [usage, setUsage] = useState<AionUiSubscriptionUsage | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    let timer: number | null = null

    const load = async () => {
      let nextDelay = SUBSCRIPTION_USAGE_READY_POLL_MS
      try {
        const result = await apiRequest<{ usage: AionUiSubscriptionUsage }>('/api/integrations/aionui/subscription-usage')
        if (!active) return
        setUsage(result.usage)
        if (result.usage.state === 'loading' || result.usage.state === 'partial') {
          nextDelay = Math.max(1_000, Math.min(10_000, result.usage.retryAfterMs ?? 2_000))
        }
      } catch {
        if (!active) return
        setUsage(null)
      }
      if (active) timer = window.setTimeout(() => { void load() }, nextDelay)
    }

    void load()
    return () => {
      active = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!mobileOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) setMobileOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [mobileOpen])

  useEffect(() => {
    const mobileViewport = window.matchMedia('(max-width: 720px)')
    const closeWhenDesktop = (event: MediaQueryListEvent) => {
      if (!event.matches) setMobileOpen(false)
    }
    mobileViewport.addEventListener('change', closeWhenDesktop)
    return () => mobileViewport.removeEventListener('change', closeWhenDesktop)
  }, [])

  const claude = usage?.claude
  const codex = usage?.codex
  const claudeLoading = claude?.state === 'loading'
  const codexLoading = codex?.state === 'loading'
  const showClaude = claudeLoading || Boolean(claude?.state === 'ready' && !claude.stale && (claude.session || claude.weekly))
  const showCodex = codexLoading || Boolean(codex?.state === 'ready' && !codex.stale && codex.weekly)
  const visibleUsageValues = [
    showClaude ? claude?.session?.usedPercent : null,
    showClaude ? claude?.weekly?.usedPercent : null,
    showCodex ? codex?.weekly?.usedPercent : null,
    showCodex && codex?.limitReached ? 100 : null,
  ].filter((value): value is number => Number.isFinite(value))
  const highestUsage = Math.max(...visibleUsageValues, 0)
  const summaryTone = usageTone(...visibleUsageValues)

  if (!usage?.available || (!showClaude && !showCodex)) return null

  const claudeTitle = claude?.state === 'ready'
    ? [
        'Claude 사용량',
        claude.session ? `5시간 ${Math.round(claude.session.usedPercent)}% · ${usageResetLabel(claude.session.resetsAt)}` : null,
        claude.weekly ? `주간 ${Math.round(claude.weekly.usedPercent)}% · ${usageResetLabel(claude.weekly.resetsAt)}` : null,
      ].filter(Boolean).join('\n')
    : 'Claude 사용량을 조회하고 있습니다.'
  const codexTitle = codex?.state === 'ready' && codex.weekly
    ? `Codex 사용량\n주간 ${Math.round(codex.weekly.usedPercent)}% · ${usageResetLabel(codex.weekly.resetsAt)}`
    : 'Codex 사용량을 조회하고 있습니다.'

  return (
    <div className="subscription-usage-summary" aria-label="AI 구독 사용량" ref={containerRef}>
      {showClaude && <div
        className={`subscription-usage-pill claude ${usageTone(claude?.session?.usedPercent, claude?.weekly?.usedPercent)}`}
        title={claudeTitle}
      >
        <strong>Claude</strong>
        {claudeLoading
          ? <LoadingUsageDots />
          : <span>{[
              claude?.session ? `${Math.round(claude.session.usedPercent)}%` : null,
              claude?.weekly ? `${Math.round(claude.weekly.usedPercent)}%` : null,
            ].filter(Boolean).join(' · ')}</span>}
      </div>}
      {showCodex && <div
        className={`subscription-usage-pill codex ${usageTone(codex?.weekly?.usedPercent, codex?.limitReached ? 100 : null)}`}
        title={codexTitle}
      >
        <strong>Codex</strong>
        {codexLoading ? <LoadingUsageDots /> : <span>{Math.round(codex?.weekly?.usedPercent ?? 0)}%</span>}
      </div>}
      <button
        className={`subscription-usage-mobile-trigger ${summaryTone}`}
        type="button"
        aria-label={`AI 구독 사용량${visibleUsageValues.length > 0 ? `, 최고 ${Math.round(highestUsage)}%` : ', 조회 중'}`}
        aria-haspopup="dialog"
        aria-expanded={mobileOpen}
        aria-controls="mobile-subscription-usage-popover"
        title="AI 구독 사용량"
        onClick={() => setMobileOpen((current) => {
          const next = !current
          if (next) onOpen?.()
          return next
        })}
      >
        {visibleUsageValues.length === 0
          ? <LoadingUsageDots />
          : <><Icon name="chart" size={14} /><span>{Math.round(highestUsage)}%</span></>}
      </button>
      {mobileOpen && <div
        className="subscription-usage-popover"
        id="mobile-subscription-usage-popover"
        role="dialog"
        aria-label="AI 구독 사용량 상세"
      >
        <header>
          <strong>AI 구독 사용량</strong>
          <button type="button" onClick={() => setMobileOpen(false)} aria-label="사용량 상세 닫기">
            <Icon name="close" size={13} />
          </button>
        </header>
        <div className="subscription-usage-provider-list">
          {showClaude && <section className={usageTone(claude?.session?.usedPercent, claude?.weekly?.usedPercent)}>
            <strong>Claude</strong>
            {claudeLoading
              ? <LoadingUsageDots />
              : <div>
                  {claude?.session && <span><b>5시간 {Math.round(claude.session.usedPercent)}%</b><small>{usageResetLabel(claude.session.resetsAt)}</small></span>}
                  {claude?.weekly && <span><b>주간 {Math.round(claude.weekly.usedPercent)}%</b><small>{usageResetLabel(claude.weekly.resetsAt)}</small></span>}
                </div>}
          </section>}
          {showCodex && <section className={usageTone(codex?.weekly?.usedPercent, codex?.limitReached ? 100 : null)}>
            <strong>Codex</strong>
            {codexLoading
              ? <LoadingUsageDots />
              : codex?.weekly && <div><span><b>주간 {Math.round(codex.weekly.usedPercent)}%</b><small>{usageResetLabel(codex.weekly.resetsAt)}</small></span></div>}
          </section>}
        </div>
      </div>}
    </div>
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
  const [expanded, setExpanded] = useState(false)
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false)
  const canResolve = !readOnly && (mode === 'editor' || comment.author.id === user.id)
  const canDelete = !readOnly && (mode === 'editor' || comment.author.id === user.id)
  const mentionNames = collaborators.map((collaborator) => collaborator.name)
  const structured = comment.contentFormat === 'summary-detail'
  const summary = structured ? comment.summary ?? comment.text : comment.text
  const detail = structured ? comment.detail?.trim() : ''
  const detailId = `comment-detail-${comment.id}`
  const expandable = Boolean(detail) || !readOnly
  const toggleExpanded = () => {
    setExpanded((open) => !open)
    setReactionPickerOpen(false)
  }
  const isInteractiveTarget = (target: EventTarget | null) => Boolean((target as HTMLElement | null)?.closest?.('a, button'))
  const hasSelectionInside = (container: HTMLElement) => {
    const selection = window.getSelection()
    return Boolean(selection && !selection.isCollapsed && selection.toString().trim() && container.contains(selection.anchorNode))
  }
  const reactedEmojis = COMMENT_REACTIONS.filter((emoji) => (comment.reactions?.[emoji] ?? []).length > 0)
  const reactionTitle = (emoji: CommentReaction) => {
    const names = (comment.reactions?.[emoji] ?? [])
      .map((userId) => collaborators.find((candidate) => candidate.id === userId)?.name)
      .filter(Boolean)
      .join(', ')
    return names || `${emoji} 반응 추가`
  }

  return (
    <article className={`comment-item ${isReply ? 'reply' : ''} ${comment.resolvedAt ? 'resolved' : ''}`}>
      <span className="comment-avatar">{comment.author.name.replace(/\s/g, '').slice(0, 2)}</span>
      <div className="comment-body">
        <header>
          <span><strong>{comment.author.name}</strong>{comment.resolvedAt && <i>해결됨</i>}</span>
          <time>{new Date(comment.createdAt).toLocaleString('ko-KR')}</time>
        </header>
        <p
          className={`comment-summary ${expandable ? 'expandable' : ''} ${detail ? 'has-detail' : ''} ${expanded ? 'expanded' : ''}`}
          {...(expandable ? {
            role: 'button',
            tabIndex: 0,
            'aria-expanded': expanded,
            'aria-controls': detailId,
            onClick: (event: { target: EventTarget | null; currentTarget: HTMLParagraphElement }) => {
              if (isInteractiveTarget(event.target) || hasSelectionInside(event.currentTarget)) return
              toggleExpanded()
            },
            onKeyDown: (event: { key: string; target: EventTarget | null; preventDefault: () => void }) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              if (isInteractiveTarget(event.target)) return
              event.preventDefault()
              toggleExpanded()
            },
          } : {})}
        >
          <MentionText text={summary} names={mentionNames} />
        </p>
        {expanded && (
          <div className="comment-expanded" id={detailId}>
            {detail && <div className="comment-detail"><MentionText text={detail} names={mentionNames} /></div>}
            {!readOnly && (
              <div className="comment-actions">
                {reactedEmojis.map((emoji) => (
                  <button type="button" className={`comment-reaction ${(comment.reactions?.[emoji] ?? []).includes(user.id) ? 'active' : ''}`} key={emoji} onClick={() => onReaction(comment, emoji)} title={reactionTitle(emoji)}>
                    <span>{emoji}</span><b>{(comment.reactions?.[emoji] ?? []).length}</b>
                  </button>
                ))}
                {reactionPickerOpen
                  ? COMMENT_REACTIONS.filter((emoji) => !reactedEmojis.includes(emoji)).map((emoji) => (
                    <button type="button" className="comment-reaction" key={emoji} onClick={() => { onReaction(comment, emoji); setReactionPickerOpen(false) }} title={`${emoji} 반응 추가`}>
                      <span>{emoji}</span>
                    </button>
                  ))
                  : <button type="button" className="comment-reaction-add" aria-expanded={false} onClick={() => setReactionPickerOpen(true)} aria-label="반응 추가" title="반응 추가">＋</button>}
                <button type="button" className="comment-reply" onClick={() => onReply(comment)}>답글</button>
                {canResolve && <button type="button" className="comment-resolve" onClick={() => onResolve(comment)}>{comment.resolvedAt ? '다시 열기' : '해결'}</button>}
              </div>
            )}
          </div>
        )}
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

async function fetchDoorayKnowledgePreview(url: string): Promise<DoorayKnowledgePreview> {
  const provider = taskUrlProvider(url)
  if (provider === 'dooray-task') {
    const { task } = await apiRequest<{ task: DoorayTaskPreview }>('/api/integrations/dooray/task-preview', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
    return task
  }
  if (provider === 'dooray-wiki') {
    const { wiki } = await apiRequest<{ wiki: DoorayWikiPreview }>('/api/integrations/dooray/wiki-preview', {
      method: 'POST',
      body: JSON.stringify({ url }),
    })
    return wiki
  }
  throw new Error('올바른 Dooray 업무 또는 Wiki URL을 입력해 주세요.')
}

async function uploadMindMapImage(mapId: string, file: File) {
  const response = await fetch(`/api/maps/${encodeURIComponent(mapId)}/images`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-MNP-Client': CLIENT_ID,
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  })
  const body = await response.json().catch(() => ({})) as {
    image?: { assetId: string; mimeType: MindImageData['mimeType'] }
    error?: string
  }
  if (!response.ok || !body.image) {
    throw new ApiRequestError(body.error ?? '이미지를 업로드하지 못했습니다.', response.status, body)
  }
  return body.image
}

async function imageFileDimensions(file: File) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    try {
      return { width: bitmap.width, height: bitmap.height }
    } finally {
      bitmap.close()
    }
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    return await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => reject(new Error('이미지 크기를 확인하지 못했습니다.'))
      image.src = objectUrl
    })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function defaultImageDisplaySize(naturalWidth: number, naturalHeight: number) {
  const scale = Math.min(1, MINDMAP_IMAGE_MAX_WIDTH / naturalWidth, MINDMAP_IMAGE_MAX_HEIGHT / naturalHeight)
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  }
}

function imageAssetUrl(mapId: string, assetId: string) {
  return `/api/maps/${encodeURIComponent(mapId)}/images/${encodeURIComponent(assetId)}`
}

function isSupportedImageFile(file: File) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type) || (!file.type && SUPPORTED_IMAGE_FILE_PATTERN.test(file.name))
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

function LoginScreen({ onAuthenticated, theme, onToggleTheme }: { onAuthenticated: (user: AuthUser) => void; theme: UiTheme; onToggleTheme: () => void }) {
  const formRef = useRef<HTMLFormElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const rememberMeRef = useRef<HTMLInputElement>(null)
  const loginButtonRef = useRef<HTMLButtonElement>(null)
  const [email, setEmail] = useState(() => localStorage.getItem(LAST_LOGIN_EMAIL_KEY) ?? '')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const form = formRef.current
    if (!form) return
    const moveFocusOnTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = Array.from(form.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
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
        <div className="login-eyebrow">
          <span>Mind & Progress</span>
          <small>AI Collaboration</small>
        </div>
        <h1>업무의 맥락을 연결하고,<br />AI와 함께 완성하세요.</h1>
        <p>업무·지식·대화의 맥락을 하나의 맵에 연결하고, 사람과 AI가 계획부터 완료까지 함께 진행합니다.</p>
        <div className="login-feature-tags" aria-hidden="true">
          <span>업무 관리</span>
          <span>공유 지식</span>
          <span>AI 대화</span>
        </div>
        <div className="login-map-preview" aria-hidden="true">
          <svg viewBox="0 0 520 136" role="presentation">
            <path className="login-preview-edge" d="M126 94C153 81 177 50 206 32" />
            <path className="login-preview-edge" d="M126 103H190" />
            <path className="login-preview-edge knowledge-edge" d="M269 56V77" />
            <path className="login-preview-edge" d="M348 103H386" />

            <g className="login-preview-card root-card">
              <rect x="8" y="78" width="118" height="50" rx="12" />
              <text x="67" y="103">업무 목표</text>
            </g>
            <g className="login-preview-card knowledge-card">
              <rect x="206" y="8" width="126" height="48" rx="12" />
              <text x="269" y="32">공유 지식</text>
            </g>
            <g className="login-preview-card ai-card">
              <rect x="190" y="77" width="158" height="52" rx="12" />
              <circle className="preview-ai-dot dot-one" cx="211" cy="103" r="3" />
              <circle className="preview-ai-dot dot-two" cx="221" cy="103" r="3" />
              <circle className="preview-ai-dot dot-three" cx="231" cy="103" r="3" />
              <text x="290" y="103">AI 작업 중</text>
            </g>
            <g className="login-preview-card result-card">
              <rect x="386" y="79" width="126" height="48" rx="12" />
              <text x="449" y="103">결과 기록 ✓</text>
            </g>
          </svg>
        </div>
      </section>

      <section className="login-panel">
        <form ref={formRef} className="login-card" onSubmit={(event) => { event.preventDefault(); void login() }}>
          <div className="login-card-heading">
            <span>AI 협업 워크스페이스</span>
            <ThemeToggle theme={theme} onToggle={onToggleTheme} className="login-theme-switch" />
            <h2>작업을 이어가세요</h2>
            <p>로그인하면 편집 권한과 연결된 AI 대화를 이어갈 수 있습니다.</p>
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
          <a className="viewer-entry-link" href="/mindmap/"><Icon name="external" size={13} /><span>로그인 없이 읽기 전용으로 보기</span></a>
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
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'))
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

function Workspace({ user, onLogout, initialDeepLink, theme, onToggleTheme }: { user: AuthUser; onLogout: () => void; initialDeepLink: WorkspaceDeepLink | null; theme: UiTheme; onToggleTheme: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<MindMapNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<MindMapEdge>([])
  const { canUndo, canRedo, undo, redo, resetHistory, rebaseline: rebaselineHistory, beginTransaction: beginHistoryTransaction, endTransaction: endHistoryTransaction, cancelTransaction: cancelHistoryTransaction } = useMapHistory(nodes, setNodes, edges, setEdges)
  const mode: AccessMode = user.role === 'viewer' ? 'viewer' : 'editor'
  const [adminOpen, setAdminOpen] = useState(false)
  const closeAdminPanel = useCallback(() => setAdminOpen(false), [])
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [aiDialogOpen, setAiDialogOpen] = useState(false)
  const [aiConversationLaunch, setAiConversationLaunch] = useState<AiConversationExplicitTarget & { initialRequest: string } | null>(null)
  const [aiConversationPicker, setAiConversationPicker] = useState<{ mapId: string; cardId: string; cardTitle: string } | null>(null)
  const [aionUiWebNavigation, setAionUiWebNavigation] = useState(() => ({
    baseUrl: defaultAionUiWebBaseUrl(),
    configured: false,
  }))
  const [previewImageNodeId, setPreviewImageNodeId] = useState<string | null>(null)
  const [nodeLinkCopyStatus, setNodeLinkCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [doorayUrlDraft, setDoorayUrlDraft] = useState('')
  const [doorayUrlUpdateState, setDoorayUrlUpdateState] = useState<'idle' | 'updating' | 'error'>('idle')
  const [doorayUrlUpdateError, setDoorayUrlUpdateError] = useState('')
  const lastWorkspaceLocation = useRef(readStoredWorkspaceLocation(user.id))
  const [viewMode, setViewMode] = useState<ViewMode>(initialDeepLink?.viewMode ?? lastWorkspaceLocation.current?.viewMode ?? 'mindmap')
  const [documents, setDocuments] = useState<MapSummary[]>([])
  const [documentLayout, setDocumentLayout] = useState<DocumentLayout>(EMPTY_DOCUMENT_LAYOUT)
  const storedCollapsedDocumentGroupIds = useRef(readStoredCollapsedDocumentGroupIds(user.id))
  const collapsedDocumentGroupsInitialized = useRef(false)
  const knownDocumentGroupIds = useRef(new Set<string>())
  const [collapsedDocumentGroupIds, setCollapsedDocumentGroupIds] = useState<Set<string>>(() => new Set())
  const [trashedDocuments, setTrashedDocuments] = useState<MapSummary[]>([])
  const [selectedTrashIds, setSelectedTrashIds] = useState<Set<string>>(() => new Set())
  const [trashDeleting, setTrashDeleting] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)
  const [activeMapId, setActiveMapId] = useState('')
  const [miniMapReadyMapId, setMiniMapReadyMapId] = useState<string | null>(null)
  const [loadedMapId, setLoadedMapId] = useState<string | null>(null)
  const [mapReloadToken, setMapReloadToken] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sharedKnowledgeReviewOpen, setSharedKnowledgeReviewOpen] = useState(false)
  const [historyTab, setHistoryTab] = useState<'changes' | 'daily'>('changes')
  const [mapRevisions, setMapRevisions] = useState<MapRevisionSummary[]>([])
  const [dailyBackups, setDailyBackups] = useState<DailyBackupSummary[]>([])
  const [dailyBackupPreview, setDailyBackupPreview] = useState<DailyBackupPreview | null>(null)
  const [dailyBackupPreviewLoadingDate, setDailyBackupPreviewLoadingDate] = useState<string | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(null)
  const [historyPaginationError, setHistoryPaginationError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [externalChange, setExternalChange] = useState<MapChangeEvent | null>(null)
  const [presenceClients, setPresenceClients] = useState<PresenceClient[]>([])
  const [liveCursors, setLiveCursors] = useState<Record<string, LiveCursor>>({})
  const [aiConversationRuntimes, setAiConversationRuntimes] = useState<Record<string, AiConversationRuntime>>({})
  const [aiConversationActiveCounts, setAiConversationActiveCounts] = useState<Record<string, number>>({})
  const [mergeNotice, setMergeNotice] = useState('')
  const [comments, setComments] = useState<NodeComment[]>([])
  const [commentStats, setCommentStats] = useState<NodeCommentStats>({})
  const [referenceCommentStats, setReferenceCommentStats] = useState<NodeCommentStats>({})
  const [unresolvedReferenceNodeIds, setUnresolvedReferenceNodeIds] = useState<Set<string>>(new Set())
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentError, setCommentError] = useState('')
  const [newComment, setNewComment] = useState('')
  const [newCommentDetail, setNewCommentDetail] = useState('')
  const [commentDetailOpen, setCommentDetailOpen] = useState(false)
  const [replyTarget, setReplyTarget] = useState<NodeComment | null>(null)
  const [replySummary, setReplySummary] = useState('')
  const [replyDetail, setReplyDetail] = useState('')
  const [replyDetailOpen, setReplyDetailOpen] = useState(false)
  const [replyError, setReplyError] = useState('')
  const replyInputRef = useRef<HTMLTextAreaElement | null>(null)
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
  const [contentTooltip, setContentTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)
  const [knowledgeConnection, setKnowledgeConnection] = useState<KnowledgeConnectionDraft | null>(null)
  const [knowledgeConnectionTargetId, setKnowledgeConnectionTargetId] = useState<string | null>(null)
  const [knowledgeConnectionMessage, setKnowledgeConnectionMessage] = useState('')
  const [documentContextMenu, setDocumentContextMenu] = useState<{ x: number; y: number; mapId: string } | null>(null)
  const [aiConversationContextMenu, setAiConversationContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [canvasPasteMenu, setCanvasPasteMenu] = useState<{ x: number; y: number } | null>(null)
  const paneRightPressRef = useRef({ x: 0, y: 0 })
  const [copiedNodes, setCopiedNodes] = useState<CopiedNodes | null>(null)
  const [copiedImages, setCopiedImages] = useState<CopiedImages | null>(null)
  const [draggingLibraryItem, setDraggingLibraryItem] = useState<DocumentLayoutItem | null>(null)
  const [documentDropTargetId, setDocumentDropTargetId] = useState<string | null>(null)
  const documentListRef = useRef<HTMLElement | null>(null)
  const documentListAutoScrollFrameRef = useRef<number | null>(null)
  const documentListAutoScrollSpeedRef = useRef(0)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [rightPanning, setRightPanning] = useState(false)
  const [touchPanning, setTouchPanning] = useState(false)
  const [gridGuideVisible, setGridGuideVisible] = useState(false)
  const gridGuideVisibleRef = useRef(false)
  const gridGuideEnabled = mode === 'editor' && viewMode === 'mindmap'
  // 브라우저가 Alt 키 이벤트를 가져가는 경우가 있어(창 메뉴 활성화 등) 마우스 이동으로도 상태를 맞춘다.
  const applyGridGuide = useCallback((altPressed: boolean) => {
    const next = altPressed && gridGuideEnabled
    if (gridGuideVisibleRef.current === next) return
    gridGuideVisibleRef.current = next
    setGridGuideVisible(next)
  }, [gridGuideEnabled])
  const [boxSelectionArmed, setBoxSelectionArmed] = useState(false)
  const [boxSelectionScreenRect, setBoxSelectionScreenRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = Number(localStorage.getItem('mindnprogress-sidebar-width'))
    return Number.isFinite(savedWidth) ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, savedWidth)) : 226
  })
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const savedWidth = Number(localStorage.getItem('mindnprogress-inspector-width'))
    return Number.isFinite(savedWidth) ? Math.min(520, Math.max(240, savedWidth)) : 278
  })
  const [inspectorTextareaHeights, setInspectorTextareaHeights] = useState<InspectorTextareaHeights>(
    () => readInspectorTextareaHeights(user.id),
  )
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [resizingInspector, setResizingInspector] = useState(false)
  const sidebarMinWidth = Object.values(aiConversationActiveCounts).some((count) => count > 0)
    ? SIDEBAR_AI_ACTIVITY_MIN_WIDTH
    : SIDEBAR_MIN_WIDTH
  const effectiveSidebarWidth = Math.max(sidebarMinWidth, sidebarWidth)
  const skipChecklistCommit = useRef(false)
  const waitingBlockRef = useRef<HTMLDivElement | null>(null)

  const stopDocumentListAutoScroll = useCallback(() => {
    documentListAutoScrollSpeedRef.current = 0
    if (documentListAutoScrollFrameRef.current === null) return
    window.cancelAnimationFrame(documentListAutoScrollFrameRef.current)
    documentListAutoScrollFrameRef.current = null
  }, [])

  const startDocumentListAutoScroll = useCallback((speed: number) => {
    documentListAutoScrollSpeedRef.current = speed
    if (speed === 0) {
      stopDocumentListAutoScroll()
      return
    }
    if (documentListAutoScrollFrameRef.current !== null) return

    const scroll = () => {
      const list = documentListRef.current
      const currentSpeed = documentListAutoScrollSpeedRef.current
      if (!list || currentSpeed === 0) {
        documentListAutoScrollFrameRef.current = null
        return
      }
      list.scrollTop += currentSpeed
      documentListAutoScrollFrameRef.current = window.requestAnimationFrame(scroll)
    }
    documentListAutoScrollFrameRef.current = window.requestAnimationFrame(scroll)
  }, [stopDocumentListAutoScroll])

  const updateDocumentListAutoScroll = useCallback((clientY: number) => {
    const list = documentListRef.current
    if (!list) return
    const bounds = list.getBoundingClientRect()
    const topDistance = clientY - bounds.top
    const bottomDistance = bounds.bottom - clientY
    if (topDistance >= 0 && topDistance < DOCUMENT_LIST_AUTO_SCROLL_EDGE_PX) {
      const strength = 1 - topDistance / DOCUMENT_LIST_AUTO_SCROLL_EDGE_PX
      startDocumentListAutoScroll(-Math.max(1, DOCUMENT_LIST_AUTO_SCROLL_MAX_SPEED_PX * strength))
      return
    }
    if (bottomDistance >= 0 && bottomDistance < DOCUMENT_LIST_AUTO_SCROLL_EDGE_PX) {
      const strength = 1 - bottomDistance / DOCUMENT_LIST_AUTO_SCROLL_EDGE_PX
      startDocumentListAutoScroll(Math.max(1, DOCUMENT_LIST_AUTO_SCROLL_MAX_SPEED_PX * strength))
      return
    }
    stopDocumentListAutoScroll()
  }, [startDocumentListAutoScroll, stopDocumentListAutoScroll])

  useEffect(() => {
    if (!draggingLibraryItem) stopDocumentListAutoScroll()
  }, [draggingLibraryItem, stopDocumentListAutoScroll])

  useEffect(() => () => stopDocumentListAutoScroll(), [stopDocumentListAutoScroll])

  const dependencyBlockRef = useRef<HTMLDivElement | null>(null)
  const canvasWrapRef = useRef<HTMLElement | null>(null)
  const sidebarResizeStart = useRef({ pointerX: 0, width: 226 })
  const inspectorResizeStart = useRef({ pointerX: 0, width: 278 })
  const descriptionTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const sharedKnowledgeTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const dropTargetIdRef = useRef<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState('서버에서 불러오는 중…')
  const [saveError, setSaveError] = useState('')
  const [serverBaselineRevision, setServerBaselineRevision] = useState(0)
  const dragSnapshot = useRef<DragSnapshot | null>(null)
  const rightPanGesture = useRef<RightPanGesture | null>(null)
  const boxSelectionGesture = useRef<BoxSelectionGesture | null>(null)
  const suppressBoxSelectionClick = useRef(false)
  const visibleFlowNodeIdsRef = useRef<Set<string>>(new Set())
  const touchPanGesture = useRef<TouchPanGesture | null>(null)
  const touchCanvasPanGesture = useRef<TouchCanvasPanGesture | null>(null)
  const touchPanOwned = useRef(false)
  const touchPaneGesture = useRef<TouchPaneGesture | null>(null)
  const touchCardGesture = useRef<TouchCardGesture | null>(null)
  const lastTouchCardTap = useRef<TouchCardTap | null>(null)
  const suppressNodeContextMenuUntil = useRef(0)
  const suppressTouchClickUntil = useRef(0)
  const suppressTouchContextMenu = useRef<{ nodeId: string; until: number } | null>(null)
  const suppressMobileInspectorSelection = useRef<string | null>(null)
  const serverBaseline = useRef<MapDocument | null>(null)
  const pastedNodeNotificationSuppressions = useRef<Map<string, Set<string>>>(new Map())
  const cursorSendAt = useRef(0)
  const nodeLinkCopyTimer = useRef<number | null>(null)
  const doorayUrlCommitTimer = useRef<number | null>(null)
  const pendingSelection = useRef<string | null>(null)
  const pendingDeepLink = useRef(initialDeepLink)
  const lastLoadedMapId = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(selectedId)
  const focusedNodeIdRef = useRef<string | null>(null)
  const activeMapIdRef = useRef(activeMapId)
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const canvasPointerRef = useRef({ inside: false, x: 0, y: 0 })
  const resolvingDoorayUrls = useRef(new Set<string>())
  const refreshingDoorayKnowledgeCards = useRef(new Set<string>())
  const pendingDooraySourceUrls = useRef(new Map<string, string>())
  const selectedCommentTargetRef = useRef<{ mapId: string; nodeId: string } | null>(null)
  const referenceCommentTargetsRef = useRef<ReferenceCommentTarget[]>([])
  selectedIdRef.current = selectedId
  activeMapIdRef.current = activeMapId
  nodesRef.current = nodes
  edgesRef.current = edges

  useEffect(() => {
    const mobileViewport = window.matchMedia('(max-width: 720px)')
    const closeMobilePanelsOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) return
      setMobileSidebarOpen(false)
      setMobileInspectorOpen(false)
    }
    mobileViewport.addEventListener('change', closeMobilePanelsOnDesktop)
    return () => mobileViewport.removeEventListener('change', closeMobilePanelsOnDesktop)
  }, [])

  useEffect(() => {
    if (!selectedId) {
      suppressMobileInspectorSelection.current = null
      setMobileInspectorOpen(false)
      return
    }
    const suppressedNodeId = suppressMobileInspectorSelection.current
    suppressMobileInspectorSelection.current = null
    if (suppressedNodeId === selectedId) {
      setMobileInspectorOpen(false)
      return
    }
    if (window.matchMedia('(max-width: 720px)').matches) setMobileInspectorOpen(true)
  }, [selectedId])
  const reconcileRemoteMap = useCallback((remoteMap: MapDocument) => {
    if (activeMapIdRef.current !== remoteMap.id) return
    const baseline = serverBaseline.current
    if (baseline?.id === remoteMap.id && remoteMap.version <= baseline.version) return

    const localContent = createPersistedMapContent(nodesRef.current, edgesRef.current)
    const reconciliation = reconcileRemoteMapContent(baseline, localContent, remoteMap)
    const currentSelectedId = selectedIdRef.current
    const nextSelectedId = currentSelectedId && reconciliation.nodes.some((node) => node.id === currentSelectedId)
      ? currentSelectedId
      : reconciliation.nodes[0]?.id ?? null
    const nextNodes = synchronizeNodeSelection(reconciliation.nodes, nextSelectedId)

    serverBaseline.current = structuredClone(remoteMap)
    resetHistory(nextNodes, reconciliation.edges)
    setNodes(nextNodes)
    setEdges(reconciliation.edges)
    setSelectedId(nextSelectedId)
    setDocuments((current) => current.map((document) => document.id === remoteMap.id
      ? {
          ...document,
          title: remoteMap.title,
          color: remoteMap.color,
          nodeCount: remoteMap.nodes.length,
          version: remoteMap.version,
          updatedAt: remoteMap.updatedAt,
          updatedBy: remoteMap.updatedBy,
        }
      : document))
    localStorage.setItem(storageKeyForMap(remoteMap.id), JSON.stringify({
      nodes: nextNodes,
      edges: reconciliation.edges,
    }))
    setExternalChange(null)

    if (reconciliation.needsSave) {
      setMergeNotice(reconciliation.conflicts > 0
        ? `외부 변경과 로컬 수정을 병합했습니다. 겹친 ${reconciliation.conflicts}개 항목은 내 변경을 유지했습니다.`
        : '외부 변경과 로컬 수정을 병합했습니다.')
      setSavedAt('병합 내용 저장 대기 중…')
      window.setTimeout(() => setMergeNotice(''), 5000)
    } else {
      setSavedAt('서버와 동기화됨')
    }
  }, [resetHistory, setEdges, setNodes])
  const handleSharedKnowledgeReviewApplied = useCallback((applied: SharedKnowledgeReviewApplied) => {
    setDocuments((current) => current.map((document) => document.id === applied.document.id
      ? {
          ...document,
          title: applied.document.title,
          version: applied.document.version,
          updatedAt: applied.document.updatedAt,
        }
      : document))
    if (activeMapIdRef.current !== applied.mapId) return
    void apiRequest<MapDocumentResponse>(`/api/maps/${encodeURIComponent(applied.mapId)}`)
      .then(({ map }) => reconcileRemoteMap(map))
      .catch((error) => {
        setSaveError(error instanceof Error
          ? `공유 지식 검토는 저장되었지만 화면을 갱신하지 못했습니다: ${error.message}`
          : '공유 지식 검토는 저장되었지만 화면을 갱신하지 못했습니다.')
      })
  }, [reconcileRemoteMap])
  const acceptSavedMap = useCallback((savedMap: MapDocument, sentContent: Pick<MapDocument, 'nodes' | 'edges'>) => {
    if (activeMapIdRef.current !== savedMap.id) return
    const baseline = serverBaseline.current
    if (baseline?.id === savedMap.id && savedMap.version < baseline.version) return

    const currentContent = createPersistedMapContent(nodesRef.current, edgesRef.current)
    const reconciliation = reconcileRemoteMapContent(sentContent, currentContent, savedMap)
    serverBaseline.current = structuredClone(savedMap)
    if (!mapContentsEqual(currentContent, reconciliation)) {
      const currentSelectedId = selectedIdRef.current
      // 선택 카드가 사라졌으면 선택을 해제한다. 첫 카드로 넘기면 실행 취소 도중 최상위 카드가 갑자기 선택된다.
      const nextSelectedId = currentSelectedId && reconciliation.nodes.some((node) => node.id === currentSelectedId)
        ? currentSelectedId
        : null
      const nextNodes = synchronizeNodeSelection(reconciliation.nodes, nextSelectedId)
      setNodes(nextNodes)
      setEdges(reconciliation.edges)
      setSelectedId(nextSelectedId)
      rebaselineHistory(nextNodes, reconciliation.edges)
      localStorage.setItem(storageKeyForMap(savedMap.id), JSON.stringify({
        nodes: nextNodes,
        edges: reconciliation.edges,
      }))
    }
    setServerBaselineRevision((current) => current + 1)
  }, [rebaselineHistory, setEdges, setNodes])
  const { fitView, screenToFlowPosition, setCenter, setViewport } = useReactFlow<MindMapNode, MindMapEdge>()
  const reactFlowStore = useStoreApi<MindMapNode, MindMapEdge>()
  const showFullMindMap = useCallback((duration = 500) => {
    focusedNodeIdRef.current = null
    void fitView({ padding: 0.2, duration })
  }, [fitView])
  const toggleNodeFocus = useCallback((nodeId: string) => {
    if (focusedNodeIdRef.current === nodeId) {
      showFullMindMap()
      return
    }

    const targetNode = nodesRef.current.find((node) => node.id === nodeId)
    if (!targetNode) return
    const { width, height } = nodeDimensions(targetNode)
    focusedNodeIdRef.current = nodeId
    void setCenter(
      targetNode.position.x + width / 2,
      targetNode.position.y + height / 2,
      { zoom: MINDMAP_MAX_ZOOM, duration: 500 },
    )
  }, [setCenter, showFullMindMap])
  const nodesInitialized = useNodesInitialized()
  const updateNodeInternals = useUpdateNodeInternals()
  const viewport = useViewport()
  const knowledgeConnectionSourceBox = useMemo<CanvasRect | null>(() => {
    if (!knowledgeConnection) return null
    const source = nodes.find((node) => node.id === knowledgeConnection.sourceId)
    if (!source) return null
    const { width, height } = nodeDimensions(source)
    return {
      x: source.position.x * viewport.zoom + viewport.x,
      y: source.position.y * viewport.zoom + viewport.y,
      width: width * viewport.zoom,
      height: height * viewport.zoom,
    }
  }, [knowledgeConnection, nodes, viewport.x, viewport.y, viewport.zoom])

  useEffect(() => {
    Object.keys(localStorage)
      .filter((key) => key === 'mindnprogress-demo-v1' || key.startsWith('mindnprogress-demo-v1:'))
      .forEach((key) => localStorage.removeItem(key))
  }, [])

  useEffect(() => {
    let cancelled = false
    void apiRequest<{ aionUiWebBaseUrl?: string; aionUiWebConfigured?: boolean }>('/api/health')
      .then((health) => {
        if (cancelled || !health.aionUiWebBaseUrl) return
        setAionUiWebNavigation({
          baseUrl: health.aionUiWebBaseUrl.replace(/\/+$/, ''),
          configured: health.aionUiWebConfigured === true,
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const progressRollups = useMemo(() => new Map(computeProgressRollups(nodes, edges)
    .map((rollup) => [rollup.nodeId, rollup])), [edges, nodes])
  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null
  // Alt 격자에서 선택 카드의 좌상단 꼭짓점을 지나는 기준선. 격자보다 진하게 둔다.
  // Alt를 떼는 동안에도 사라지는 모습이 보이도록 표시 여부와 무관하게 좌표를 유지한다.
  const gridGuideAlignment = useMemo(() => {
    if (!selectedNode) return null
    return {
      x: selectedNode.position.x * viewport.zoom + viewport.x,
      y: selectedNode.position.y * viewport.zoom + viewport.y,
    }
  }, [selectedNode, viewport.x, viewport.y, viewport.zoom])
  const selectedProgressRollup = selectedNode ? progressRollups.get(selectedNode.id) : undefined
  const selectedProgress = selectedProgressRollup?.progress ?? selectedNode?.data.progress ?? 0
  const selectedStatus = selectedProgressRollup?.status ?? selectedNode?.data.status ?? 'planned'
  const selectedHasWaitingItems = Boolean(selectedNode?.data.waitingItems?.some((item) => item.label.trim()))
  const selectedDoorayKnowledgeNode = selectedNode && isDoorayKnowledgeCard(selectedNode.data)
    ? selectedNode
    : null
  const selectedDoorayKnowledgeLink = selectedDoorayKnowledgeNode?.data.externalLink ?? null
  const selectedDoorayKnowledgeIsWiki = selectedDoorayKnowledgeLink?.provider === 'dooray-wiki'
  const selectedDoorayKnowledgeEditable = mode === 'editor' && !selectedDoorayKnowledgeNode?.data.reference
  const previewImageNode = previewImageNodeId
    ? nodes.find((node) => node.id === previewImageNodeId && node.data.kind === 'image') ?? null
    : null
  const contextMenuNode = nodeContextMenu ? nodes.find((node) => node.id === nodeContextMenu.nodeId) ?? null : null
  const contextMenuImageCount = contextMenuNode?.data.kind === 'image' && contextMenuNode.selected
    ? Math.max(1, nodes.filter((node) => node.selected && node.data.kind === 'image').length)
    : 1

  useEffect(() => {
    if (doorayUrlCommitTimer.current !== null) {
      window.clearTimeout(doorayUrlCommitTimer.current)
      doorayUrlCommitTimer.current = null
    }
    setDoorayUrlDraft(selectedDoorayKnowledgeLink?.url ?? '')
    setDoorayUrlUpdateState('idle')
    setDoorayUrlUpdateError('')
  }, [selectedDoorayKnowledgeLink?.url, selectedDoorayKnowledgeNode?.id])

  useEffect(() => () => {
    if (doorayUrlCommitTimer.current !== null) window.clearTimeout(doorayUrlCommitTimer.current)
  }, [])
  const selectedReferenceReadOnly = mode === 'viewer' || Boolean(selectedNode?.data.reference)
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

  const openDependencies = useCallback((nodeId: string) => {
    setSelectedId(nodeId)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        dependencyBlockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  const hoveredKnowledgeConnectionIssue = useMemo(() => (
    knowledgeConnection && knowledgeConnectionTargetId
      ? knowledgeConnectionIssue(knowledgeConnection.sourceId, knowledgeConnectionTargetId, nodes, knowledgeEdges)
      : ''
  ), [knowledgeConnection, knowledgeConnectionTargetId, knowledgeEdges, nodes])
  const selectedKnowledgeEdges = useMemo(() => selectedNode
    ? knowledgeEdges.filter((edge) => edge.target === selectedNode.id)
    : [], [knowledgeEdges, selectedNode])
  const availableKnowledgeSources = useMemo(() => selectedNode
    ? nodes.filter((node) => node.id !== selectedNode.id
      && !selectedKnowledgeEdges.some((edge) => edge.source === node.id)
      && !createsKnowledgeCycle(node.id, selectedNode.id, knowledgeEdges))
    : [], [knowledgeEdges, nodes, selectedKnowledgeEdges, selectedNode])
  const aiConversationTarget = useMemo(() => resolveAiConversationTarget({
    explicitTarget: aiConversationLaunch,
    selection: {
      open: aiDialogOpen,
      mapId: selectedCommentMapId,
      cardId: selectedCommentNodeId ?? selectedNode?.id,
      cardLabel: selectedNode?.data.label,
      cardKind: selectedNode?.data.kind,
      isReference: Boolean(selectedNode?.data.reference),
      documentTitle: activeDocument
        ? documents.find((document) => document.id === selectedCommentMapId)?.title ?? activeDocument.title
        : null,
      knowledgeSources: selectedKnowledgeEdges.flatMap((edge) => {
        const source = nodes.find((node) => node.id === edge.source)
        return source ? [{ id: source.id, label: source.data.label, policy: knowledgePolicyOf(edge) }] : []
      }),
    },
  }), [activeDocument, aiConversationLaunch, aiDialogOpen, documents, nodes, selectedCommentMapId, selectedCommentNodeId, selectedKnowledgeEdges, selectedNode])
  const closeAiConversationDialog = useCallback(() => {
    setAiConversationLaunch(null)
    setAiDialogOpen(false)
  }, [])
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
    if (node.data.kind === 'image') return true
    const progressRollup = progressRollups.get(node.id)
    const progress = progressRollup?.progress ?? node.data.progress
    const status = progress >= 100 ? 'done' : progressRollup?.status ?? node.data.status
    const statusMatches = nodeFilter === 'all'
      || nodeFilter === 'work' && Boolean(node.data.isWork)
      || nodeFilter === 'blocked' && blockingNodes(node, nodes).length > 0
      || nodeFilter === status
    const assigneeMatches = assigneeFilter === 'all'
      || Boolean(node.data.isWork) && assigneeFilter === 'unassigned' && !node.data.assigneeId
      || Boolean(node.data.isWork) && node.data.assigneeId === assigneeFilter
    return statusMatches && assigneeMatches
  }).map((node) => node.id)), [assigneeFilter, nodeFilter, nodes, progressRollups])
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
    const image = node.data.kind === 'image' ? node.data.image : undefined
    const externalLink = isDoorayKnowledgeCard(node.data)
      ? node.data.externalLink
      : undefined
    const progressRollup = progressRollups.get(node.id)
    const blocking = blockingNodes(node, nodes)
    const applyImageResize = image ? (resize: ResizeSnapRequest) => {
      const resized = resize.snapAxis
        ? snapAspectResizeToGrid(resize, {
            gridSize: MINDMAP_GRID_SIZE,
            aspectRatio: image.naturalWidth / image.naturalHeight,
            minWidth: 48,
            minHeight: 48,
            maxWidth: 2_000,
            maxHeight: 2_000,
          })
        : resize
      const displayWidth = Math.max(1, Math.min(2_000, resized.width))
      const displayHeight = displayWidth * image.naturalHeight / image.naturalWidth
      setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? {
            ...candidate,
            width: displayWidth,
            height: displayHeight,
            measured: { width: displayWidth, height: displayHeight },
            ...(resize.snapAxis ? { position: { x: resized.x, y: resized.y } } : {}),
            data: {
              ...candidate.data,
              image: candidate.data.image
                ? { ...candidate.data.image, displayWidth, displayHeight }
                : candidate.data.image,
            },
          }
        : candidate))
    } : undefined
    const applyExternalLinkResize = externalLink ? (resize: ResizeSnapRequest) => {
      const resized = resize.snapAxis
        ? snapFreeResizeToGrid(resize, {
            gridSize: MINDMAP_GRID_SIZE,
            minWidth: 160,
            minHeight: 96,
            maxWidth: 1_200,
            maxHeight: 800,
          })
        : resize
      const displayWidth = Math.max(160, Math.min(1_200, resized.width))
      const displayHeight = Math.max(96, Math.min(800, resized.height))
      setNodes((current) => current.map((candidate) => candidate.id === node.id
        ? {
            ...candidate,
            width: displayWidth,
            height: displayHeight,
            measured: { width: displayWidth, height: displayHeight },
            ...(resize.snapAxis ? { position: { x: resized.x, y: resized.y } } : {}),
            data: {
              ...candidate.data,
              externalLink: candidate.data.externalLink
                ? { ...candidate.data.externalLink, displayWidth, displayHeight }
                : candidate.data.externalLink,
            },
          }
        : candidate))
    } : undefined
    return {
      ...node,
      hidden,
      connectable: image ? false : node.connectable,
      deletable: image ? false : node.deletable,
      style: image
        ? { ...node.style, width: image.displayWidth, height: image.displayHeight }
        : externalLink
          ? { ...node.style, width: externalLink.displayWidth, height: externalLink.displayHeight }
          : node.style,
      data: {
        ...node.data,
        ...(progressRollup ? {
          progress: progressRollup.progress,
          status: progressRollup.status,
          progressRollupTargetCount: progressRollup.targetCount,
        } : {}),
        externalLink,
        imageAssetUrl: image ? imageAssetUrl(activeMapId, image.assetId) : undefined,
        imageEditable: Boolean(image && mode === 'editor'),
        onOpenImagePreview: image ? () => setPreviewImageNodeId(node.id) : undefined,
        onImageResizeStart: image ? beginHistoryTransaction : undefined,
        onImageResize: image ? (resize: ResizeSnapRequest) => {
          if (!resize.snapAxis) return
          queueMicrotask(() => applyImageResize?.(resize))
        } : undefined,
        onImageResizeEnd: image ? (resize: ResizeSnapRequest) => {
          queueMicrotask(() => {
            applyImageResize?.(resize)
            setSavedAt('이미지 크기 변경됨')
            endHistoryTransaction()
          })
        } : undefined,
        externalLinkEditable: Boolean(externalLink && mode === 'editor'),
        onExternalLinkResizeStart: externalLink ? beginHistoryTransaction : undefined,
        onExternalLinkResize: externalLink ? (resize: ResizeSnapRequest) => {
          if (!resize.snapAxis) return
          queueMicrotask(() => applyExternalLinkResize?.(resize))
        } : undefined,
        onExternalLinkResizeEnd: externalLink ? (resize: ResizeSnapRequest) => {
          queueMicrotask(() => {
            applyExternalLinkResize?.(resize)
            setSavedAt('Dooray 카드 크기 변경됨')
            endHistoryTransaction()
          })
        } : undefined,
        assignee: teamMembers.find((member) => member.id === node.data.assigneeId),
        unresolvedDependencyCount: blocking.length,
        referenceUnresolved: node.data.reference ? unresolvedReferenceNodeIds.has(node.id) : undefined,
        blockedByLabels: blocking.map((candidate) => candidate.data.label),
        commentCount: (node.data.reference ? referenceCommentStats[node.id] : commentStats[node.id])?.total ?? 0,
        unresolvedCommentCount: (node.data.reference ? referenceCommentStats[node.id] : commentStats[node.id])?.unresolved ?? 0,
        aiConversationRuntime: aiConversationRuntimes[node.id],
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
        onOpenDependencies: () => openDependencies(node.id),
      },
      className: [
        node.className,
        node.id === dropTargetId ? 'drop-target' : '',
        node.id === knowledgeConnection?.sourceId ? `knowledge-link-source ${knowledgeConnection.policy === 'reuse-first' ? 'primary' : 'secondary'}` : '',
        node.id === knowledgeConnectionTargetId ? `knowledge-link-target ${hoveredKnowledgeConnectionIssue ? 'invalid' : 'valid'}` : '',
        normalizedNodeSearch && searchMatchedNodeIds.has(node.id) ? 'search-match' : '',
        normalizedNodeSearch && !searchMatchedNodeIds.has(node.id) && !hidden ? 'search-dim' : '',
        filterActive && filterVisibleNodeIds.has(node.id) && !filterMatchedNodeIds.has(node.id) ? 'filter-context' : '',
      ].filter(Boolean).join(' '),
    }
  }), [activeMapId, aiConversationRuntimes, beginHistoryTransaction, collapsedHiddenNodeIds, collapsedNodeIds, collapsibleNodeIds, commentStats, descendantCounts, dropTargetId, endHistoryTransaction, filterActive, filterMatchedNodeIds, filterVisibleNodeIds, hoveredKnowledgeConnectionIssue, knowledgeConnection, knowledgeConnectionTargetId, mode, nodes, normalizedNodeSearch, openDependencies, openWaitingItems, progressRollups, referenceCommentStats, searchContextNodeIds, searchMatchedNodeIds, setNodes, teamMembers, unresolvedReferenceNodeIds])
  const visibleFlowNodeIds = useMemo(() => new Set(flowNodes.filter((node) => !node.hidden).map((node) => node.id)), [flowNodes])
  visibleFlowNodeIdsRef.current = visibleFlowNodeIds
  const visibleFlowNodeIdsKey = useMemo(() => [...visibleFlowNodeIds].sort().join('\u0000'), [visibleFlowNodeIds])
  const flowEdges = useMemo(() => {
    const rootNodeId = rootNodeOf(nodes, edges)?.id
    const highlightSelectedId = selectedId && selectedId !== rootNodeId ? selectedId : null
    const pairKey = (edge: MindMapEdge) => JSON.stringify([edge.source, edge.target])
    const hierarchyPairs = new Set(edges.filter(isHierarchyEdge).map(pairKey))
    const nodesById = new Map(nodes.map((node) => [node.id, node]))
    return edges.map((edge) => {
      const hidden = !visibleFlowNodeIds.has(edge.source) || !visibleFlowNodeIds.has(edge.target)
      const sourceNode = nodesById.get(edge.source)
      // 선택한 카드에 닿는 연결선만 강조하고 나머지는 흐리게 해 밀집 구간에서 구분한다.
      // 최상위 카드는 문서 전체를 대표하므로 강조하지 않고 평소 표시를 유지한다.
      const selectionState = highlightSelectedId
        ? (edge.source === highlightSelectedId || edge.target === highlightSelectedId ? 'edge-linked' : 'edge-dimmed')
        : ''
      if (!isKnowledgeEdge(edge)) return {
        ...edge,
        sourceHandle: sourceNode?.data.kind === 'image' ? 'image-source-right' : edge.sourceHandle,
        hidden,
        className: [edge.className, selectionState].filter(Boolean).join(' ') || undefined,
        // 지식선과 같은 방식으로 인라인 지정해 테마별 CSS 우선순위에 좌우되지 않게 한다.
        style: selectionState === 'edge-linked' ? { ...edge.style, strokeWidth: 2.6 } : edge.style,
      }
      const primary = knowledgePolicyOf(edge) === 'reuse-first'
      const targetNode = nodesById.get(edge.target)
      const sourceHandlePrefix = sourceNode?.data.kind === 'image'
        ? 'image-source'
        : sourceNode && isDoorayKnowledgeCard(sourceNode.data) ? 'dooray-knowledge-source' : null
      const nearestHandles = sourceHandlePrefix && sourceNode && targetNode
        ? nearestKnowledgeHandles(sourceNode, targetNode, sourceHandlePrefix)
        : undefined
      return {
        ...edge,
        ...nearestHandles,
        type: 'knowledge-parallel',
        hidden,
        reconnectable: false,
        data: {
          ...edge.data,
          parallelOffset: hierarchyPairs.has(pairKey(edge)) ? 18 : undefined,
        },
        className: `knowledge-edge ${primary ? 'reuse-first' : 'inspect-if-insufficient'} ${selectionState}`.trim(),
        label: primary ? '주요 지식' : '부족할 때 확인',
        labelStyle: { fill: primary ? 'var(--theme-knowledge-primary-text)' : 'var(--theme-knowledge-fallback-text)', fontSize: 9, fontWeight: 700 },
        labelBgStyle: { fill: primary ? 'var(--theme-knowledge-primary-bg)' : 'var(--theme-knowledge-fallback-bg)', fillOpacity: .96 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 5,
        style: { stroke: primary ? 'var(--theme-knowledge-primary)' : 'var(--theme-knowledge-fallback)', strokeWidth: selectionState === 'edge-linked' ? 2.6 : 2.2, strokeDasharray: primary ? undefined : '6 5' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: primary ? 'var(--theme-knowledge-primary)' : 'var(--theme-knowledge-fallback)' },
      }
    })
  }, [edges, nodes, selectedId, visibleFlowNodeIds])

  useLayoutEffect(() => {
    if (viewMode !== 'mindmap' || loadedMapId !== activeMapId || !visibleFlowNodeIdsKey) return
    // ref 댓글 통계처럼 노드 표시 데이터가 측정 직후 바뀌어도 연결 핸들 좌표를 다시 확정한다.
    const nodeIds = visibleFlowNodeIdsKey.split('\u0000')
    updateNodeInternals(nodeIds)
    if (nodesInitialized) return
    const retryFrame = window.requestAnimationFrame(() => updateNodeInternals(nodeIds))
    return () => window.cancelAnimationFrame(retryFrame)
  }, [
    activeMapId,
    commentStats,
    loadedMapId,
    nodesInitialized,
    referenceCommentStats,
    teamMembers,
    updateNodeInternals,
    viewMode,
    visibleFlowNodeIdsKey,
  ])

  const navigateNodeSearch = (direction: 1 | -1) => {
    if (nodeSearchMatches.length === 0) return
    const nextIndex = nodeSearchIndex < 0
      ? direction === 1 ? 0 : nodeSearchMatches.length - 1
      : (nodeSearchIndex + direction + nodeSearchMatches.length) % nodeSearchMatches.length
    const target = nodeSearchMatches[nextIndex]
    setNodeSearchIndex(nextIndex)
    setSelectedId(target.id)
    focusedNodeIdRef.current = null
    setCenter(target.position.x + 109, target.position.y + 65, { zoom: Math.max(.85, Math.min(1.2, viewport.zoom)), duration: 420 })
  }

  useEffect(() => {
    setNodeSearchTerm('')
    setNodeSearchIndex(-1)
    setNodeFilter('all')
    setAssigneeFilter('all')
    setCollapsedNodeIds(new Set())
    focusedNodeIdRef.current = null
    lastTouchCardTap.current = null
  }, [activeMapId])

  useEffect(() => {
    if (viewMode !== 'mindmap') setMiniMapReadyMapId(null)
  }, [viewMode])

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
    if (!collapsedDocumentGroupsInitialized.current) return
    const storageKey = collapsedDocumentGroupsStorageKey(user.id)
    if (!storageKey) return
    localStorage.setItem(
      storageKey,
      JSON.stringify([...collapsedDocumentGroupIds]),
    )
  }, [collapsedDocumentGroupIds, user.id])

  useEffect(() => {
    if (!collapsedDocumentGroupsInitialized.current) return
    const availableGroupIds = new Set(documentLayout.groups.map((group) => group.id))
    setCollapsedDocumentGroupIds((current) => {
      const next = new Set([...current].filter((groupId) => availableGroupIds.has(groupId)))
      availableGroupIds.forEach((groupId) => {
        if (!knownDocumentGroupIds.current.has(groupId)) next.add(groupId)
      })
      knownDocumentGroupIds.current = availableGroupIds
      return next.size === current.size && [...next].every((groupId) => current.has(groupId)) ? current : next
    })
  }, [documentLayout.groups])

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
        if (!collapsedDocumentGroupsInitialized.current) {
          const initialCollapsedGroupIds = initialCollapsedDocumentGroupIds(
            storedCollapsedDocumentGroupIds.current,
            loadedDocumentLayout.groups.map((group) => group.id),
          )
          knownDocumentGroupIds.current = new Set(loadedDocumentLayout.groups.map((group) => group.id))
          collapsedDocumentGroupsInitialized.current = true
          setCollapsedDocumentGroupIds(new Set(initialCollapsedGroupIds))
        }
        if (maps.length > 0) {
          setDocuments(maps)
          const deepLink = pendingDeepLink.current
          const requestedDocument = deepLink?.mapId
            ? maps.find((map) => map.id === deepLink.mapId) ?? null
            : null
          const storedLocation = deepLink?.mapId
            ? null
            : restorableWorkspaceLocation(lastWorkspaceLocation.current, maps.map((map) => map.id))
          const restoredDocument = storedLocation
            ? maps.find((map) => map.id === storedLocation.mapId) ?? null
            : null
          const targetDocument = requestedDocument ?? restoredDocument ?? maps[0]
          if (!deepLink && storedLocation) {
            setViewMode(storedLocation.viewMode)
            pendingSelection.current = storedLocation.nodeId
          }
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
    if (!activeMapId || loadedMapId !== activeMapId) return
    const storedLocation = storeWorkspaceLocation(user.id, {
      mapId: activeMapId,
      viewMode,
      nodeId: selectedId,
    })
    if (storedLocation) lastWorkspaceLocation.current = storedLocation
  }, [activeMapId, loadedMapId, selectedId, user.id, viewMode])

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
    void apiRequest<{ stats: NodeCommentStats }>(`/api/maps/${encodeURIComponent(activeMapId)}/comments/stats`)
      .then((result) => { if (active) setCommentStats(result.stats) })
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
        const result = await apiRequest<{ stats: NodeCommentStats }>(`/api/maps/${encodeURIComponent(mapId)}/comments/stats`)
        return [mapId, result.stats] as const
      } catch {
        return [mapId, {}] as const
      }
    })).then((results) => {
      if (!active) return
      const statsByMap = new Map<string, NodeCommentStats>(results)
      const nextStats = Object.fromEntries(targets.map((target) => [
        target.localNodeId,
        statsByMap.get(target.mapId)?.[target.nodeId] ?? { total: 0, unresolved: 0 },
      ]))
      setReferenceCommentStats((current) => isSameCommentStats(current, nextStats) ? current : nextStats)
    })
    return () => { active = false }
  }, [referenceCommentTargetsKey])

  useEffect(() => {
    setReplyTarget(null)
    setReplySummary('')
    setReplyDetail('')
    setReplyDetailOpen(false)
    setReplyError('')
    setNewComment('')
    setNewCommentDetail('')
    setCommentDetailOpen(false)
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

  const refreshResolvedReferences = useCallback(() => {
    if (!activeMapId) return
    void apiRequest<MapDocumentResponse>(`/api/maps/${encodeURIComponent(activeMapId)}`)
      .then(({ map, referenceCommentStats: nextCommentStats, unresolvedReferenceNodeIds: unresolvedIds }) => {
        const baseline = serverBaseline.current
        if (baseline?.id === activeMapId) {
          serverBaseline.current = {
            ...baseline,
            nodes: mergeResolvedReferenceNodes(baseline.nodes, map.nodes),
          }
        }
        // Ref 원본 값 반영도 사용자 편집이 아니므로 실행 취소 단계를 만들지 않는다.
        const nextNodes = mergeResolvedReferenceNodes(nodesRef.current, map.nodes)
        if (nextNodes !== nodesRef.current) {
          setNodes(nextNodes)
          rebaselineHistory(nextNodes, edgesRef.current)
        }
        if (nextCommentStats) {
          setReferenceCommentStats((current) => isSameCommentStats(current, nextCommentStats) ? current : nextCommentStats)
        }
        setUnresolvedReferenceNodeIds(new Set(unresolvedIds ?? []))
      })
      .catch(() => undefined)
  }, [activeMapId, rebaselineHistory, setNodes])

  useEffect(() => {
    setAiConversationRuntimes({})
    let disposed = false
    let eventSource: EventSource | null = null
    let lastEventAt = Date.now()

    const synchronizeAfterReconnect = async () => {
      const [notificationResult, library, trashResult] = await Promise.all([
        user.publicAccess
          ? Promise.resolve(null)
          : apiRequest<{ notifications: UserNotification[] }>('/api/notifications').catch(() => null),
        apiRequest<DocumentLibraryResponse>('/api/maps').catch(() => null),
        mode === 'editor'
          ? apiRequest<{ maps: MapSummary[] }>('/api/maps/trash').catch(() => null)
          : Promise.resolve(null),
      ])
      if (disposed) return
      if (notificationResult) setNotifications(notificationResult.notifications)
      if (!library) return

      setDocuments(library.maps)
      setDocumentLayout(library.documentLayout)
      if (trashResult) setTrashedDocuments(trashResult.maps)

      const remoteMap = library.maps.find((map) => map.id === activeMapId) ?? null
      if (activeMapId && !remoteMap) {
        setActiveMapId(library.maps[0]?.id ?? '')
        return
      }

      const baseline = serverBaseline.current
      if (!remoteMap || baseline?.id !== activeMapId || remoteMap.version <= baseline.version || !remoteMap.updatedBy) {
        refreshResolvedReferences()
        return
      }

      const missedChange: MapChangeEvent = {
        type: 'map-changed',
        mapId: remoteMap.id,
        action: 'content',
        sourceClientId: null,
        updatedAt: remoteMap.updatedAt ?? new Date().toISOString(),
        updatedBy: remoteMap.updatedBy,
      }
      if (mode === 'viewer') setMapReloadToken((current) => current + 1)
      else setExternalChange(missedChange)
      refreshResolvedReferences()
    }

    const handleEventMessage = (message: MessageEvent<string>) => {
      lastEventAt = Date.now()
      try {
        const event = JSON.parse(message.data) as MapChangeEvent | PresenceEvent | CursorEvent | CommentChangeEvent | AiConversationLinkedEvent | AiConversationRuntimeEvent | AiConversationRuntimeSnapshotEvent | AiConversationRuntimeSummaryEvent | AiConversationRuntimeSummarySnapshotEvent | NotificationEvent | NotificationsReadEvent | NotificationsRemovedEvent | HeartbeatEvent | { type: 'connected' }
        if (event.type === 'heartbeat') return
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
            void apiRequest<{ stats: NodeCommentStats }>(`/api/maps/${encodeURIComponent(activeMapId)}/comments/stats`)
              .then((result) => setCommentStats(result.stats))
              .catch(() => undefined)
          }
          const referencedLocalNodeIds = referenceCommentTargetsRef.current
            .filter((target) => target.mapId === event.mapId && target.nodeId === event.nodeId)
            .map((target) => target.localNodeId)
          if (referencedLocalNodeIds.length > 0) {
            void apiRequest<{ stats: NodeCommentStats }>(`/api/maps/${encodeURIComponent(event.mapId)}/comments/stats`)
              .then((result) => {
                const stats = result.stats[event.nodeId] ?? { total: 0, unresolved: 0 }
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
        if (event.type === 'ai-conversation-runtime-snapshot') {
          if (event.mapId !== activeMapId) return
          setAiConversationRuntimes(Object.fromEntries(event.runtimes.map((item) => [item.nodeId, item.runtime])))
          return
        }
        if (event.type === 'ai-conversation-runtime-summary-snapshot') {
          setAiConversationActiveCounts(Object.fromEntries(event.summaries
            .filter((summary) => summary.activeCount > 0)
            .map((summary) => [summary.mapId, summary.activeCount])))
          return
        }
        if (event.type === 'ai-conversation-runtime-summary') {
          setAiConversationActiveCounts((current) => {
            if (event.activeCount > 0) return { ...current, [event.mapId]: event.activeCount }
            if (!(event.mapId in current)) return current
            const next = { ...current }
            delete next[event.mapId]
            return next
          })
          return
        }
        if (event.type === 'ai-conversation-runtime') {
          if (event.mapId !== activeMapId) return
          setAiConversationRuntimes((current) => {
            if (event.runtime) return { ...current, [event.nodeId]: event.runtime }
            if (!(event.nodeId in current)) return current
            const next = { ...current }
            delete next[event.nodeId]
            return next
          })
          return
        }
        if (event.type === 'ai-conversation-linked') {
          if (event.mapId !== activeMapId) return
          void apiRequest<{ map: MapDocument }>(`/api/maps/${encodeURIComponent(activeMapId)}`)
            .then(({ map }) => {
              reconcileRemoteMap(map)
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
        if (event.type !== 'map-changed') return
        const changesReferencedMap = referenceCommentTargetsRef.current.some((target) => target.mapId === event.mapId)
        if (changesReferencedMap) refreshResolvedReferences()
        if (event.sourceClientId === CLIENT_ID) return
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
          if (event.mapId !== activeMapId || !shouldRefreshMapContentForAction(event.action)) return
          if (mode === 'viewer') setMapReloadToken((current) => current + 1)
          else setExternalChange(event)
        })().catch(() => undefined)
      } catch {
        // 연결 확인 이벤트 외의 잘못된 메시지는 무시합니다.
      }
    }

    const connectEventSource = () => {
      eventSource?.close()
      lastEventAt = Date.now()
      const nextEventSource = new EventSource(`/api/events?clientId=${encodeURIComponent(CLIENT_ID)}&mapId=${encodeURIComponent(activeMapId)}`)
      eventSource = nextEventSource
      nextEventSource.onmessage = handleEventMessage
      nextEventSource.onopen = () => {
        if (disposed || eventSource !== nextEventSource) return
        lastEventAt = Date.now()
        void synchronizeAfterReconnect()
      }
    }

    const reconnectIfNeeded = (force = false) => {
      if (disposed || !shouldReconnectEventStream({
        lastEventAt,
        online: navigator.onLine,
        visibilityState: document.visibilityState,
        force,
      })) return
      connectEventSource()
    }

    connectEventSource()
    const watchdog = window.setInterval(() => reconnectIfNeeded(), 15_000)
    const handleVisibilityChange = () => reconnectIfNeeded()
    const handleOnline = () => reconnectIfNeeded(true)
    const handleFocus = () => reconnectIfNeeded()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('online', handleOnline)
    window.addEventListener('focus', handleFocus)

    return () => {
      disposed = true
      window.clearInterval(watchdog)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('focus', handleFocus)
      eventSource?.close()
    }
  }, [activeMapId, mode, reconcileRemoteMap, refreshResolvedReferences, user.id, user.publicAccess])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const staleBefore = Date.now() - 4_000
      setLiveCursors((current) => {
        const entries = Object.entries(current)
        const activeEntries = entries.filter(([, cursor]) => cursor.receivedAt >= staleBefore)
        return activeEntries.length === entries.length ? current : Object.fromEntries(activeEntries)
      })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [])

  const refreshDoorayKnowledgeCard = useCallback((mapId: string, nodeId: string, url: string) => {
    if (mode !== 'editor') return
    const normalizedUrl = normalizedDoorayKnowledgeUrl(url)
    if (!normalizedUrl) return
    const requestKey = `${mapId}\u0000${nodeId}`
    if (refreshingDoorayKnowledgeCards.current.has(requestKey)) return
    refreshingDoorayKnowledgeCards.current.add(requestKey)

    void fetchDoorayKnowledgePreview(normalizedUrl)
      .then((preview) => {
        if (activeMapIdRef.current !== mapId) return
        if (pendingDooraySourceUrls.current.has(requestKey)) return
        const { subject, ...remoteLink } = preview
        const remoteState = doorayKnowledgeState(preview)
        setNodes((current) => current.map((node) => {
          if (node.id !== nodeId || !isDoorayKnowledgeCard(node.data) || !isSameDoorayKnowledgeUrl(node.data.externalLink.url, normalizedUrl)) return node
          const currentLink = node.data.externalLink
          const remoteChanged = node.data.label !== subject
            || node.data.status !== remoteState.status
            || node.data.progress !== remoteState.progress
            || !isSameDoorayKnowledgePreview(currentLink, preview, subject)
          if (!remoteChanged) return node
          return {
            ...node,
            data: {
              ...node.data,
              label: subject,
              ...remoteState,
              taskUrl: remoteLink.url,
              externalLink: {
                ...remoteLink,
                title: subject,
                displayWidth: currentLink.displayWidth,
                displayHeight: currentLink.displayHeight,
              },
            },
          }
        }))
      })
      .catch(() => {
        // 원본 조회에 실패해도 저장된 Dooray 제목과 메타데이터를 계속 사용합니다.
      })
      .finally(() => refreshingDoorayKnowledgeCards.current.delete(requestKey))
  }, [mode, setNodes])

  const updateDoorayKnowledgeSource = useCallback((mapId: string, nodeId: string, value: string) => {
    if (doorayUrlCommitTimer.current !== null) {
      window.clearTimeout(doorayUrlCommitTimer.current)
      doorayUrlCommitTimer.current = null
    }
    if (mode !== 'editor') return
    const currentNode = nodesRef.current.find((node) => node.id === nodeId)
    if (!currentNode || !isDoorayKnowledgeCard(currentNode.data) || currentNode.data.reference) return
    const normalizedUrl = normalizedDoorayKnowledgeUrl(value)
    if (!normalizedUrl) {
      setDoorayUrlUpdateState('error')
      setDoorayUrlUpdateError('올바른 Dooray 업무 또는 Wiki URL을 입력해 주세요.')
      return
    }

    if (currentNode.data.externalLink.url === normalizedUrl) {
      setDoorayUrlDraft(normalizedUrl)
      setDoorayUrlUpdateState('idle')
      setDoorayUrlUpdateError('')
      return
    }
    if (nodesRef.current.some((node) => node.id !== nodeId
      && isSameDoorayKnowledgeUrl(node.data.taskUrl ?? '', normalizedUrl))) {
      setDoorayUrlUpdateState('error')
      setDoorayUrlUpdateError('이미 이 Dooray 원본을 사용하는 카드가 있습니다.')
      return
    }

    const requestKey = `${mapId}\u0000${nodeId}`
    if (pendingDooraySourceUrls.current.get(requestKey) === normalizedUrl) return
    pendingDooraySourceUrls.current.set(requestKey, normalizedUrl)
    setDoorayUrlUpdateState('updating')
    setDoorayUrlUpdateError('')

    void fetchDoorayKnowledgePreview(normalizedUrl)
      .then((preview) => {
        if (activeMapIdRef.current !== mapId || pendingDooraySourceUrls.current.get(requestKey) !== normalizedUrl) return
        const { subject, ...remoteLink } = preview
        const remoteState = doorayKnowledgeState(preview)
        setNodes((current) => current.map((node) => {
          if (node.id !== nodeId || !isDoorayKnowledgeCard(node.data)) return node
          return {
            ...node,
            data: {
              ...node.data,
              label: subject,
              ...remoteState,
              taskUrl: remoteLink.url,
              externalLink: {
                ...remoteLink,
                title: subject,
                displayWidth: node.data.externalLink.displayWidth,
                displayHeight: node.data.externalLink.displayHeight,
              },
            },
          }
        }))
        if (selectedIdRef.current === nodeId) {
          setDoorayUrlDraft(remoteLink.url)
          setDoorayUrlUpdateState('idle')
          setDoorayUrlUpdateError('')
        }
      })
      .catch((error) => {
        if (activeMapIdRef.current !== mapId
          || pendingDooraySourceUrls.current.get(requestKey) !== normalizedUrl
          || selectedIdRef.current !== nodeId) return
        setDoorayUrlUpdateState('error')
        setDoorayUrlUpdateError(error instanceof Error ? error.message : 'Dooray 원본을 조회하지 못했습니다.')
      })
      .finally(() => {
        if (pendingDooraySourceUrls.current.get(requestKey) === normalizedUrl) {
          pendingDooraySourceUrls.current.delete(requestKey)
        }
      })
  }, [mode, setNodes])

  useEffect(() => {
    if (mode !== 'editor' || !activeMapId || loadedMapId !== activeMapId) return
    nodesRef.current.forEach((node) => {
      if (isDoorayKnowledgeCard(node.data)) {
        refreshDoorayKnowledgeCard(activeMapId, node.id, node.data.externalLink.url)
      }
    })
  }, [activeMapId, loadedMapId, mode, refreshDoorayKnowledgeCard])

  useEffect(() => {
    if (mode !== 'editor' || !activeMapId || loadedMapId !== activeMapId || !selectedId) return
    const node = nodesRef.current.find((candidate) => candidate.id === selectedId)
    if (node && isDoorayKnowledgeCard(node.data)) {
      refreshDoorayKnowledgeCard(activeMapId, node.id, node.data.externalLink.url)
    }
  }, [activeMapId, loadedMapId, mode, refreshDoorayKnowledgeCard, selectedId])

  useEffect(() => {
    if (!activeMapId) return
    let active = true
    const selectedNodeIdBeforeReload = lastLoadedMapId.current === activeMapId
      ? selectedIdRef.current
      : null
    setLoadedMapId(null)
    setSavedAt('서버에서 불러오는 중…')
    setSaveError('')
    setReferenceCommentStats({})
    setUnresolvedReferenceNodeIds(new Set())

    void apiRequest<MapDocumentResponse>(`/api/maps/${encodeURIComponent(activeMapId)}`)
      .then(({ map, referenceCommentStats: loadedReferenceCommentStats, unresolvedReferenceNodeIds: unresolvedIds }) => {
        if (!active) return
        const deepLink = pendingDeepLink.current
        const deepLinkTargetsMap = deepLink?.mapId === map.id
        const requestedNode = deepLink?.mapId === map.id && deepLink.nodeId
          ? map.nodes.find((node) => node.id === deepLink.nodeId) ?? null
          : null
        const deepLinkedNodeId = requestedNode && deepLink && canSelectNodeInView(requestedNode, deepLink.viewMode)
          ? requestedNode.id
          : null
        const requestedNodeId = pendingSelection.current ?? selectedNodeIdBeforeReload
        const nextSelectedId = deepLinkTargetsMap
          ? deepLinkedNodeId
          : requestedNodeId && map.nodes.some((node) => node.id === requestedNodeId)
            ? requestedNodeId
            : map.nodes[0]?.id ?? null
        const loadedNodes = synchronizeNodeSelection(map.nodes, nextSelectedId)
        serverBaseline.current = structuredClone(map)
        resetHistory(loadedNodes, map.edges)
        setReferenceCommentStats(loadedReferenceCommentStats ?? {})
        setUnresolvedReferenceNodeIds(new Set(unresolvedIds ?? []))
        setNodes(loadedNodes)
        setEdges(map.edges)
        setSelectedId(nextSelectedId)
        if (deepLinkTargetsMap) {
          pendingDeepLink.current = null
        }
        pendingSelection.current = null
        lastLoadedMapId.current = map.id
        localStorage.setItem(storageKeyForMap(activeMapId), JSON.stringify(createPersistedMapContent(loadedNodes, map.edges)))
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
          const nextSelectedId = selectedNodeIdBeforeReload && localMap.nodes.some((node) => node.id === selectedNodeIdBeforeReload)
            ? selectedNodeIdBeforeReload
            : localMap.nodes[0]?.id ?? null
          const loadedNodes = synchronizeNodeSelection(localMap.nodes, nextSelectedId)
          serverBaseline.current = null
          resetHistory(loadedNodes, localMap.edges)
          setReferenceCommentStats({})
          setUnresolvedReferenceNodeIds(new Set())
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
    const localContent = createPersistedMapContent(nodes, edges)
    localStorage.setItem(storageKeyForMap(activeMapId), JSON.stringify(localContent))
    if (mode === 'viewer') {
      setSavedAt('읽기 전용')
      return
    }
    const saveBase = serverBaseline.current
    if (!saveBase || saveBase.id !== activeMapId) {
      setSavedAt('로컬 백업만 저장됨 · 서버 재연결 필요')
      return
    }
    if (mapContentsEqual(localContent, saveBase)) {
      setSavedAt('서버와 동기화됨')
      return
    }

    const timer = window.setTimeout(() => {
      setSavedAt('서버에 저장 중…')
      setSaveError('')
      const savingMapId = activeMapId
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
          baseVersion: saveBase.version,
          suppressWorkNotificationNodeIds: suppressedNotificationNodeIds,
        }),
      })
        .then(({ map, summary }) => {
          clearPastedNodeNotificationSuppressions()
          acceptSavedMap(map, localContent)
          setDocuments((current) => current.map((document) => document.id === summary.id ? summary : document))
          setSavedAt('서버와 동기화됨')
        })
        .catch(async (error) => {
          const conflictBody = error instanceof ApiRequestError
            ? error.body as { code?: string; map?: MapDocument }
            : null
          const remote = conflictBody?.code === 'VERSION_CONFLICT' ? conflictBody.map : null
          if (error instanceof ApiRequestError && error.status === 409 && remote && saveBase.id === savingMapId) {
            try {
              const merged = mergeMapContent(saveBase, localContent, remote)
              if (mapContentsEqual(merged, remote)) {
                clearPastedNodeNotificationSuppressions()
                acceptSavedMap(remote, localContent)
                setSavedAt('서버와 동기화됨')
                return
              }
              const mergedContent = { nodes: merged.nodes, edges: merged.edges }
              const result = await apiRequest<{ map: MapDocument; summary: MapSummary }>(`/api/maps/${encodeURIComponent(savingMapId)}`, {
                method: 'PUT',
                body: JSON.stringify({
                  map: mergedContent,
                  baseVersion: remote.version,
                  suppressWorkNotificationNodeIds: suppressedNotificationNodeIds,
                }),
              })
              clearPastedNodeNotificationSuppressions()
              acceptSavedMap(result.map, mergedContent)
              setDocuments((current) => current.map((document) => document.id === result.summary.id ? result.summary : document))
              setExternalChange(null)
              setMergeNotice(merged.conflicts > 0
                ? `동시 변경을 병합했습니다. 겹친 ${merged.conflicts}개 항목은 내 변경을 유지했습니다.`
                : '서로 다른 동시 변경을 자동으로 병합했습니다.')
              setSavedAt('동시 변경 병합됨')
              window.setTimeout(() => setMergeNotice(''), 5000)
              return
            } catch (mergeError) {
              const latestConflict = mergeError instanceof ApiRequestError
                ? mergeError.body as { code?: string; map?: MapDocument }
                : null
              if (mergeError instanceof ApiRequestError
                && mergeError.status === 409
                && latestConflict?.code === 'VERSION_CONFLICT'
                && latestConflict.map) {
                reconcileRemoteMap(latestConflict.map)
                setSavedAt('새 변경과 다시 병합함')
                return
              }
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
  }, [acceptSavedMap, activeMapId, edges, loadedMapId, mode, nodes, reconcileRemoteMap, serverBaselineRevision])

  const onConnect = useCallback(
    (connection: Connection) => {
      if (mode === 'viewer') return
      setEdges((current) => addEdge({
        ...connection,
        type: 'default',
        data: { relation: 'hierarchy' },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      }, current))
    },
    [mode, setEdges],
  )

  const updateNode = useCallback((id: string, patch: Partial<MindNodeData>) => {
    setNodes((current) => current.map((node) => (
      node.id === id
        ? (() => {
          const effectivePatch = node.data.reference ? editableReferencePatch(patch) : patch
          if (Object.keys(effectivePatch).length === 0) return node
          const completesWork = effectivePatch.status === 'done' || (effectivePatch.progress ?? -1) >= 100
          const normalizedPatch = completesWork && effectivePatch.waitingItems === undefined
            ? { ...effectivePatch, waitingItems: [] }
            : effectivePatch
          return { ...node, data: { ...node.data, ...normalizedPatch } }
        })()
        : node
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

  const openAiConversation = (
    conversationId: string,
    cardId = selectedCommentNodeId,
    mapId = selectedCommentMapId,
  ) => {
    if (mapId && cardId) {
      void apiRequest(`/api/integrations/aionui/conversations/${encodeURIComponent(conversationId)}/attribution`, {
        method: 'POST',
        body: JSON.stringify({ mapId, cardId }),
        keepalive: true,
      }).catch((error) => {
        console.warn('[AI conversation attribution refresh]', error)
      })
    }
    const useWebUi = aionUiWebNavigation.configured || !isLoopbackHostname(window.location.hostname)
    if (useWebUi) {
      try {
        const conversationUrl = aionUiConversationWebUrl(aionUiWebNavigation.baseUrl, conversationId)
        const aionUiTab = window.open(conversationUrl, '_blank')
        if (!aionUiTab) {
          window.alert('AionUi 대화 탭을 열지 못했습니다. 브라우저의 팝업 차단을 해제한 뒤 다시 시도해 주세요.')
          return
        }
        aionUiTab.opener = null
        aionUiTab.focus()
      } catch {
        window.alert('AionUi WebUI 주소가 올바르지 않습니다. MNP_AIONUI_WEB_URL 설정을 확인해 주세요.')
      }
      return
    }
    const route = encodeURIComponent(`/conversation/${conversationId}`)
    window.location.href = `aionui://navigate?route=${route}`
  }

  const openAiConversationForNode = (
    node: MindMapNode,
    cardId = node.data.reference?.nodeId ?? node.id,
    mapId = node.data.reference?.mapId ?? activeMapId,
  ) => {
    const conversations = aiConversationLinksFromData(node.data)
    if (conversations.length > 0) {
      setAiConversationPicker({
        mapId,
        cardId,
        cardTitle: node.data.label.replace(/\s*\(ref\)\s*$/i, ''),
      })
      return
    }
    const conversationId = conversations.at(-1)?.conversationId ?? node.data.aiConversationId
    if (conversationId) void openAiConversation(conversationId, cardId, mapId)
  }

  const deleteUnavailableAiConversation = async (mapId: string, cardId: string, conversationId: string) => {
    const result = await apiRequest<{
      map: MapDocument
      card: MindMapNode
      removedConversationId: string
      latestConversationId: string | null
    }>(`/api/maps/${encodeURIComponent(mapId)}/cards/${encodeURIComponent(cardId)}/ai-conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
    })
    if (mapId === activeMapId) {
      reconcileRemoteMap(result.map)
      setSavedAt('서버와 동기화됨')
    }
    return { latestConversationId: result.latestConversationId }
  }

  const startOrOpenContextNodeAiConversation = () => {
    if (!contextMenuNode) return
    setNodeContextMenu(null)
    setSelectedId(contextMenuNode.id)
    if (contextMenuNode.data.aiConversationId) {
      openAiConversationForNode(
        contextMenuNode,
        contextMenuNode.data.reference?.nodeId ?? contextMenuNode.id,
        contextMenuNode.data.reference?.mapId ?? activeMapId,
      )
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

  const connectKnowledgeCards = useCallback((sourceId: string, targetId: string, policy: KnowledgePolicy) => {
    if (mode !== 'editor') return '편집자만 지식선을 연결할 수 있습니다.'
    const issue = knowledgeConnectionIssue(sourceId, targetId, nodes, edges)
    if (issue) return issue
    setEdges((current) => [...current, {
      id: `knowledge-${sourceId}-${targetId}-${Date.now()}`,
      source: sourceId,
      target: targetId,
      type: 'default',
      reconnectable: false,
      data: { relation: 'knowledge', knowledgePolicy: policy },
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    }])
    setSavedAt('저장 중…')
    return ''
  }, [edges, mode, nodes, setEdges])

  const cancelKnowledgeConnection = useCallback(() => {
    setKnowledgeConnection(null)
    setKnowledgeConnectionTargetId(null)
    setKnowledgeConnectionMessage('')
  }, [])

  const startKnowledgeConnectionFromMenu = useCallback((policy: KnowledgePolicy) => {
    if (!nodeContextMenu || mode !== 'editor' || viewMode !== 'mindmap') return
    setSelectedId(nodeContextMenu.nodeId)
    setKnowledgeConnection({ sourceId: nodeContextMenu.nodeId, policy })
    setKnowledgeConnectionTargetId(null)
    setKnowledgeConnectionMessage('')
    setKnowledgeError('')
    setNodeContextMenu(null)
  }, [mode, nodeContextMenu, viewMode])

  const addKnowledgeSource = () => {
    if (!selectedNode || !knowledgeCandidate || mode !== 'editor') return
    const issue = connectKnowledgeCards(knowledgeCandidate, selectedNode.id, knowledgePolicy)
    if (issue) {
      setKnowledgeError(issue)
      return
    }
    setKnowledgeCandidate('')
    setKnowledgeError('')
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
    setContentTooltip(null)
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
    setSidebarWidth((current) => Math.max(sidebarMinWidth, current))
  }, [sidebarMinWidth])

  useEffect(() => {
    localStorage.setItem('mindnprogress-inspector-width', String(inspectorWidth))
  }, [inspectorWidth])

  const rememberInspectorTextareaHeight = useCallback((field: InspectorTextareaField, height: number) => {
    if (
      !Number.isFinite(height)
      || height < INSPECTOR_TEXTAREA_MIN_HEIGHT
      || height > INSPECTOR_TEXTAREA_MAX_HEIGHT
    ) return

    setInspectorTextareaHeights((current) => {
      if (current[field] === height) return current

      const next = { ...current, [field]: height }
      try {
        localStorage.setItem(inspectorTextareaHeightsStorageKey(user.id), JSON.stringify(next))
      } catch {
        // 저장소를 사용할 수 없는 환경에서도 현재 세션의 크기 조절은 유지한다.
      }
      return next
    })
  }, [user.id])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || selectedReferenceReadOnly) return undefined

    const textareas: Array<[InspectorTextareaField, HTMLTextAreaElement | null]> = [
      ['description', descriptionTextareaRef.current],
      ['sharedKnowledge', sharedKnowledgeTextareaRef.current],
    ]
    const observers = textareas.flatMap(([field, textarea]) => {
      if (!textarea) return []

      let previousHeight = Math.round(textarea.getBoundingClientRect().height)
      const observer = new ResizeObserver(() => {
        const height = Math.round(textarea.getBoundingClientRect().height)
        if (height === previousHeight) return

        previousHeight = height
        rememberInspectorTextareaHeight(field, height)
      })
      observer.observe(textarea)
      return [observer]
    })

    return () => observers.forEach((observer) => observer.disconnect())
  }, [rememberInspectorTextareaHeight, selectedId, selectedReferenceReadOnly])

  const addNode = useCallback((parentId?: string, position?: { x: number; y: number }) => {
    if (mode === 'viewer') return
    const parent = nodes.find((node) => node.id === parentId) ?? selectedNode
    const childIds = new Set(parent
      ? hierarchyEdges.filter((edge) => edge.source === parent.id).map((edge) => edge.target)
      : [])
    const siblingPositions = nodes.filter((node) => childIds.has(node.id)).map((node) => node.position)
    const id = `node-${Date.now()}`
    const automaticPosition = parent
      ? defaultChildMindMapPosition(parent.position, siblingPositions, nodeDimensions(parent).width)
      : snapMindMapPosition({ x: 160, y: 120 })
    const nextPosition = position ?? automaticPosition
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
        sourceHandle: parent.data.kind === 'image' ? 'image-source-right' : undefined,
        type: 'default',
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
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return

      event.preventDefault()
      addNode(selectedId)
    }

    window.addEventListener('keydown', handleInsert)
    return () => window.removeEventListener('keydown', handleInsert)
  }, [addNode, mode, selectedId])

  // Alt 드래그는 카드를 격자에 맞춰 옮기므로, Alt를 누르고 있는 동안 기준 격자를 보여준다.
  useEffect(() => {
    if (!gridGuideEnabled) {
      applyGridGuide(false)
      return
    }
    const trackAltKey = (event: KeyboardEvent) => {
      applyGridGuide(event.altKey)
      // Alt 단독 입력은 크롬 메뉴로 포커스를 넘겨서 다음 Alt 키 이벤트가 페이지에 오지 않는다.
      // 조합 키는 key가 상대 키로 오므로(Alt+Left 등) 브라우저 단축키는 그대로 동작한다.
      if (event.key !== 'Alt') return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      event.preventDefault()
    }
    // Alt+Tab처럼 창을 벗어나면 keyup이 오지 않아 격자가 그대로 남는다.
    const clearGridGuide = () => applyGridGuide(false)

    window.addEventListener('keydown', trackAltKey)
    window.addEventListener('keyup', trackAltKey)
    window.addEventListener('blur', clearGridGuide)
    document.addEventListener('visibilitychange', clearGridGuide)
    return () => {
      window.removeEventListener('keydown', trackAltKey)
      window.removeEventListener('keyup', trackAltKey)
      window.removeEventListener('blur', clearGridGuide)
      document.removeEventListener('visibilitychange', clearGridGuide)
    }
  }, [applyGridGuide, gridGuideEnabled])

  useEffect(() => {
    const handleViewportShortcut = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if ((key !== 'home' && key !== 'f') || viewMode !== 'mindmap' || event.repeat
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return

      if (key === 'home') {
        event.preventDefault()
        showFullMindMap()
        return
      }

      const selectedNodeId = selectedIdRef.current
      if (!selectedNodeId || !nodesRef.current.some((node) => node.id === selectedNodeId)) return

      event.preventDefault()
      toggleNodeFocus(selectedNodeId)
    }

    window.addEventListener('keydown', handleViewportShortcut)
    return () => window.removeEventListener('keydown', handleViewportShortcut)
  }, [showFullMindMap, toggleNodeFocus, viewMode])

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (mode !== 'editor' || (!event.ctrlKey && !event.metaKey)) return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
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
    const deletionPlan = rootDeletionPlan(nodes, edges, nodeId)
    if (!deletionPlan.allowed) {
      if (deletionPlan.message) setSaveError(deletionPlan.message)
      return false
    }
    setSaveError('')
    setNodes((current) => current
      .filter((node) => node.id !== nodeId)
      .map((node) => {
        const removesDependency = (node.data.blockedBy ?? []).includes(nodeId)
        const promotesToRoot = node.id === deletionPlan.promotedNodeId
        if (!removesDependency && !promotesToRoot) return node
        return {
          ...node,
          data: {
            ...node.data,
            ...(removesDependency ? { blockedBy: (node.data.blockedBy ?? []).filter((id) => id !== nodeId) } : {}),
            ...(promotesToRoot ? { kind: 'root' as const } : {}),
          },
        }
      }))
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId))
    setCollapsedNodeIds((current) => {
      const next = new Set(current)
      next.delete(nodeId)
      return next
    })
    setSelectedId((current) => current === nodeId ? null : current)
    return true
  }, [edges, mode, nodes, setEdges, setNodes])

  const deleteImageNodesById = useCallback((nodeId: string) => {
    if (mode !== 'editor') return
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node || node.data.kind !== 'image') return
    const selectedImages = node.selected
      ? nodes.filter((candidate) => candidate.selected && candidate.data.kind === 'image')
      : [node]
    setNodeContextMenu(null)
    selectedImages.forEach((selectedImage) => deleteNodeById(selectedImage.id))
    setSavedAt(selectedImages.length > 1
      ? `이미지 ${selectedImages.length}개 삭제됨 · 원본 정리는 백업 시 검사`
      : '이미지 삭제됨 · 원본 정리는 백업 시 검사')
  }, [deleteNodeById, mode, nodes])

  const deleteSelected = useCallback(() => {
    if (selectedId && selectedNode?.data.kind !== 'image') deleteNodeById(selectedId)
  }, [deleteNodeById, selectedId, selectedNode?.data.kind])

  const startCanvasRightPan = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 2 || viewMode !== 'mindmap') return
    if (!(event.target instanceof Element)) return
    const target = event.target
    const nodeTarget = target.closest('.react-flow__node')
    const edgeTarget = target.closest('.react-flow__edge, .react-flow__edge-textwrapper')
    if (!nodeTarget && !edgeTarget) return
    const interactiveTarget = target.closest('button, input, textarea, select, a, [contenteditable="true"]')
    if (interactiveTarget
      && !PAN_ALLOWED_NODE_CONTROLS.some((name) => interactiveTarget.classList.contains(name))) return
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

  const showNodeContextMenu = useCallback((
    nodeId: string,
    clientX: number,
    clientY: number,
    options: { suppressMobileInspector?: boolean } = {},
  ) => {
    if (mode !== 'editor') return
    setDocumentContextMenu(null)
    setAiConversationContextMenu(null)
    if (options.suppressMobileInspector && window.matchMedia('(max-width: 720px)').matches) {
      setMobileInspectorOpen(false)
      suppressMobileInspectorSelection.current = selectedIdRef.current === nodeId ? null : nodeId
    }
    setSelectedId(nodeId)
    const menuHeight = nodes.find((node) => node.id === nodeId)?.data.kind === 'image' ? 310 : 440
    setNodeContextMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - 230)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight)),
      nodeId,
    })
  }, [mode, nodes])

  const openNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
    const touchSuppression = suppressTouchContextMenu.current
    if (touchSuppression?.nodeId === nodeId && Date.now() < touchSuppression.until) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
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
    showNodeContextMenu(nodeId, event.clientX, event.clientY)
  }, [mode, showNodeContextMenu])

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

  const applySelectedNodeIds = useCallback((selectedIds: string[]) => {
    const selection = new Set(selectedIds)
    setNodes((current) => {
      let changed = false
      const next = current.map((node) => {
        const selected = selection.has(node.id)
        if (Boolean(node.selected) === selected) return node
        changed = true
        return { ...node, selected }
      })
      return changed ? next : current
    })
  }, [setNodes])

  // Ctrl 또는 Meta를 누른 상태의 좌버튼 드래그는 화면 이동 대신 카드 범위 선택으로 사용한다.
  const startBoxSelection = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || viewMode !== 'mindmap' || knowledgeConnection || touchPanOwned.current) return
    if (!event.ctrlKey && !event.metaKey) return
    if (!(event.target instanceof Element) || !event.target.classList.contains('react-flow__pane')) return

    event.preventDefault()
    event.stopPropagation()
    boxSelectionGesture.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startFlow: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      baseSelectedIds: nodesRef.current.filter((node) => node.selected).map((node) => node.id),
      dragging: false,
    }
  }, [knowledgeConnection, screenToFlowPosition, viewMode])

  useEffect(() => {
    const moveBoxSelection = (event: PointerEvent) => {
      const gesture = boxSelectionGesture.current
      if (!gesture || event.pointerId !== gesture.pointerId) return
      const currentClient = { x: event.clientX, y: event.clientY }
      if (!gesture.dragging && !isBoxSelectionDrag(gesture.startClient, currentClient)) return
      gesture.dragging = true
      event.preventDefault()

      const bounds = canvasWrapRef.current?.getBoundingClientRect()
      const clientRect = boxSelectionRect(gesture.startClient, currentClient)
      if (bounds) {
        setBoxSelectionScreenRect({
          left: clientRect.x - bounds.left,
          top: clientRect.y - bounds.top,
          width: clientRect.width,
          height: clientRect.height,
        })
      }

      const flowRect = boxSelectionRect(gesture.startFlow, screenToFlowPosition(currentClient))
      const candidates = nodesRef.current
        .filter((node) => visibleFlowNodeIdsRef.current.has(node.id))
        .map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, ...nodeDimensions(node) }))
      applySelectedNodeIds(applyBoxSelection(gesture.baseSelectedIds, boxSelectionNodeIds(candidates, flowRect)))
    }

    const finishBoxSelection = (event: PointerEvent) => {
      const gesture = boxSelectionGesture.current
      if (!gesture || event.button !== 0) return
      if (gesture.dragging) suppressBoxSelectionClick.current = true
      boxSelectionGesture.current = null
      setBoxSelectionScreenRect(null)
    }

    const cancelBoxSelection = () => {
      const gesture = boxSelectionGesture.current
      if (!gesture) return
      boxSelectionGesture.current = null
      setBoxSelectionScreenRect(null)
      if (!gesture.dragging) return
      suppressBoxSelectionClick.current = true
      applySelectedNodeIds(gesture.baseSelectedIds)
    }

    const cancelBoxSelectionOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelBoxSelection()
    }

    window.addEventListener('pointermove', moveBoxSelection, { passive: false })
    window.addEventListener('pointerup', finishBoxSelection)
    window.addEventListener('pointercancel', cancelBoxSelection)
    window.addEventListener('blur', cancelBoxSelection)
    window.addEventListener('keydown', cancelBoxSelectionOnEscape)
    return () => {
      window.removeEventListener('pointermove', moveBoxSelection)
      window.removeEventListener('pointerup', finishBoxSelection)
      window.removeEventListener('pointercancel', cancelBoxSelection)
      window.removeEventListener('blur', cancelBoxSelection)
      window.removeEventListener('keydown', cancelBoxSelectionOnEscape)
    }
  }, [applySelectedNodeIds, screenToFlowPosition])

  useEffect(() => {
    if (viewMode !== 'mindmap') {
      setBoxSelectionArmed(false)
      return
    }

    const syncBoxSelectionArmed = (event: KeyboardEvent) => setBoxSelectionArmed(event.ctrlKey || event.metaKey)
    const disarmBoxSelection = () => setBoxSelectionArmed(false)

    window.addEventListener('keydown', syncBoxSelectionArmed)
    window.addEventListener('keyup', syncBoxSelectionArmed)
    window.addEventListener('blur', disarmBoxSelection)
    document.addEventListener('visibilitychange', disarmBoxSelection)
    return () => {
      window.removeEventListener('keydown', syncBoxSelectionArmed)
      window.removeEventListener('keyup', syncBoxSelectionArmed)
      window.removeEventListener('blur', disarmBoxSelection)
      document.removeEventListener('visibilitychange', disarmBoxSelection)
    }
  }, [viewMode])

  const restoreNodeDragForTouchPan = useCallback(() => {
    const snapshot = dragSnapshot.current
    if (!snapshot) return

    setNodes((current) => current.map((node) => {
      const originalPosition = node.id === snapshot.rootId
        ? snapshot.rootPosition
        : snapshot.descendantPositions.get(node.id) ?? snapshot.selectedPositions.get(node.id)
      if (!originalPosition
        || (node.position.x === originalPosition.x && node.position.y === originalPosition.y)) return node
      return { ...node, position: { ...originalPosition } }
    }))
    dragSnapshot.current = null
    dropTargetIdRef.current = null
    setDropTargetId(null)
    cancelHistoryTransaction()
  }, [cancelHistoryTransaction, setNodes])

  const resetTouchPanBaseline = useCallback((points: { x: number; y: number }[]) => {
    if (points.length < 2) {
      touchPanGesture.current = null
      return
    }

    const [first, second] = points
    const [x, y, zoom] = reactFlowStore.getState().transform
    touchPanGesture.current = {
      startCentroid: touchPointCentroid(first, second),
      startDistance: touchPointDistance(first, second),
      viewport: { x, y, zoom },
    }
  }, [reactFlowStore])

  const cancelTouchCanvasPan = useCallback(() => {
    const wasActive = touchCanvasPanGesture.current?.active === true
    touchCanvasPanGesture.current = null
    if (!wasActive) return
    touchPanOwned.current = false
    setTouchPanning(false)
  }, [])

  const startTouchCanvasPan = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (viewMode !== 'mindmap' || knowledgeConnection || touchPanOwned.current || event.touches.length !== 1) return
    const target = event.target
    if (!(target instanceof Element)) return
    const panTarget = target.closest('.react-flow__node, .react-flow__edge, .react-flow__edge-textwrapper')
    if (!panTarget) return
    const allowedControl = target.closest(PAN_ALLOWED_NODE_CONTROL_SELECTOR)
    const blockedTarget = target.closest('button, a, input, textarea, select, [contenteditable="true"], .nodrag, .react-flow__handle, .react-flow__resize-control')
    if (blockedTarget && !allowedControl) return

    const touch = event.touches.item(0)
    if (!touch) return
    const [x, y, zoom] = reactFlowStore.getState().transform
    touchCanvasPanGesture.current = {
      identifier: touch.identifier,
      startClient: { x: touch.clientX, y: touch.clientY },
      viewport: { x, y, zoom },
      active: false,
    }
  }, [knowledgeConnection, reactFlowStore, viewMode])

  const moveTouchCanvasPan = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const gesture = touchCanvasPanGesture.current
    if (!gesture) return
    const touch = touchWithIdentifier(event.touches, gesture.identifier)
    if (!touch) return
    const deltaX = touch.clientX - gesture.startClient.x
    const deltaY = touch.clientY - gesture.startClient.y
    if (!gesture.active) {
      if (Math.hypot(deltaX, deltaY) <= TOUCH_DRAG_MOVE_THRESHOLD) return
      gesture.active = true
      touchPanOwned.current = true
      setTouchPanning(true)
      setNodeContextMenu(null)
    }

    event.preventDefault()
    event.stopPropagation()
    suppressTouchClickUntil.current = Date.now() + 500
    void setViewport({
      x: gesture.viewport.x + deltaX,
      y: gesture.viewport.y + deltaY,
      zoom: gesture.viewport.zoom,
    }, { duration: 0 })
  }, [setViewport])

  const finishTouchCanvasPan = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const gesture = touchCanvasPanGesture.current
    if (!gesture || !touchWithIdentifier(event.changedTouches, gesture.identifier)) return
    touchCanvasPanGesture.current = null
    if (!gesture.active) return

    event.preventDefault()
    event.stopPropagation()
    suppressTouchClickUntil.current = Date.now() + 500
    touchPanOwned.current = false
    setTouchPanning(false)
  }, [])

  const startTouchPan = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (viewMode !== 'mindmap') return
    const points = touchPointsWithin(event.currentTarget, event.touches)
    if (points.length < 2) return
    event.preventDefault()
    event.stopPropagation()
    suppressTouchClickUntil.current = Date.now() + 500
    if (!touchPanOwned.current) {
      touchPanOwned.current = true
      setTouchPanning(true)
      setNodeContextMenu(null)
      restoreNodeDragForTouchPan()
    }
    resetTouchPanBaseline(points)
  }, [resetTouchPanBaseline, restoreNodeDragForTouchPan, viewMode])

  const moveTouchPan = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (!touchPanOwned.current) return

    event.preventDefault()
    event.stopPropagation()
    const gesture = touchPanGesture.current
    const [first, second] = touchPointsWithin(event.currentTarget, event.touches)
    if (!gesture || !first || !second) return

    const nextViewport = viewportForTouchGesture({
      startCentroid: gesture.startCentroid,
      currentCentroid: touchPointCentroid(first, second),
      startDistance: gesture.startDistance,
      currentDistance: touchPointDistance(first, second),
      viewport: gesture.viewport,
      minZoom: MINDMAP_MIN_ZOOM,
      maxZoom: MINDMAP_MAX_ZOOM,
    })
    suppressTouchClickUntil.current = Date.now() + 500
    void setViewport(nextViewport, { duration: 0 })
  }, [setViewport])

  const finishTouchPan = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (!touchPanOwned.current) return
    event.preventDefault()
    suppressTouchClickUntil.current = Date.now() + 500
    const remainingPoints = touchPointsWithin(event.currentTarget, event.touches)
    if (remainingPoints.length >= 2) {
      resetTouchPanBaseline(remainingPoints)
      return
    }
    touchPanGesture.current = null
    if (remainingPoints.length === 0) {
      touchPanOwned.current = false
      setTouchPanning(false)
    }
  }, [resetTouchPanBaseline])

  useEffect(() => {
    const cancelTouchPan = () => {
      touchPanGesture.current = null
      touchCanvasPanGesture.current = null
      touchPanOwned.current = false
      setTouchPanning(false)
    }
    window.addEventListener('blur', cancelTouchPan)
    return () => window.removeEventListener('blur', cancelTouchPan)
  }, [])

  const copyNode = useCallback((nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node || node.data.kind === 'image' || !activeMapId) return
    const selectedNodes = nodes.filter((candidate) => candidate.selected)
    const nodesToCopy = (selectedNodes.some((candidate) => candidate.id === nodeId) ? selectedNodes : [node])
      .filter((candidate) => candidate.data.kind !== 'image')
    const copiedNodeIds = new Set(nodesToCopy.map((candidate) => candidate.id))
    setCopiedNodes({
      sourceMapId: activeMapId,
      nodes: nodesToCopy.map((candidate) => {
        const copiedData = structuredClone(candidate.data)
        delete copiedData.aiConversationId
        delete copiedData.aiConversations
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
    setCopiedImages(null)
    setNodeContextMenu(null)
  }, [activeMapId, edges, nodes])

  const copyImageNodes = useCallback(async (nodeId: string) => {
    if (mode !== 'editor' || !activeMapId) return
    const node = nodes.find((candidate) => candidate.id === nodeId)
    if (!node || node.data.kind !== 'image' || !node.data.image) return
    const imagesToCopy = node.selected
      ? nodes.filter((candidate) => candidate.selected && candidate.data.kind === 'image' && candidate.data.image)
      : [node]

    setNodeContextMenu(null)
    setSaveError('')
    setSavedAt(imagesToCopy.length > 1 ? `이미지 ${imagesToCopy.length}개 복사 중…` : '이미지 복사 중…')
    try {
      const copiedItems = await Promise.all(imagesToCopy.map(async (candidate): Promise<CopiedImageItem> => {
        const image = candidate.data.image!
        const response = await fetch(imageAssetUrl(activeMapId, image.assetId), { credentials: 'include' })
        if (!response.ok) throw new Error(`이미지 원본을 불러오지 못했습니다: ${image.fileName}`)
        const blob = await response.blob()
        return {
          sourceNodeId: candidate.id,
          file: new File([blob], image.fileName, { type: image.mimeType }),
          image: structuredClone(image),
          description: candidate.data.description,
          position: { ...candidate.position },
        }
      }))
      const token = crypto.randomUUID()
      await copyTextToClipboard(`${IMAGE_CLIPBOARD_MARKER_PREFIX}${token}`)
      setCopiedNodes(null)
      setCopiedImages({
        token,
        sourceMapId: activeMapId,
        images: copiedItems,
      })
      setSavedAt(imagesToCopy.length > 1
        ? `이미지 ${imagesToCopy.length}개 복사됨 · 다른 문서에서 붙여넣을 수 있음`
        : '이미지 복사됨 · 다른 문서에서 붙여넣을 수 있음')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '이미지를 복사하지 못했습니다.')
      setSavedAt('이미지 복사 실패')
    }
  }, [activeMapId, mode, nodes])

  // parentId가 없으면 계층선을 만들지 않고 clientPoint 위치에 자유 배치한다.
  // 지식 전용 Ref 카드는 계층에 들어가지 않아야 하며, 이미지·Dooray 지식 카드와 같은 배치 방식이다.
  const pasteNodeAsChild = useCallback((
    parentId: string | null,
    pasteMode: NodePasteMode = 'copy',
    clientPoint?: { x: number; y: number },
  ) => {
    if (!copiedNodes || copiedNodes.nodes.length === 0 || mode !== 'editor' || !activeMapId) return
    const parent = parentId ? nodes.find((node) => node.id === parentId) ?? null : null
    if (parentId && !parent) return
    if (!parent && !clientPoint) return
    const isCrossDocument = copiedNodes.sourceMapId !== activeMapId
    if ((isCrossDocument && pasteMode === 'copy') || (!isCrossDocument && pasteMode !== 'copy')) return
    const childCount = parent ? hierarchyEdges.filter((edge) => edge.source === parent.id).length : 0
    const timestamp = Date.now()
    const sourceMinX = Math.min(...copiedNodes.nodes.map((item) => item.position.x))
    const sourceMinY = Math.min(...copiedNodes.nodes.map((item) => item.position.y))
    const targetOrigin = parent
      ? {
        x: childMindMapHorizontalPosition(parent.position, nodeDimensions(parent).width),
        y: parent.position.y + childCount * 150 - 40,
      }
      : snapMindMapPosition(screenToFlowPosition({ x: clientPoint!.x, y: clientPoint!.y }))
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
          aiConversations: undefined,
          reference: pasteMode === 'reference' ? originalReference : pasteMode === 'clone' ? undefined : copiedData.reference,
          blockedBy: remappedBlockedBy.length > 0 ? remappedBlockedBy : undefined,
          unresolvedDependencyCount: undefined,
          referenceUnresolved: undefined,
          blockedByLabels: undefined,
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
    const pastedRootEdges = parent
      ? copiedNodes.nodes
        .filter((item) => !copiedHierarchyTargets.has(item.sourceNodeId))
        .map((item, index): MindMapEdge => ({
          id: `edge-${parent.id}-${timestamp}-root-${index}`,
          source: parent.id,
          target: nodeIdMap.get(item.sourceNodeId) as string,
          sourceHandle: parent.data.kind === 'image' ? 'image-source-right' : undefined,
          type: 'default',
          data: { relation: 'hierarchy' },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        }))
      : []
    const suppressedNodeIds = pastedNodeNotificationSuppressions.current.get(activeMapId) ?? new Set<string>()
    pastedNodes.forEach((pastedNode) => suppressedNodeIds.add(pastedNode.id))
    pastedNodeNotificationSuppressions.current.set(activeMapId, suppressedNodeIds)
    setNodes((current) => [...current.map((node) => node.selected ? { ...node, selected: false } : node), ...pastedNodes])
    setEdges((current) => [...current, ...pastedInternalEdges, ...pastedRootEdges])
    setSelectedId(pastedNodes[0].id)
    setNodeContextMenu(null)
  }, [activeMapId, copiedNodes, hierarchyEdges, mode, nodes, screenToFlowPosition, setEdges, setNodes])

  useEffect(() => {
    const closeContextMenu = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target?.closest('.node-context-menu')) {
        setNodeContextMenu(null)
        setDocumentContextMenu(null)
        setAiConversationContextMenu(null)
        setCanvasPasteMenu(null)
      }
      if (!target?.closest('.notification-center')) setNotificationsOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dailyBackupPreview) {
          setDailyBackupPreview(null)
          return
        }
        cancelKnowledgeConnection()
        setNodeContextMenu(null)
        setDocumentContextMenu(null)
        setAiConversationContextMenu(null)
        setCanvasPasteMenu(null)
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
  }, [cancelKnowledgeConnection, dailyBackupPreview])

  useEffect(() => {
    cancelKnowledgeConnection()
    setNodeContextMenu(null)
    setDocumentContextMenu(null)
    setAiConversationContextMenu(null)
  }, [activeMapId, cancelKnowledgeConnection, viewMode])

  useEffect(() => {
    if (knowledgeConnection && !nodes.some((node) => node.id === knowledgeConnection.sourceId)) {
      cancelKnowledgeConnection()
    }
  }, [cancelKnowledgeConnection, knowledgeConnection, nodes])

  useEffect(() => {
    setPreviewImageNodeId(null)
  }, [activeMapId])

  useEffect(() => {
    if (previewImageNodeId && !previewImageNode) setPreviewImageNodeId(null)
  }, [previewImageNode, previewImageNodeId])

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
      reconcileRemoteMap(updated.map)
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
      if (mapId === activeMapId) reconcileRemoteMap(updated.map)
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
      window.setTimeout(() => showFullMindMap(400), 0)
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
      window.setTimeout(() => showFullMindMap(400), 0)
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '일일 백업을 복원하지 못했습니다.')
    } finally {
      setHistoryLoading(false)
    }
  }

  const previewDailyBackup = async (backup: DailyBackupSummary) => {
    if (!activeMapId || dailyBackupPreviewLoadingDate) return
    setDailyBackupPreviewLoadingDate(backup.date)
    setHistoryError('')
    try {
      const result = await apiRequest<{ backup: DailyBackupPreview }>(
        `/api/maps/${encodeURIComponent(activeMapId)}/backups/daily/${encodeURIComponent(backup.date)}/preview`,
      )
      setDailyBackupPreview(result.backup)
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '일일 백업 미리보기를 열지 못했습니다.')
    } finally {
      setDailyBackupPreviewLoadingDate(null)
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
    setCollapsedDocumentGroupIds((current) => new Set(current).add(group.id))
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
      const completedNodes = sourceMap.nodes.map((node) => node.data.kind === 'image' ? node : ({
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
        reconcileRemoteMap(result.map)
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

  const trackCanvasPointer = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    canvasPointerRef.current = { inside: true, x: event.clientX, y: event.clientY }
    applyGridGuide(event.altKey)
    shareCursorPosition(event)
  }, [applyGridGuide, shareCursorPosition])

  const addImageFilesAtPoint = useCallback(async (
    files: File[],
    clientPoint: { x: number; y: number },
    placementOverrides: ImagePlacementOverride[] = [],
  ) => {
    if (mode !== 'editor' || viewMode !== 'mindmap' || !activeMapId || loadedMapId !== activeMapId) return
    const targetMapId = activeMapId
    const flowPoint = screenToFlowPosition(clientPoint)
    const createdNodes: MindMapNode[] = []
    let lastError = ''
    setSaveError('')
    setSavedAt('이미지 업로드 중…')

    for (const [index, file] of files.entries()) {
      try {
        if (!isSupportedImageFile(file)) {
          throw new Error('PNG, JPEG, GIF 또는 WebP 이미지만 추가할 수 있습니다.')
        }
        const natural = await imageFileDimensions(file)
        if (natural.width < 1 || natural.height < 1) throw new Error('이미지 크기를 확인하지 못했습니다.')
        const uploaded = await uploadMindMapImage(targetMapId, file)
        const placementOverride = placementOverrides[index]
        const display = placementOverride
          && Number.isFinite(placementOverride.displayWidth) && placementOverride.displayWidth > 0
          && Number.isFinite(placementOverride.displayHeight) && placementOverride.displayHeight > 0
          ? { width: placementOverride.displayWidth, height: placementOverride.displayHeight }
          : defaultImageDisplaySize(natural.width, natural.height)
        const defaultOffset = index * 24
        const offsetX = placementOverride?.offsetX ?? defaultOffset
        const offsetY = placementOverride?.offsetY ?? defaultOffset
        const image: MindImageData = {
          assetId: uploaded.assetId,
          fileName: (file.name.trim() || '붙여넣은 이미지').slice(0, 240),
          mimeType: uploaded.mimeType,
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          displayWidth: display.width,
          displayHeight: display.height,
        }
        createdNodes.push({
          id: `image-${crypto.randomUUID()}`,
          type: 'mind',
          position: {
            x: flowPoint.x - display.width / 2 + offsetX,
            y: flowPoint.y - display.height / 2 + offsetY,
          },
          selected: true,
          connectable: false,
          deletable: false,
          data: {
            label: image.fileName,
            description: placementOverride?.description ?? '',
            progress: 0,
            status: 'planned',
            kind: 'image',
            image,
          },
        })
      } catch (error) {
        lastError = error instanceof Error ? error.message : '이미지를 추가하지 못했습니다.'
      }
    }

    if (activeMapIdRef.current !== targetMapId || createdNodes.length === 0) {
      if (lastError) setSaveError(lastError)
      else setSavedAt('이미지 추가 취소됨')
      return
    }

    const selectedImageId = createdNodes.at(-1)?.id ?? null
    setNodes((current) => {
      const usedFileNames = new Set(current.flatMap((node) => {
        if (!node.data.image) return []
        const { name, extension } = splitImageFileName(node.data.image.fileName, node.data.image.mimeType)
        return [`${name}${extension}`.toLowerCase()]
      }))
      const uniquelyNamedNodes = createdNodes.map((node) => {
        if (!node.data.image) return node
        const fileName = uniqueImageFileName(node.data.image.fileName, node.data.image.mimeType, usedFileNames)
        usedFileNames.add(fileName.toLowerCase())
        return {
          ...node,
          data: {
            ...node.data,
            label: fileName,
            image: { ...node.data.image, fileName },
          },
        }
      })
      const keepMultiSelection = uniquelyNamedNodes.length > 1 && placementOverrides.length === files.length
      return [
        ...current.map((node) => node.selected ? { ...node, selected: false } : node),
        ...uniquelyNamedNodes.map((node) => ({ ...node, selected: keepMultiSelection || node.id === selectedImageId })),
      ]
    })
    setSelectedId(selectedImageId)
    setSavedAt(createdNodes.length > 1 ? `이미지 ${createdNodes.length}개 추가됨` : '이미지 추가됨')
    if (lastError) setSaveError(`일부 이미지를 추가하지 못했습니다. ${lastError}`)
  }, [activeMapId, loadedMapId, mode, screenToFlowPosition, setNodes, viewMode])

  const pasteCopiedImagesAtPoint = useCallback((clientPoint: { x: number; y: number }) => {
    if (!copiedImages || copiedImages.images.length === 0) return
    setCanvasPasteMenu(null)
    void addImageFilesAtPoint(
      copiedImages.images.map((item) => item.file),
      clientPoint,
      copiedImagePlacementOverrides(copiedImages.images),
    )
  }, [addImageFilesAtPoint, copiedImages])

  const addDoorayKnowledgeAtPoint = useCallback(async (url: string, clientPoint: { x: number; y: number }) => {
    if (mode !== 'editor' || viewMode !== 'mindmap' || !activeMapId || loadedMapId !== activeMapId) return
    const normalizedUrl = normalizedDoorayKnowledgeUrl(url)
    if (!normalizedUrl) return
    const sourceLabel = taskUrlProvider(normalizedUrl) === 'dooray-wiki' ? 'Dooray Wiki' : 'Dooray 업무'
    const existing = nodes.find((node) => isSameDoorayKnowledgeUrl(node.data.taskUrl ?? '', normalizedUrl))
    if (existing) {
      const { width, height } = nodeDimensions(existing)
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === existing.id })))
      setSelectedId(existing.id)
      focusedNodeIdRef.current = null
      setCenter(existing.position.x + width / 2, existing.position.y + height / 2, { duration: 350 })
      setSavedAt(`이미 추가된 ${sourceLabel}를 선택함`)
      return
    }
    if (resolvingDoorayUrls.current.has(normalizedUrl)) return

    const targetMapId = activeMapId
    const flowPoint = screenToFlowPosition(clientPoint)
    resolvingDoorayUrls.current.add(normalizedUrl)
    setSaveError('')
    setSavedAt(`${sourceLabel} 조회 중…`)
    try {
      const preview = await fetchDoorayKnowledgePreview(normalizedUrl)
      if (activeMapIdRef.current !== targetMapId) {
        setSavedAt(`${sourceLabel} 추가 취소됨`)
        return
      }
      const { subject, ...source } = preview
      const sourceId = preview.provider === 'dooray-wiki' ? preview.pageId : preview.postId
      const createdId = `dooray-${sourceId}-${crypto.randomUUID()}`
      const remoteState = doorayKnowledgeState(preview)
      const externalLink: MindDoorayLinkData = {
        ...source,
        title: subject,
        displayWidth: MINDMAP_DOORAY_TASK_DEFAULT_WIDTH,
        displayHeight: MINDMAP_DOORAY_TASK_DEFAULT_HEIGHT,
      }
      setNodes((current) => [
        ...current.map((node) => node.selected ? { ...node, selected: false } : node),
        {
          id: createdId,
          type: 'mind',
          position: {
            x: flowPoint.x - MINDMAP_DOORAY_TASK_DEFAULT_WIDTH / 2,
            y: flowPoint.y - MINDMAP_DOORAY_TASK_DEFAULT_HEIGHT / 2,
          },
          selected: true,
          data: {
            label: subject,
            description: '',
            ...remoteState,
            kind: 'task',
            taskUrl: source.url,
            externalLink,
          },
        },
      ])
      setSelectedId(createdId)
      setSavedAt(`${sourceLabel} 추가됨`)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : `${sourceLabel}를 추가하지 못했습니다.`)
      setSavedAt(`${sourceLabel} 추가 실패`)
    } finally {
      resolvingDoorayUrls.current.delete(normalizedUrl)
    }
  }, [activeMapId, loadedMapId, mode, nodes, screenToFlowPosition, setCenter, setNodes, viewMode])

  useEffect(() => {
    if (mode !== 'editor' || viewMode !== 'mindmap') return
    const handleClipboardContent = (event: ClipboardEvent) => {
      const pointer = canvasPointerRef.current
      if (!pointer.inside) return
      const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
      if (focusedElement?.closest('input, textarea, select, [contenteditable="true"]')) return
      const elementAtPointer = document.elementFromPoint(pointer.x, pointer.y)
      if (!elementAtPointer?.closest('.canvas-wrap')
        || elementAtPointer.closest('.react-flow__panel, .react-flow__controls, .react-flow__minimap')) return
      const clipboardText = event.clipboardData?.getData('text/plain') ?? ''
      if (copiedImages && clipboardText.trim() === `${IMAGE_CLIPBOARD_MARKER_PREFIX}${copiedImages.token}`) {
        event.preventDefault()
        pasteCopiedImagesAtPoint({ x: pointer.x, y: pointer.y })
        return
      }
      const files = [...(event.clipboardData?.items ?? [])]
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file))
      if (files.length > 0) {
        event.preventDefault()
        void addImageFilesAtPoint(files, { x: pointer.x, y: pointer.y })
        return
      }
      const doorayUrl = normalizedDoorayKnowledgeUrl(clipboardText)
      if (!doorayUrl) return
      event.preventDefault()
      void addDoorayKnowledgeAtPoint(doorayUrl, { x: pointer.x, y: pointer.y })
    }

    window.addEventListener('paste', handleClipboardContent)
    return () => window.removeEventListener('paste', handleClipboardContent)
  }, [addDoorayKnowledgeAtPoint, addImageFilesAtPoint, copiedImages, mode, pasteCopiedImagesAtPoint, viewMode])

  const submitComment = async () => {
    const summary = newComment.trim()
    const detail = newCommentDetail.trim()
    if (!selectedCommentMapId || !selectedCommentNodeId || !summary) return
    setCommentError('')
    try {
      const result = await apiRequest<{ comment: NodeComment }>(`/api/maps/${encodeURIComponent(selectedCommentMapId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          nodeId: selectedCommentNodeId,
          summary,
          ...(detail ? { detail } : {}),
          parentId: null,
        }),
      })
      setComments((current) => current.some((comment) => comment.id === result.comment.id) ? current : [...current, result.comment])
      setNewComment('')
      setNewCommentDetail('')
      setCommentDetailOpen(false)
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
      if (replyTarget && result.deletedIds.includes(replyTarget.id)) cancelReply()
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

  const appendMention = (current: string, name: string) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${name} `

  const insertMention = (collaborator: AuthUser) => {
    setNewComment((current) => appendMention(current, collaborator.name))
  }

  const insertReplyMention = (collaborator: AuthUser) => {
    setReplySummary((current) => appendMention(current, collaborator.name))
  }

  const cancelReply = () => {
    setReplyTarget(null)
    setReplySummary('')
    setReplyDetail('')
    setReplyDetailOpen(false)
    setReplyError('')
  }

  const submitReply = async () => {
    const summary = replySummary.trim()
    const detail = replyDetail.trim()
    if (!selectedCommentMapId || !selectedCommentNodeId || !replyTarget || !summary) return
    setReplyError('')
    try {
      const result = await apiRequest<{ comment: NodeComment }>(`/api/maps/${encodeURIComponent(selectedCommentMapId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          nodeId: selectedCommentNodeId,
          summary,
          ...(detail ? { detail } : {}),
          parentId: replyTarget.id,
        }),
      })
      setComments((current) => current.some((comment) => comment.id === result.comment.id) ? current : [...current, result.comment])
      cancelReply()
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : '답글을 등록하지 못했습니다.')
    }
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
    if (touchPanOwned.current) return
    const currentSelectedId = selectedIdRef.current
    if (currentSelectedId && selected.some((node) => node.id === currentSelectedId)) return

    setSelectedId(selected.at(-1)?.id ?? null)
  }, [])

  const onNodeClick = useCallback((event: ReactMouseEvent, node: MindMapNode) => {
    if (Date.now() < suppressTouchClickUntil.current) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (knowledgeConnection) {
      event.preventDefault()
      event.stopPropagation()
      const issue = connectKnowledgeCards(knowledgeConnection.sourceId, node.id, knowledgeConnection.policy)
      if (issue) {
        setKnowledgeConnectionTargetId(node.id)
        setKnowledgeConnectionMessage(issue)
        return
      }
      cancelKnowledgeConnection()
      setSelectedId(node.id)
      return
    }
    setSelectedId(node.id)
  }, [cancelKnowledgeConnection, connectKnowledgeCards, knowledgeConnection])

  const onKnowledgeTargetEnter = useCallback((_event: ReactMouseEvent, node: MindMapNode) => {
    if (!knowledgeConnection) return
    setKnowledgeConnectionTargetId(node.id)
    setKnowledgeConnectionMessage(knowledgeConnectionIssue(knowledgeConnection.sourceId, node.id, nodes, edges))
  }, [edges, knowledgeConnection, nodes])

  const onKnowledgeTargetLeave = useCallback((_event: ReactMouseEvent, node: MindMapNode) => {
    if (!knowledgeConnection) return
    setKnowledgeConnectionTargetId((current) => current === node.id ? null : current)
    setKnowledgeConnectionMessage('')
  }, [knowledgeConnection])

  const startNodeDrag = useCallback((draggedNode: MindMapNode) => {
    if (touchPanOwned.current) return
    beginHistoryTransaction()
    dropTargetIdRef.current = null
    setDropTargetId(null)
    const draggedNodeIsSelected = draggedNode.selected
      || nodes.some((node) => node.id === draggedNode.id && node.selected)
    // 여러 카드를 선택해 끌면 선택한 카드 각각의 하위가 모두 따라와야 한다.
    const selectedNodeIds = draggedNodeIsSelected
      ? [draggedNode.id, ...nodes.filter((node) => node.selected).map((node) => node.id)]
      : []
    const rootIds = dragRootIds(draggedNode.id, selectedNodeIds)
    const descendantRootIds = collectDragDescendantOwners(rootIds, hierarchyEdges)

    const descendantPositions = new Map<string, { x: number; y: number }>()
    const selectedPositions = new Map<string, { x: number; y: number }>()

    for (const node of nodes) {
      if (descendantRootIds.has(node.id)) {
        descendantPositions.set(node.id, { ...node.position })
      }
      if (draggedNodeIsSelected && node.selected && node.id !== draggedNode.id) {
        selectedPositions.set(node.id, { ...node.position })
      }
    }

    dragSnapshot.current = {
      rootId: draggedNode.id,
      rootIds: [...rootIds],
      rootPosition: { ...draggedNode.position },
      descendantPositions,
      descendantRootIds,
      selectedPositions,
    }
  }, [beginHistoryTransaction, hierarchyEdges, nodes])

  const onNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, draggedNode: MindMapNode) => {
    focusedNodeIdRef.current = null
    startNodeDrag(draggedNode)
  }, [startNodeDrag])

  const moveNodeDrag = useCallback((draggedNode: MindMapNode, snapToGrid: boolean) => {
    if (touchPanOwned.current) return
    const snapshot = dragSnapshot.current
    if (!snapshot || snapshot.rootId !== draggedNode.id) return

    const draggedPosition = snapToGrid ? snapMindMapPosition(draggedNode.position) : draggedNode.position
    const deltaX = draggedPosition.x - snapshot.rootPosition.x
    const deltaY = draggedPosition.y - snapshot.rootPosition.y

    setNodes((current) => current.map((node) => {
      if (node.id === draggedNode.id) {
        return { ...node, position: { ...draggedPosition } }
      }

      const initialPosition = snapshot.descendantPositions.get(node.id)
        ?? (snapToGrid ? snapshot.selectedPositions.get(node.id) : undefined)
      if (!initialPosition) return node

      return {
        ...node,
        position: {
          x: initialPosition.x + deltaX,
          y: initialPosition.y + deltaY,
        },
      }
    }))

    if (draggedNode.data.kind === 'image') {
      if (dropTargetIdRef.current !== null) {
        dropTargetIdRef.current = null
        setDropTargetId(null)
      }
      setSavedAt('저장 중…')
      return
    }

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
      .filter((node) => node.data.kind !== 'image' && !invalidTargetIds.has(node.id) && node.id !== currentParentId && !node.hidden)
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

  const onNodeDrag = useCallback((event: MouseEvent | TouchEvent, draggedNode: MindMapNode) => {
    moveNodeDrag(draggedNode, event.altKey)
  }, [moveNodeDrag])

  const stopNodeDrag = useCallback((draggedNode: MindMapNode, snapToGrid: boolean) => {
    const snapshot = dragSnapshot.current
    const targetId = dropTargetIdRef.current
    const draggedPosition = snapToGrid ? snapMindMapPosition(draggedNode.position) : draggedNode.position

    if (snapshot && targetId) {
      const target = nodes.find((node) => node.id === targetId)
      if (target) {
        const eligibleReparentIds = snapshot.rootIds.filter((nodeId) =>
          nodes.some((node) => node.id === nodeId && node.data.kind !== 'image'))
        const reparentPairs = hierarchyReparentPairs(targetId, eligibleReparentIds)
        const reparentIds = reparentPairs.map((pair) => pair.target)
        const reparentIdSet = new Set(reparentIds)
        const childCount = hierarchyEdges.filter((edge) =>
          edge.source === targetId && !reparentIdSet.has(edge.target)).length
        const desiredRootPositions = new Map<string, { x: number; y: number }>()
        const initialRootPositions = new Map<string, { x: number; y: number }>([
          [snapshot.rootId, snapshot.rootPosition],
          ...snapshot.selectedPositions.entries(),
        ])

        reparentIds.forEach((nodeId, index) => {
          const automaticPosition = {
            x: childMindMapHorizontalPosition(target.position, nodeDimensions(target).width),
            y: target.position.y + (childCount + index) * 150 - 40,
          }
          desiredRootPositions.set(
            nodeId,
            snapToGrid ? snapMindMapPosition(automaticPosition) : automaticPosition,
          )
        })

        setNodes((current) => current.map((node) => {
          const desiredRootPosition = desiredRootPositions.get(node.id)
          if (desiredRootPosition) return { ...node, position: desiredRootPosition }

          const ownerRootId = snapshot.descendantRootIds.get(node.id)
          if (!ownerRootId) return node
          const initialRootPosition = initialRootPositions.get(ownerRootId)
          const nextRootPosition = desiredRootPositions.get(ownerRootId)
          const initialPosition = snapshot.descendantPositions.get(node.id)
          if (!initialRootPosition || !nextRootPosition || !initialPosition) return node
          return {
            ...node,
            position: {
              x: initialPosition.x + nextRootPosition.x - initialRootPosition.x,
              y: initialPosition.y + nextRootPosition.y - initialRootPosition.y,
            },
          }
        }))
        setEdges((current) => [
          ...current.filter((edge) => !isHierarchyEdge(edge) || !reparentIdSet.has(edge.target)),
          ...reparentPairs.map<MindMapEdge>((pair) => ({
            id: `edge-${pair.source}-${pair.target}-${Date.now()}`,
            source: pair.source,
            target: pair.target,
            sourceHandle: target.data.kind === 'image' ? 'image-source-right' : undefined,
            type: 'default',
            data: { relation: 'hierarchy' },
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          })),
        ])
        setSelectedId(draggedNode.id)
        setSavedAt(reparentIds.length > 1 ? `${reparentIds.length}개 카드 부모 변경됨` : '부모 노드 변경됨')
      }
    } else if (snapshot && snapToGrid) {
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

  const onNodeDragStop = useCallback((event: MouseEvent | TouchEvent, draggedNode: MindMapNode) => {
    stopNodeDrag(draggedNode, event.altKey)
  }, [stopNodeDrag])

  const cancelTouchCardGesture = useCallback((restorePosition: boolean) => {
    const gesture = touchCardGesture.current
    if (!gesture) return
    if (gesture.timer !== null) window.clearTimeout(gesture.timer)
    touchCardGesture.current = null
    if (gesture.phase === 'armed' || gesture.phase === 'dragging') setNodeContextMenu(null)
    if (restorePosition && gesture.phase === 'dragging') restoreNodeDragForTouchPan()
  }, [restoreNodeDragForTouchPan])

  const cancelTouchPaneGesture = useCallback(() => {
    const gesture = touchPaneGesture.current
    if (!gesture) return
    if (gesture.timer !== null) window.clearTimeout(gesture.timer)
    touchPaneGesture.current = null
  }, [])

  // 빈 캔버스 롱 프레스는 브라우저 기본 컨텍스트 메뉴가 뜨지 않으므로(React Flow가 터치 이벤트를 잡는다)
  // 카드 롱 프레스와 같은 방식으로 직접 캔버스 메뉴를 띄운다.
  const startTouchPaneGesture = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    cancelTouchPaneGesture()
    if (mode !== 'editor' || viewMode !== 'mindmap' || knowledgeConnection || touchPanOwned.current) return
    if (event.touches.length !== 1) return
    const hasCrossDocumentNodeCopy = Boolean(copiedNodes && copiedNodes.nodes.length > 0 && copiedNodes.sourceMapId !== activeMapId)
    if (!copiedImages && !hasCrossDocumentNodeCopy) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest('.react-flow__pane')) return
    const touch = event.touches.item(0)
    if (!touch) return

    const gesture: TouchPaneGesture = {
      identifier: touch.identifier,
      startClient: { x: touch.clientX, y: touch.clientY },
      timer: null,
      menuOpen: false,
    }
    touchPaneGesture.current = gesture
    gesture.timer = window.setTimeout(() => {
      if (touchPaneGesture.current !== gesture) return
      gesture.timer = null
      gesture.menuOpen = true
      suppressTouchClickUntil.current = Date.now() + 500
      setNodeContextMenu(null)
      setDocumentContextMenu(null)
      setAiConversationContextMenu(null)
      setCanvasPasteMenu({ x: gesture.startClient.x, y: gesture.startClient.y })
    }, TOUCH_CARD_LONG_PRESS_MS)
  }, [activeMapId, cancelTouchPaneGesture, copiedImages, copiedNodes, knowledgeConnection, mode, viewMode])

  const moveTouchPaneGesture = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const gesture = touchPaneGesture.current
    if (!gesture) return
    const touch = touchWithIdentifier(event.touches, gesture.identifier)
    if (!touch) {
      cancelTouchPaneGesture()
      return
    }
    const distance = Math.hypot(
      touch.clientX - gesture.startClient.x,
      touch.clientY - gesture.startClient.y,
    )
    if (distance <= TOUCH_DRAG_MOVE_THRESHOLD) return
    // 메뉴가 뜬 뒤 손가락을 움직여 맵을 옮기면 메뉴가 엉뚱한 위치에 남으므로 함께 닫는다.
    if (gesture.menuOpen) setCanvasPasteMenu(null)
    cancelTouchPaneGesture()
  }, [cancelTouchPaneGesture])

  const startTouchCardGesture = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    if (viewMode !== 'mindmap' || knowledgeConnection || touchPanOwned.current) return
    if (event.touches.length !== 1) return
    const target = event.target
    if (!(target instanceof Element)
      || target.closest('button, a, input, textarea, select, [contenteditable="true"], .nodrag, .react-flow__handle, .react-flow__resize-control')) return
    const nodeElement = target.closest<HTMLElement>('.react-flow__node[data-id]')
    const nodeId = nodeElement?.dataset.id
    const touch = event.touches.item(0)
    const node = nodeId ? nodesRef.current.find((candidate) => candidate.id === nodeId) : undefined
    if (!nodeId || !touch || !node) return

    event.preventDefault()
    event.stopPropagation()
    cancelTouchCardGesture(true)
    suppressTouchClickUntil.current = Date.now() + TOUCH_CARD_LONG_PRESS_MS + 800
    const gesture: TouchCardGesture = {
      identifier: touch.identifier,
      nodeId,
      startClient: { x: touch.clientX, y: touch.clientY },
      startFlow: screenToFlowPosition({ x: touch.clientX, y: touch.clientY }),
      startPosition: { ...node.position },
      currentPosition: { ...node.position },
      phase: 'pressing',
      timer: null,
    }
    touchCardGesture.current = gesture
    if (mode === 'editor') {
      suppressTouchContextMenu.current = {
        nodeId,
        until: Date.now() + TOUCH_CARD_LONG_PRESS_MS + 2_000,
      }
      gesture.timer = window.setTimeout(() => {
        if (touchCardGesture.current !== gesture || gesture.phase !== 'pressing') return
        gesture.timer = null
        gesture.phase = 'armed'
        lastTouchCardTap.current = null
        touchCanvasPanGesture.current = null
        setNodes((current) => synchronizeNodeSelection(current, gesture.nodeId))
        showNodeContextMenu(gesture.nodeId, gesture.startClient.x, gesture.startClient.y, {
          suppressMobileInspector: true,
        })
      }, TOUCH_CARD_LONG_PRESS_MS)
    }
  }, [cancelTouchCardGesture, knowledgeConnection, mode, screenToFlowPosition, setNodes, showNodeContextMenu, viewMode])

  const moveTouchCardGesture = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const gesture = touchCardGesture.current
    if (!gesture || touchPanOwned.current) return
    const touch = touchWithIdentifier(event.touches, gesture.identifier)
    if (!touch) return

    event.preventDefault()
    event.stopPropagation()
    suppressTouchClickUntil.current = Date.now() + 500
    const clientDistance = Math.hypot(
      touch.clientX - gesture.startClient.x,
      touch.clientY - gesture.startClient.y,
    )
    if (gesture.phase === 'pressing') {
      if (clientDistance <= TOUCH_DRAG_MOVE_THRESHOLD) return
      if (gesture.timer !== null) window.clearTimeout(gesture.timer)
      gesture.timer = null
      touchCardGesture.current = null
      lastTouchCardTap.current = null
      moveTouchCanvasPan(event)
      return
    }
    if (clientDistance <= TOUCH_DRAG_MOVE_THRESHOLD) return

    const node = nodesRef.current.find((candidate) => candidate.id === gesture.nodeId)
    if (!node) {
      cancelTouchCardGesture(true)
      return
    }
    if (gesture.phase === 'armed') {
      gesture.phase = 'dragging'
      setNodeContextMenu(null)
      startNodeDrag({ ...node, selected: true })
    }

    const flowPoint = screenToFlowPosition({ x: touch.clientX, y: touch.clientY })
    const position = snapMindMapPosition({
      x: gesture.startPosition.x + flowPoint.x - gesture.startFlow.x,
      y: gesture.startPosition.y + flowPoint.y - gesture.startFlow.y,
    })
    gesture.currentPosition = position
    moveNodeDrag({ ...node, position, selected: true }, true)
  }, [cancelTouchCardGesture, moveNodeDrag, moveTouchCanvasPan, screenToFlowPosition, startNodeDrag])

  const finishTouchCardGesture = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const gesture = touchCardGesture.current
    const touch = gesture ? touchWithIdentifier(event.changedTouches, gesture.identifier) : null
    if (!gesture || !touch) return
    event.preventDefault()
    event.stopPropagation()
    suppressTouchClickUntil.current = Date.now() + 500

    if (event.type === 'touchcancel') {
      cancelTouchCardGesture(true)
      return
    }
    if (gesture.timer !== null) window.clearTimeout(gesture.timer)
    gesture.timer = null
    touchCardGesture.current = null

    if (gesture.phase === 'pressing') {
      setNodes((current) => synchronizeNodeSelection(current, gesture.nodeId))
      setSelectedId(gesture.nodeId)
      const now = Date.now()
      const previousTap = lastTouchCardTap.current
      const isDoubleTap = Boolean(previousTap
        && previousTap.nodeId === gesture.nodeId
        && now - previousTap.at <= TOUCH_CARD_DOUBLE_TAP_MS
        && Math.hypot(touch.clientX - previousTap.client.x, touch.clientY - previousTap.client.y) <= TOUCH_CARD_DOUBLE_TAP_DISTANCE)
      lastTouchCardTap.current = isDoubleTap
        ? null
        : { nodeId: gesture.nodeId, at: now, client: { x: touch.clientX, y: touch.clientY } }
      if (isDoubleTap) toggleNodeFocus(gesture.nodeId)
      return
    }
    if (gesture.phase !== 'dragging') return
    const node = nodesRef.current.find((candidate) => candidate.id === gesture.nodeId)
    if (node) stopNodeDrag({ ...node, position: gesture.currentPosition, selected: true }, true)
    else restoreNodeDragForTouchPan()
  }, [cancelTouchCardGesture, restoreNodeDragForTouchPan, setNodes, stopNodeDrag, toggleNodeFocus])

  useEffect(() => {
    const cancelOnBlur = () => cancelTouchCardGesture(true)
    window.addEventListener('blur', cancelOnBlur)
    return () => {
      window.removeEventListener('blur', cancelOnBlur)
      const gesture = touchCardGesture.current
      if (gesture?.timer != null) window.clearTimeout(gesture.timer)
    }
  }, [cancelTouchCardGesture])

  useEffect(() => {
    cancelTouchCardGesture(true)
    cancelTouchCanvasPan()
  }, [activeMapId, cancelTouchCanvasPan, cancelTouchCardGesture, viewMode])

  useEffect(() => {
    if (replyTarget) replyInputRef.current?.focus()
  }, [replyTarget])

  const renderReplyForm = () => (
    <form className="comment-form comment-reply-form" onSubmit={(event) => { event.preventDefault(); void submitReply() }}>
      <div className="reply-target">
        <span><strong>{replyTarget?.author.name}</strong>님에게 답글</span>
        <button type="button" onClick={cancelReply} aria-label="답글 취소"><Icon name="close" size={11} /></button>
      </div>
      <label className="comment-summary-editor">
        <span>요약</span>
        <textarea ref={replyInputRef} value={replySummary} onChange={(event) => setReplySummary(event.target.value)} placeholder="답글의 핵심 내용을 입력하세요" maxLength={240} rows={2} />
        <small>{replySummary.length}/240</small>
      </label>
      <button
        type="button"
        className={`comment-detail-toggle ${replyDetailOpen ? 'open' : ''}`}
        onClick={() => setReplyDetailOpen((current) => !current)}
        aria-expanded={replyDetailOpen}
      >
        <span>{replyDetailOpen ? '상세 내용 접기' : replyDetail ? '작성한 상세 내용 보기' : '상세 내용 추가'}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      {replyDetailOpen && (
        <label className="comment-detail-editor">
          <span>상세</span>
          <textarea value={replyDetail} onChange={(event) => setReplyDetail(event.target.value)} placeholder="수행 내용, 중요한 판단, 변경 범위, 검증 결과, 산출물과 다음 단계를 입력하세요." maxLength={6000} rows={7} />
          <small>{replyDetail.length}/6000</small>
        </label>
      )}
      <div className="mention-tools">
        <span>멘션</span>
        {collaborators.filter((collaborator) => collaborator.id !== user.id).map((collaborator) => <button type="button" key={collaborator.id} onClick={() => insertReplyMention(collaborator)}>@{collaborator.name}</button>)}
      </div>
      {replyError && <div className="comment-error">{replyError}</div>}
      <div><small>답글은 이 댓글 아래에 등록됩니다</small><button type="submit" disabled={!replySummary.trim()}><Icon name="send" size={13} />답글</button></div>
    </form>
  )

  const renderDocumentListItem = (document: MapSummary, location: { type: 'top'; item: DocumentLayoutItem } | { type: 'group'; groupId: string }) => {
    const hasLoadedActiveDocument = document.id === activeMapId && loadedMapId === activeMapId
    const rootProgress = hasLoadedActiveDocument ? activeRootState.progress : document.rootProgress
    const rootStatus = hasLoadedActiveDocument ? activeRootState.status : document.rootStatus
    const nodeCount = hasLoadedActiveDocument ? nodes.length : document.nodeCount
    const waitingCount = hasLoadedActiveDocument
      ? nodes.reduce((count, node) => count + (node.data.waitingItems ?? []).filter((item) => item.label.trim()).length, 0)
      : document.waitingCount
    const aiActiveCount = aiConversationActiveCounts[document.id] ?? 0
    const dropKey = location.type === 'top' ? `top-map:${document.id}` : `group-map:${location.groupId}:${document.id}`

    return (
      <button
        key={document.id}
        draggable={mode === 'editor' && !normalizedDocumentSearch}
        className={`map-item ${location.type === 'group' ? 'group-document' : ''} ${document.id === activeMapId ? 'active' : ''} ${rootStatus === 'planned' ? 'root-planned' : ''} ${draggingLibraryItem?.type === 'map' && draggingLibraryItem.id === document.id ? 'dragging' : ''} ${documentDropTargetId === dropKey ? 'document-drop-target' : ''}`}
        onClick={() => { setRenamingMap(false); setActiveMapId(document.id); setMobileSidebarOpen(false) }}
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
            <AiConversationActivityIndicator activeCount={aiActiveCount} />
          </small>
        </span>
        {document.id === activeMapId && <Icon name="chevron" size={15} />}
      </button>
    )
  }

  return (
    <div className={`app-shell ${resizingSidebar ? 'resizing-sidebar' : ''} ${resizingInspector ? 'resizing-inspector' : ''}`}>
      <header className="topbar">
        <button
          type="button"
          className={`mobile-panel-button mobile-library-toggle ${mobileSidebarOpen ? 'active' : ''}`}
          onClick={() => {
            setMobileInspectorOpen(false)
            setMobileSidebarOpen((current) => !current)
          }}
          aria-controls="document-library-panel"
          aria-expanded={mobileSidebarOpen}
          aria-label="문서 목록 열기"
          title="문서 목록"
        >
          <Icon name="folder" size={18} />
        </button>
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
                setMobileSidebarOpen(false)
                setMobileInspectorOpen(false)
                if (id === 'mindmap') window.setTimeout(() => showFullMindMap(400), 0)
              }}
              aria-pressed={viewMode === id}
              title={label}
            >
              <Icon name={icon} size={14} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <button
          type="button"
          className={`mobile-panel-button mobile-inspector-toggle ${mobileInspectorOpen ? 'active' : ''}`}
          onClick={() => {
            setMobileSidebarOpen(false)
            setMobileInspectorOpen((current) => !current)
          }}
          aria-controls="node-inspector-panel"
          aria-expanded={mobileInspectorOpen}
          aria-label="선택 카드 세부정보 열기"
          title="선택 카드 세부정보"
          disabled={!selectedNode}
        >
          <Icon name="edit" size={18} />
        </button>
        <div className="topbar-actions">
          {!user.publicAccess && <AionUiSubscriptionUsageIndicator onOpen={() => {
            setNotificationsOpen(false)
            setAccountMenuOpen(false)
          }} />}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
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
          {mode === 'editor' && (
            <button
              className={`shared-knowledge-review-trigger ${sharedKnowledgeReviewOpen ? 'active' : ''}`}
              type="button"
              onClick={() => setSharedKnowledgeReviewOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={sharedKnowledgeReviewOpen}
              title="공유 지식 정리 후보 검토"
            >
              <Icon name="sparkles" size={15} /><span>지식 정리</span>
            </button>
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
                            : notification.type === 'waiting-released'
                              ? `${notification.actor.name}님이 외부 대기를 해제했습니다.`
                              : notification.type === 'ai-delegation'
                                ? 'AI 위임 상태 알림'
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
          '--sidebar-width': `${effectiveSidebarWidth}px`,
          '--inspector-width': `${inspectorWidth}px`,
        } as CSSProperties}
      >
        {(mobileSidebarOpen || mobileInspectorOpen) && (
          <button
            type="button"
            className="mobile-drawer-backdrop"
            onClick={() => {
              setMobileSidebarOpen(false)
              setMobileInspectorOpen(false)
            }}
            aria-label="모바일 패널 닫기"
          />
        )}
        <aside id="document-library-panel" className={`sidebar ${mobileSidebarOpen ? 'mobile-open' : ''}`}>
          <div className="sidebar-header">
            <span>{trashOpen ? '휴지통' : '마인드맵'} <small>{trashOpen ? trashedDocuments.length : documents.length}</small></span>
            <div className="sidebar-header-actions">
              {trashOpen ? (
                <button type="button" aria-label="휴지통 닫기" title="휴지통 닫기" onClick={() => setTrashOpen(false)}>
                  <Icon name="close" size={14} />
                </button>
              ) : mode === 'editor' && (
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
              <button
                type="button"
                className="mobile-drawer-close"
                onClick={() => setMobileSidebarOpen(false)}
                aria-label="문서 목록 닫기"
                title="문서 목록 닫기"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
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
              <nav
                ref={documentListRef}
                className="map-list"
                onDragOverCapture={(event) => {
                  if (mode !== 'editor' || !draggingLibraryItem || normalizedDocumentSearch) {
                    stopDocumentListAutoScroll()
                    return
                  }
                  updateDocumentListAutoScroll(event.clientY)
                }}
                onDragLeave={(event) => {
                  const nextTarget = event.relatedTarget as globalThis.Node | null
                  if (!nextTarget || !event.currentTarget.contains(nextTarget)) stopDocumentListAutoScroll()
                }}
                onDropCapture={stopDocumentListAutoScroll}
              >
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
          aria-valuemin={sidebarMinWidth}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={Math.round(effectiveSidebarWidth)}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            sidebarResizeStart.current = { pointerX: event.clientX, width: effectiveSidebarWidth }
            setResizingSidebar(true)
          }}
          onPointerMove={(event) => {
            if (!resizingSidebar) return
            const centerMinWidth = window.innerWidth <= 1200 ? 500 : 520
            const maxWidth = Math.min(
              SIDEBAR_MAX_WIDTH,
              Math.max(sidebarMinWidth, window.innerWidth - inspectorWidth - centerMinWidth),
            )
            const nextWidth = sidebarResizeStart.current.width + event.clientX - sidebarResizeStart.current.pointerX
            setSidebarWidth(Math.min(maxWidth, Math.max(sidebarMinWidth, nextWidth)))
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
            setSidebarWidth((current) =>
              Math.min(SIDEBAR_MAX_WIDTH, Math.max(sidebarMinWidth, current + delta)),
            )
          }}
        >
          <span />
        </div>

        {viewMode === 'mindmap' ? (
        <section
          ref={canvasWrapRef}
          className={`canvas-wrap ${rightPanning ? 'right-panning' : ''} ${touchPanning ? 'touch-panning' : ''} ${boxSelectionArmed ? 'box-select-armed' : ''} ${boxSelectionScreenRect ? 'box-selecting' : ''} ${knowledgeConnection ? `knowledge-connecting ${knowledgeConnection.policy === 'reuse-first' ? 'primary' : 'secondary'}` : ''}`}
          onPointerDownCapture={(event) => {
            // 우클릭 드래그로 맵을 이동한 뒤에는 캔버스 메뉴가 열리지 않도록 시작 좌표를 남긴다.
            if (event.button === 2) paneRightPressRef.current = { x: event.clientX, y: event.clientY }
            startBoxSelection(event)
            startCanvasRightPan(event)
          }}
          onContextMenuCapture={(event) => {
            if (!(event.target instanceof Element)) return
            const overEdge = event.target.closest('.react-flow__edge, .react-flow__edge-textwrapper')
            if (overEdge || rightPanGesture.current?.moved || Date.now() < suppressNodeContextMenuUntil.current) {
              event.preventDefault()
            }
          }}
          onClickCapture={(event) => {
            if (!(event.target instanceof Element)) return
            // 범위 선택 직후의 클릭이나 Ctrl 클릭으로 선택이 초기화되지 않게 막는다.
            const paneTarget = event.target.classList.contains('react-flow__pane')
            if (paneTarget && (suppressBoxSelectionClick.current || event.ctrlKey || event.metaKey)) {
              suppressBoxSelectionClick.current = false
              event.stopPropagation()
              return
            }
            if (Date.now() >= suppressTouchClickUntil.current) return
            if (!event.target.closest('.react-flow__node, .react-flow__edge, .react-flow__edge-textwrapper')) return
            event.preventDefault()
            event.stopPropagation()
          }}
          onDoubleClickCapture={(event) => {
            if (!(event.target instanceof Element)) return
            const nodeElement = event.target.closest<HTMLElement>('.react-flow__node[data-id]')
            if (!nodeElement) return
            const suppressTouchDoubleClick = Date.now() < suppressTouchClickUntil.current
            if (!suppressTouchDoubleClick
              && (knowledgeConnection
                || event.target.closest('button, a, input, textarea, select, [contenteditable="true"], .nodrag, .react-flow__handle, .react-flow__resize-control'))) return

            event.preventDefault()
            event.stopPropagation()
            if (suppressTouchDoubleClick) return

            const nodeId = nodeElement.dataset.id
            if (!nodeId || !nodesRef.current.some((node) => node.id === nodeId)) return
            setNodes((current) => synchronizeNodeSelection(current, nodeId))
            setSelectedId(nodeId)
            toggleNodeFocus(nodeId)
          }}
          onTouchStartCapture={(event) => {
            if (touchPointsWithin(event.currentTarget, event.touches).length >= 2) {
              cancelTouchPaneGesture()
              cancelTouchCardGesture(true)
              cancelTouchCanvasPan()
              startTouchPan(event)
              return
            }
            startTouchPaneGesture(event)
            startTouchCardGesture(event)
            startTouchCanvasPan(event)
          }}
          onTouchMoveCapture={(event) => {
            moveTouchPaneGesture(event)
            if (touchCanvasPanGesture.current?.active) moveTouchCanvasPan(event)
            else if (touchPanOwned.current) moveTouchPan(event)
            else if (touchCardGesture.current) moveTouchCardGesture(event)
            else moveTouchCanvasPan(event)
          }}
          onTouchEndCapture={(event) => {
            cancelTouchPaneGesture()
            if (touchCanvasPanGesture.current?.active) finishTouchCanvasPan(event)
            else if (touchPanOwned.current) finishTouchPan(event)
            else if (touchCardGesture.current) {
              finishTouchCardGesture(event)
              finishTouchCanvasPan(event)
            } else finishTouchCanvasPan(event)
          }}
          onTouchCancelCapture={(event) => {
            cancelTouchPaneGesture()
            if (touchCanvasPanGesture.current?.active) finishTouchCanvasPan(event)
            else if (touchPanOwned.current) finishTouchPan(event)
            else if (touchCardGesture.current) {
              finishTouchCardGesture(event)
              finishTouchCanvasPan(event)
            } else finishTouchCanvasPan(event)
          }}
          onPointerEnter={trackCanvasPointer}
          onPointerMove={trackCanvasPointer}
          onPointerLeave={() => { canvasPointerRef.current.inside = false }}
          onDragOver={(event) => {
            if (mode !== 'editor') return
            const hasImage = [...event.dataTransfer.files].some(isSupportedImageFile)
              || [...event.dataTransfer.items].some((item) => item.kind === 'file' && SUPPORTED_IMAGE_MIME_TYPES.has(item.type))
            if (!hasImage) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(event) => {
            if (mode !== 'editor') return
            const imageFiles = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/') || SUPPORTED_IMAGE_FILE_PATTERN.test(file.name))
            if (imageFiles.length === 0) return
            event.preventDefault()
            event.stopPropagation()
            const supportedFiles = imageFiles.filter(isSupportedImageFile)
            if (supportedFiles.length === 0) {
              setSaveError('PNG, JPEG, GIF 또는 WebP 이미지만 추가할 수 있습니다.')
              return
            }
            void addImageFilesAtPoint(supportedFiles, { x: event.clientX, y: event.clientY })
          }}
        >
          <ReactFlow<MindMapNode, MindMapEdge>
            key={activeMapId}
            nodes={loadedMapId === activeMapId ? flowNodes : []}
            edges={loadedMapId === activeMapId ? flowEdges : []}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={(changes) => {
              const applicableChanges = touchPanOwned.current
                ? changes.filter((change) => change.type !== 'position' && change.type !== 'select')
                : changes
              if (applicableChanges.length > 0) onNodesChange(applicableChanges)
            }}
            onEdgesChange={onEdgesChange}
            onBeforeDelete={async ({ nodes: deletingNodes }) => {
              const deletingRoot = deletingNodes.find((node) => node.data.kind === 'root')
              if (!deletingRoot) return true
              if (deletingNodes.length > 1) {
                setSaveError('최상위 카드는 다른 카드와 함께 삭제할 수 없습니다. 최상위 카드만 선택한 뒤 다시 시도해 주세요.')
                return false
              }
              deleteNodeById(deletingRoot.id)
              return false
            }}
            onConnect={onConnect}
            onInit={() => setMiniMapReadyMapId(activeMapId)}
            onNodeContextMenu={(event, node) => openNodeContextMenu(event, node.id)}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onNodeMouseEnter={onKnowledgeTargetEnter}
            onNodeMouseLeave={onKnowledgeTargetLeave}
            onSelectionChange={onSelectionChange}
            onMoveStart={(event) => { if (event) focusedNodeIdRef.current = null }}
            onPaneClick={(event) => {
              if (Date.now() < suppressTouchClickUntil.current) {
                event.preventDefault()
                return
              }
              cancelKnowledgeConnection()
              setSelectedId(null)
              setNodeContextMenu(null)
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault()
              if (mode !== 'editor') return
              const pressed = paneRightPressRef.current
              const clientX = 'clientX' in event ? event.clientX : pressed.x
              const clientY = 'clientY' in event ? event.clientY : pressed.y
              if (Math.abs(clientX - pressed.x) > 4 || Math.abs(clientY - pressed.y) > 4) return
              setNodeContextMenu(null)
              setDocumentContextMenu(null)
              setAiConversationContextMenu(null)
              setCanvasPasteMenu({ x: clientX, y: clientY })
            }}
            onDoubleClick={(event) => {
              if (mode === 'editor' && (event.target as HTMLElement).classList.contains('react-flow__pane')) {
                addNode(undefined, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
              }
            }}
            nodesDraggable={mode === 'editor' && !knowledgeConnection && !touchPanning}
            nodesConnectable={mode === 'editor' && !knowledgeConnection && !touchPanning}
            edgesReconnectable={mode === 'editor'}
            nodeClickDistance={4}
            nodeDragThreshold={4}
            panOnDrag={touchPanning ? false : boxSelectionArmed ? [1, 2] : [0, 1, 2]}
            zoomOnPinch={!touchPanning}
            deleteKeyCode={mode === 'editor' ? ['Backspace', 'Delete'] : null}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={MINDMAP_MIN_ZOOM}
            maxZoom={MINDMAP_MAX_ZOOM}
            defaultEdgeOptions={{ style: { strokeWidth: 2, stroke: 'var(--theme-edge)' } }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={MINDMAP_GRID_SIZE} size={1.2} color="var(--theme-grid)" />
            <Background
              id="grid-guide"
              className={`grid-guide ${gridGuideVisible ? 'visible' : ''}`}
              variant={BackgroundVariant.Lines}
              gap={MINDMAP_GRID_SIZE}
              lineWidth={1}
              color="var(--theme-grid-guide)"
            />
            <svg className={`grid-guide-lines ${gridGuideVisible && gridGuideAlignment ? 'visible' : ''}`} aria-hidden="true">
              {gridGuideAlignment && (
                <>
                  <line x1={gridGuideAlignment.x} y1="0" x2={gridGuideAlignment.x} y2="100%" />
                  <line x1="0" y1={gridGuideAlignment.y} x2="100%" y2={gridGuideAlignment.y} />
                </>
              )}
            </svg>
            {miniMapReadyMapId === activeMapId && (
              <MiniMap
                className="mini-map"
                style={{ width: 160, height: 100 }}
                pannable
                zoomable
                ariaLabel="미니맵 뷰 영역을 드래그하여 화면 이동"
                nodeColor={(node) => node.data.kind === 'image' ? 'var(--theme-node-image)' : (node.data as MindNodeData).progress >= 100 ? 'var(--theme-node-complete)' : node.data.kind === 'root' ? 'var(--theme-node-root)' : 'var(--theme-node-planned)'}
                maskColor="var(--theme-minimap-mask)"
                maskStrokeColor="var(--theme-minimap-stroke)"
                maskStrokeWidth={2}
              />
            )}
            <Controls position="bottom-center" showInteractive={false} />
            <Panel position="top-left" className="canvas-toolbar">
              {mode === 'editor' && (
                <>
                  <button className="primary-tool" onClick={() => addNode()}><Icon name="plus" size={16} />하위 노드 <kbd>Insert</kbd></button>
                  <span className="tool-divider" />
                </>
              )}
              <button onClick={() => showFullMindMap()} title="전체 보기 (Home)" aria-label="전체 보기 (Home)"><Icon name="fit" size={17} /></button>
              {collapsibleNodeIds.size > 0 && (
                <button
                  onClick={() => setCollapsedNodeIds(collapsedNodeIds.size > 0 ? new Set() : new Set(collapsibleNodeIds))}
                  title={collapsedNodeIds.size > 0 ? '모든 가지 펼치기' : '모든 가지 접기'}
                >
                  <Icon name={collapsedNodeIds.size > 0 ? 'expand' : 'collapse'} size={17} />
                </button>
              )}
              {mode === 'editor' && <button onClick={deleteSelected} disabled={!selectedId || selectedNode?.data.kind === 'image'} title={selectedNode?.data.kind === 'image' ? '이미지는 우클릭 메뉴에서 삭제할 수 있습니다.' : '선택 삭제'}><Icon name="trash" size={17} /></button>}
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
              {knowledgeConnection
                ? `${knowledgeConnection.policy === 'reuse-first' ? '주요' : '보조'} 지식으로 사용할 대상 카드를 클릭하세요 · Esc로 취소`
                : mode === 'editor' ? '이미지 드롭·Ctrl+V · Alt+드래그로 눈금 맞춤 · 우클릭 드래그로 이동 · Insert로 하위 노드 추가' : '우클릭 드래그로 이동 · 읽기 전용'}
            </Panel>
          </ReactFlow>
          {boxSelectionScreenRect && (
            <div
              className="box-selection-rect"
              aria-hidden="true"
              style={{
                left: boxSelectionScreenRect.left,
                top: boxSelectionScreenRect.top,
                width: boxSelectionScreenRect.width,
                height: boxSelectionScreenRect.height,
              }}
            />
          )}
          {knowledgeConnection && knowledgeConnectionSourceBox && (
            <KnowledgeConnectionPreview
              key={`${knowledgeConnection.sourceId}-${knowledgeConnection.policy}`}
              canvas={canvasWrapRef.current}
              source={knowledgeConnectionSourceBox}
              policy={knowledgeConnection.policy}
              issue={knowledgeConnectionMessage || hoveredKnowledgeConnectionIssue}
            />
          )}
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
            const maxWidth = Math.min(
              520,
              Math.max(240, window.innerWidth - effectiveSidebarWidth - centerMinWidth),
            )
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

        <aside id="node-inspector-panel" className={`inspector ${selectedNode ? 'open' : ''} ${mobileInspectorOpen ? 'mobile-open' : ''}`}>
          {selectedNode?.data.kind === 'image' && selectedNode.data.image ? (
            <>
              <div className="inspector-header">
                <div><span>선택한 항목</span><strong>이미지 정보</strong></div>
                <div className="inspector-header-actions">
                  <button
                    className="image-preview-open-button"
                    onClick={() => setPreviewImageNodeId(selectedNode.id)}
                    title="확대 보기"
                  >
                    <Icon name="search" size={15} /><span>확대 보기</span>
                  </button>
                  <button onClick={() => setSelectedId(null)} aria-label="닫기"><Icon name="close" size={17} /></button>
                </div>
              </div>
              <div className="inspector-content image-inspector-content">
                <div className="image-inspector-preview">
                  <img
                    src={imageAssetUrl(activeMapId, selectedNode.data.image.assetId)}
                    alt={selectedNode.data.image.fileName}
                    draggable={false}
                  />
                </div>
                <div className="image-inspector-name">
                  <span>파일 이름</span>
                  {mode === 'editor' ? (() => {
                    const image = selectedNode.data.image
                    const fileNameParts = splitImageFileName(image.fileName, image.mimeType)
                    const commitFileName = (input: HTMLInputElement) => {
                      const nextName = input.value.trim()
                      if (!nextName) {
                        input.value = fileNameParts.name
                        return
                      }
                      const nextFileName = `${nextName}${fileNameParts.extension}`
                      if (nextFileName === image.fileName) return
                      updateNode(selectedNode.id, {
                        label: nextFileName,
                        image: { ...image, fileName: nextFileName },
                      })
                    }
                    return (
                      <div className="image-inspector-name-editor">
                        <input
                          key={`${selectedNode.id}-${image.fileName}`}
                          type="text"
                          defaultValue={fileNameParts.name}
                          maxLength={Math.max(1, 240 - fileNameParts.extension.length)}
                          aria-label="이미지 파일 이름"
                          title="파일 확장자는 변경할 수 없습니다."
                          spellCheck={false}
                          onBlur={(event) => commitFileName(event.currentTarget)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              event.currentTarget.blur()
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              event.currentTarget.value = fileNameParts.name
                              event.currentTarget.blur()
                            }
                          }}
                        />
                        <span className="image-inspector-extension" title="파일 확장자는 변경할 수 없습니다.">{fileNameParts.extension}</span>
                      </div>
                    )
                  })() : <strong>{selectedNode.data.image.fileName}</strong>}
                </div>
                <label className="description-field image-description-field">
                  <span>설명</span>
                  {mode === 'editor' ? (
                    <>
                      <textarea
                        value={selectedNode.data.description ?? ''}
                        onChange={(event) => updateNode(selectedNode.id, { description: event.target.value })}
                        rows={4}
                        placeholder="이미지의 용도나 참고할 내용을 입력하세요"
                        aria-label="이미지 설명"
                      />
                      {extractTextLinks(selectedNode.data.description ?? '').length > 0 && (
                        <div className="description-links">
                          {extractTextLinks(selectedNode.data.description ?? '').map((link) => (
                            <a key={`${link.start}-${link.label}`} href={link.href} target="_blank" rel="noopener noreferrer" title={link.href}><Icon name="external" size={12} /><span><DoorayTaskLinkLabel href={link.href} fallback={link.label} /></span></a>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className={`description-rich-text ${selectedNode.data.description ? '' : 'empty-image-description'}`}>
                      {selectedNode.data.description
                        ? <LinkifiedText text={selectedNode.data.description} />
                        : '등록된 설명 없음'}
                    </div>
                  )}
                </label>
                <dl className="image-inspector-meta">
                  <div><dt>원본 크기</dt><dd>{selectedNode.data.image.naturalWidth} × {selectedNode.data.image.naturalHeight}</dd></div>
                  <div><dt>표시 크기</dt><dd>{Math.round(selectedNode.data.image.displayWidth)} × {Math.round(selectedNode.data.image.displayHeight)}</dd></div>
                  <div><dt>파일 형식</dt><dd>{selectedNode.data.image.mimeType.replace('image/', '').toUpperCase()}</dd></div>
                </dl>
                <div className="image-inspector-help">
                  <strong>이미지 편집</strong>
                  <span>마인드맵에서 이미지를 드래그해 이동하고, 선택 테두리의 조절점을 드래그해 원본 비율을 유지한 채 크기를 변경할 수 있습니다.</span>
                  <span>삭제는 이미지의 우클릭 메뉴를 사용하세요.</span>
                </div>
              </div>
            </>
          ) : selectedDoorayKnowledgeNode && selectedDoorayKnowledgeLink ? (
            <>
              <div className="inspector-header">
                <div><span>선택한 항목</span><strong>Dooray 지식</strong></div>
                <div className="inspector-header-actions">
                  <button onClick={() => setSelectedId(null)} aria-label="닫기"><Icon name="close" size={17} /></button>
                </div>
              </div>
              <div className="inspector-content dooray-knowledge-inspector-content">
                <div className="dooray-knowledge-origin">
                  <div className="dooray-knowledge-provider-row">
                    <span className="dooray-linked-icon" aria-hidden="true">D</span>
                    {selectedDoorayKnowledgeIsWiki && (
                      <span className="dooray-wiki-icon" title="Wiki" aria-label="Wiki">
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3.25 1.75h6.2l3.3 3.3v8.2a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
                          <path d="M9.25 1.9v3.35h3.35M4.75 8h5.5M4.75 10.5h5.5" />
                        </svg>
                      </span>
                    )}
                    <span>{selectedDoorayKnowledgeIsWiki ? 'Dooray Wiki' : 'Dooray 업무'}</span>
                    <small>{selectedDoorayKnowledgeLink.provider === 'dooray-wiki'
                      ? 'Wiki'
                      : selectedDoorayKnowledgeLink.workflowName
                        || (selectedDoorayKnowledgeLink.closed ? '완료' : '진행 중')}</small>
                  </div>
                  <strong title={selectedDoorayKnowledgeLink.title || selectedDoorayKnowledgeNode.data.label}>
                    {selectedDoorayKnowledgeLink.title || selectedDoorayKnowledgeNode.data.label}
                  </strong>
                  <label className="dooray-knowledge-url-field">
                    <span>{selectedDoorayKnowledgeIsWiki ? 'Dooray Wiki URL' : 'Dooray 업무 URL'}</span>
                    <input
                      type="url"
                      value={doorayUrlDraft}
                      readOnly={!selectedDoorayKnowledgeEditable}
                      className={doorayUrlUpdateState === 'error' ? 'invalid' : ''}
                      aria-label="Dooray 지식 원본 URL"
                      aria-invalid={doorayUrlUpdateState === 'error'}
                      onChange={(event) => {
                        if (!selectedDoorayKnowledgeEditable) return
                        const value = event.target.value
                        pendingDooraySourceUrls.current.delete(`${activeMapId}\u0000${selectedDoorayKnowledgeNode.id}`)
                        setDoorayUrlDraft(value)
                        setDoorayUrlUpdateState('idle')
                        setDoorayUrlUpdateError('')
                        if (doorayUrlCommitTimer.current !== null) window.clearTimeout(doorayUrlCommitTimer.current)
                        const normalizedUrl = normalizedDoorayKnowledgeUrl(value)
                        if (!normalizedUrl || normalizedUrl === selectedDoorayKnowledgeLink.url) return
                        doorayUrlCommitTimer.current = window.setTimeout(() => {
                          updateDoorayKnowledgeSource(activeMapId, selectedDoorayKnowledgeNode.id, value)
                        }, 300)
                      }}
                      onBlur={(event) => {
                        if (selectedDoorayKnowledgeEditable) updateDoorayKnowledgeSource(activeMapId, selectedDoorayKnowledgeNode.id, event.currentTarget.value)
                      }}
                      onKeyDown={(event) => {
                        if (!selectedDoorayKnowledgeEditable || event.nativeEvent.isComposing) return
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          updateDoorayKnowledgeSource(activeMapId, selectedDoorayKnowledgeNode.id, event.currentTarget.value)
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          if (doorayUrlCommitTimer.current !== null) window.clearTimeout(doorayUrlCommitTimer.current)
                          pendingDooraySourceUrls.current.delete(`${activeMapId}\u0000${selectedDoorayKnowledgeNode.id}`)
                          setDoorayUrlDraft(selectedDoorayKnowledgeLink.url)
                          setDoorayUrlUpdateState('idle')
                          setDoorayUrlUpdateError('')
                        }
                      }}
                    />
                    {doorayUrlUpdateState === 'updating' && <small className="updating">새 원본의 제목을 불러오는 중…</small>}
                    {doorayUrlUpdateState === 'error' && <small className="error" role="alert">{doorayUrlUpdateError}</small>}
                  </label>
                  <a
                    className="task-link"
                    href={selectedDoorayKnowledgeLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={selectedDoorayKnowledgeLink.url}
                  >
                    <Icon name="external" size={15} />
                    <span>{selectedDoorayKnowledgeLink.provider === 'dooray-wiki'
                      ? 'Dooray 원본 Wiki'
                      : selectedDoorayKnowledgeLink.taskNumber || 'Dooray 원본 업무'}</span>
                    <strong>원본 열기</strong>
                  </a>
                </div>
                <label className="description-field image-description-field">
                  <span>설명</span>
                  {selectedDoorayKnowledgeEditable ? (
                    <>
                      <textarea
                        value={selectedDoorayKnowledgeNode.data.description ?? ''}
                        onChange={(event) => updateNode(selectedDoorayKnowledgeNode.id, { description: event.target.value })}
                        rows={6}
                        placeholder={`이 ${selectedDoorayKnowledgeIsWiki ? 'Dooray Wiki' : 'Dooray 업무'}를 지식으로 활용할 때 참고할 내용을 입력하세요`}
                        aria-label="Dooray 지식 설명"
                      />
                      {extractTextLinks(selectedDoorayKnowledgeNode.data.description ?? '').length > 0 && (
                        <div className="description-links">
                          {extractTextLinks(selectedDoorayKnowledgeNode.data.description ?? '').map((link) => (
                            <a key={`${link.start}-${link.label}`} href={link.href} target="_blank" rel="noopener noreferrer" title={link.href}><Icon name="external" size={12} /><span><DoorayTaskLinkLabel href={link.href} fallback={link.label} /></span></a>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className={`description-rich-text ${selectedDoorayKnowledgeNode.data.description ? '' : 'empty-image-description'}`}>
                      {selectedDoorayKnowledgeNode.data.description
                        ? <LinkifiedText text={selectedDoorayKnowledgeNode.data.description} />
                        : '등록된 설명 없음'}
                    </div>
                  )}
                </label>
                <div className="image-inspector-help dooray-knowledge-help">
                  <strong>지식 카드</strong>
                  <span>설명에 AI가 이 {selectedDoorayKnowledgeIsWiki ? 'Wiki' : '업무'}를 지식으로 활용할 때 참고할 맥락을 기록하세요.</span>
                  <span>카드의 우클릭 메뉴에서 주요 지식 또는 보조 지식으로 연결할 수 있습니다.</span>
                </div>
              </div>
            </>
          ) : selectedNode ? (
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
                        if (mode === 'editor') openAiConversationForNode(selectedNode, selectedCommentNodeId ?? selectedNode.id, selectedCommentMapId)
                        else showAiEditorOnlyAlert()
                      }}
                      onContextMenu={mode === 'editor' ? openAiConversationContextMenu : undefined}
                      title={mode === 'editor' ? '좌클릭: 기존 대화 열기 · 우클릭: 새 대화 시작' : '편집자만 사용 가능'}
                    >
                      <Icon name="sparkles" size={15} /><span>AI 대화 열기</span>
                      {aiConversationLinksFromData(selectedNode.data).length > 1 && <b>{aiConversationLinksFromData(selectedNode.data).length}</b>}
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
                  <div className="task-link-field reference-source-field">
                    <div className="field-heading">
                      <span>참조 원본</span>
                      <small>{unresolvedReferenceNodeIds.has(selectedNode.id) ? '연결 끊김' : '실시간 동기화'}</small>
                    </div>
                    <a
                      className="task-link"
                      href={`/mindmap/${encodeURIComponent(selectedNode.data.reference.mapId)}/${encodeURIComponent(selectedNode.data.reference.nodeId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="원본 노드를 새 탭에서 열기"
                    >
                      <Icon name="external" size={15} />
                      <span>{documents.find((document) => document.id === selectedNode.data.reference?.mapId)?.title ?? selectedNode.data.reference.mapId}: {selectedNode.data.label.replace(/\s*\(ref\)\s*$/i, '')}</span>
                      <strong>원본 열기</strong>
                    </a>
                    <p className={unresolvedReferenceNodeIds.has(selectedNode.id) ? 'reference-sync-state unavailable' : 'reference-sync-state'}>
                      {unresolvedReferenceNodeIds.has(selectedNode.id)
                        ? '원본을 찾을 수 없어 마지막으로 저장된 내용을 표시합니다.'
                        : '내용과 업무 상태는 원본에서 관리되며 변경 사항이 자동으로 반영됩니다.'}
                    </p>
                  </div>
                )}
                <div className="task-link-field">
                  <div className="field-heading">
                    <span>업무 링크</span>
                    <small>{taskUrlProvider(selectedNode.data.taskUrl ?? '') === 'dooray-task'
                      ? 'Dooray 업무'
                      : taskUrlProvider(selectedNode.data.taskUrl ?? '') === 'dooray-wiki'
                        ? 'Dooray Wiki'
                        : taskUrlProvider(selectedNode.data.taskUrl ?? '') === 'web' ? '웹 링크' : '선택사항'}</small>
                  </div>
                  {mode === 'editor' && !selectedNode.data.reference && (
                    <input
                      type="url"
                      value={selectedNode.data.taskUrl ?? ''}
                      onChange={(event) => {
                        const taskUrl = event.target.value
                        const normalizedUrl = normalizedDoorayKnowledgeUrl(taskUrl)
                        const externalLink = selectedNode.data.externalLink?.url === normalizedUrl
                          ? selectedNode.data.externalLink
                          : undefined
                        updateNode(selectedNode.id, { taskUrl, externalLink })
                      }}
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
                      <span><DoorayTaskLinkLabel href={selectedNode.data.taskUrl ?? ''} fallback={selectedNode.data.taskUrl ?? ''} /></span>
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
                    readOnly={selectedReferenceReadOnly}
                  />
                </label>
                <label className="description-field">
                  <span>업무 설명</span>
                  {mode === 'editor' && !selectedNode.data.reference ? (
                    <>
                      <textarea
                        ref={descriptionTextareaRef}
                        value={selectedNode.data.description}
                        onChange={(event) => updateNode(selectedNode.id, { description: event.target.value })}
                        rows={3}
                        style={inspectorTextareaHeights.description === undefined
                          ? undefined
                          : { height: inspectorTextareaHeights.description }}
                      />
                      {extractTextLinks(selectedNode.data.description).length > 0 && (
                        <div className="description-links">
                          {extractTextLinks(selectedNode.data.description).map((link) => (
                            <a key={`${link.start}-${link.label}`} href={link.href} target="_blank" rel="noopener noreferrer" title={link.href}><Icon name="external" size={12} /><span><DoorayTaskLinkLabel href={link.href} fallback={link.label} /></span></a>
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
                  {mode === 'editor' && !selectedNode.data.reference ? (
                    <>
                      <textarea
                        ref={sharedKnowledgeTextareaRef}
                        value={selectedNode.data.sharedKnowledge ?? ''}
                        onChange={(event) => updateSharedKnowledge(selectedNode.id, event.target.value)}
                        rows={4}
                        maxLength={10_000}
                        placeholder="예: 적용하기로 한 정책, 재사용할 조사 결과, 구현 제약과 사용 방법"
                        aria-label="공유 지식"
                        style={inspectorTextareaHeights.sharedKnowledge === undefined
                          ? undefined
                          : { height: inspectorTextareaHeights.sharedKnowledge }}
                      />
                      {extractTextLinks(selectedNode.data.sharedKnowledge ?? '').length > 0 && (
                        <div className="description-links">
                          {extractTextLinks(selectedNode.data.sharedKnowledge ?? '').map((link) => (
                            <a key={`${link.start}-${link.label}`} href={link.href} target="_blank" rel="noopener noreferrer" title={link.href}><Icon name="external" size={12} /><span><DoorayTaskLinkLabel href={link.href} fallback={link.label} /></span></a>
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
                    value={selectedProgress >= 100 ? 'done' : selectedStatus}
                    onChange={(event) => {
                      const status = event.target.value as MindNodeData['status']
                      updateNode(selectedNode.id, {
                        status,
                        progress: status === 'done'
                          ? 100
                          : selectedProgress >= 100 ? 95 : selectedProgress,
                      })
                    }}
                    disabled={selectedReferenceReadOnly || Boolean(selectedProgressRollup)}
                  >
                    <option value="planned">예정</option>
                    <option value="in-progress">진행 중</option>
                    <option value="done">완료</option>
                  </select>
                </label>
                {(selectedNode.data.isWork || selectedProgressRollup) && (
                  <label className={`progress-field ${selectedProgressRollup ? 'automatic' : ''}`}>
                    <span>
                      {selectedProgressRollup ? '자동 진행률' : '진행률'}
                      <strong>{selectedProgress >= 100 ? '완료' : selectedProgressRollup ? `${selectedNode.data.kind === 'root' ? '전체' : '요약'} ${selectedProgress}%` : `${selectedProgress}%`}</strong>
                    </span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={selectedProgress}
                      onChange={(event) => {
                        const progress = Number(event.target.value)
                        updateNode(selectedNode.id, {
                          progress,
                          status: progress >= 100
                            ? 'done'
                            : selectedStatus === 'done' ? 'in-progress' : selectedStatus,
                        })
                      }}
                      disabled={selectedReferenceReadOnly || Boolean(selectedProgressRollup)}
                    />
                    {selectedProgressRollup && (
                      <small className="progress-rollup-help">하위 업무 {selectedProgressRollup.targetCount}개 평균 · 자동 계산</small>
                    )}
                  </label>
                )}
                <section className={`work-section ${selectedNode.data.isWork ? 'enabled' : ''}`}>
                  <div className="work-section-heading">
                    <div>
                      <span>업무 관리</span>
                      <small>{selectedNode.data.isWork
                        ? '담당자와 실행 항목을 관리합니다.'
                        : selectedHasWaitingItems
                          ? '업무 관리와 별개로 등록된 대기 항목을 확인합니다.'
                          : '이 노드를 실행 가능한 업무로 전환합니다.'}</small>
                    </div>
                    <button
                      type="button"
                      className={`work-switch ${selectedNode.data.isWork ? 'on' : ''}`}
                      onClick={() => updateNode(selectedNode.id, { isWork: !selectedNode.data.isWork })}
                      disabled={selectedReferenceReadOnly}
                      aria-label={selectedNode.data.isWork ? '업무 관리 해제' : '업무로 전환'}
                      aria-pressed={Boolean(selectedNode.data.isWork)}
                    >
                      <span />
                    </button>
                  </div>

                  {(selectedNode.data.isWork || selectedHasWaitingItems) && (
                    <div className={`work-fields ${selectedNode.data.isWork ? '' : 'waiting-only'}`}>
                      {selectedNode.data.isWork && <>
                      <label>
                        <span>담당자</span>
                        <select
                          value={selectedNode.data.assigneeId ?? ''}
                          onChange={(event) => updateNode(selectedNode.id, { assigneeId: event.target.value || undefined })}
                          disabled={selectedReferenceReadOnly}
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
                          readOnly={selectedReferenceReadOnly}
                        />
                      </label>

                      <div className="dependency-block" ref={dependencyBlockRef}>
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
                      </>}

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
                                  onFocus={() => setContentTooltip(null)}
                                  onMouseEnter={(event) => {
                                    const text = waitingLabelDrafts[item.id] ?? item.label
                                    if (text.trim()) setContentTooltip({ text, x: event.clientX, y: event.clientY })
                                  }}
                                  onMouseMove={(event) => {
                                    setContentTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null)
                                  }}
                                  onMouseLeave={() => setContentTooltip(null)}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                      event.preventDefault()
                                      event.currentTarget.blur()
                                    }
                                  }}
                                  placeholder="무엇을 기다리고 있나요?"
                                  maxLength={120}
                                  readOnly={selectedReferenceReadOnly}
                                  aria-label="대기 항목 이름"
                                />
                                {mode === 'editor' && !selectedNode.data.reference && (
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
                                onFocus={() => setContentTooltip(null)}
                                onMouseEnter={(event) => {
                                  if (item.note?.trim()) setContentTooltip({ text: item.note, x: event.clientX, y: event.clientY })
                                }}
                                onMouseMove={(event) => {
                                  setContentTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null)
                                }}
                                onMouseLeave={() => setContentTooltip(null)}
                                placeholder="메모 (선택)"
                                maxLength={1000}
                                readOnly={selectedReferenceReadOnly}
                                aria-label={`${item.label} 대기 메모`}
                              />
                              <input
                                value={item.resumeCondition ?? ''}
                                onChange={(event) => updateWaitingItems((selectedNode.data.waitingItems ?? []).map((current) => (
                                  current.id === item.id ? { ...current, resumeCondition: event.target.value || undefined } : current
                                )))}
                                onFocus={() => setContentTooltip(null)}
                                onMouseEnter={(event) => {
                                  if (item.resumeCondition?.trim()) setContentTooltip({ text: item.resumeCondition, x: event.clientX, y: event.clientY })
                                }}
                                onMouseMove={(event) => {
                                  setContentTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null)
                                }}
                                onMouseLeave={() => setContentTooltip(null)}
                                placeholder="재개 조건 (선택)"
                                maxLength={500}
                                readOnly={selectedReferenceReadOnly}
                                aria-label={`${item.label} 재개 조건`}
                              />
                              <small>{new Date(item.since).toLocaleString('ko-KR')}부터 대기</small>
                            </div>
                          ))}
                          {(selectedNode.data.waitingItems ?? []).length === 0 && <div className="empty-waiting">현재 대기 중인 항목이 없습니다.</div>}
                        </div>
                        {mode === 'editor' && !selectedNode.data.reference && (
                          <form className="waiting-add" onSubmit={(event) => { event.preventDefault(); addWaitingItem() }}>
                            <input
                              value={newWaitingLabel}
                              onChange={(event) => setNewWaitingLabel(event.target.value)}
                              placeholder="예: 서버 API 완료, 캐릭터 아트 전달"
                              maxLength={120}
                              disabled={selectedProgress >= 100}
                            />
                            <button type="submit" disabled={!newWaitingLabel.trim() || selectedProgress >= 100}><Icon name="plus" size={13} /></button>
                          </form>
                        )}
                        <small className="waiting-help">대기 항목은 상태와 진행률을 바꾸지 않으며, 업무를 완료하면 자동으로 정리됩니다. 문서 내부 선행 업무는 위의 업무 의존성을 사용하세요.</small>
                      </div>

                      {selectedNode.data.isWork && <div className="checklist-block">
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
                                disabled={selectedReferenceReadOnly}
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
                                      setContentTooltip({ text: item.text, x: event.clientX, y: event.clientY })
                                    }
                                  }}
                                  onMouseMove={(event) => {
                                    setContentTooltip((current) => current ? { ...current, x: event.clientX, y: event.clientY } : null)
                                  }}
                                  onMouseLeave={() => setContentTooltip(null)}
                                  onDoubleClick={() => {
                                  if (mode === 'editor' && !selectedNode.data.reference) {
                                    setContentTooltip(null)
                                    skipChecklistCommit.current = false
                                    setEditingChecklist({ id: item.id, text: item.text })
                                  }
                                  }}
                                >{item.text}</span>
                              )}
                              {mode === 'editor' && !selectedNode.data.reference && (
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
                        {mode === 'editor' && !selectedNode.data.reference && (
                          <form className="checklist-add" onSubmit={(event) => { event.preventDefault(); addChecklistItem() }}>
                            <input value={newChecklistText} onChange={(event) => setNewChecklistText(event.target.value)} placeholder="실행 항목 추가" maxLength={120} />
                            <button type="submit" disabled={!newChecklistText.trim()}><Icon name="plus" size={13} /></button>
                          </form>
                        )}
                        <small className="checklist-help">완료 비율이 노드 진행률에 자동 반영됩니다.</small>
                      </div>}
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
                      const replyingHere = Boolean(replyTarget) && (replyTarget?.parentId ?? replyTarget?.id) === comment.id
                      return (
                        <div className={`comment-thread ${comment.resolvedAt ? 'resolved' : ''}`} key={comment.id}>
                          <CommentCard comment={comment} mode={mode} user={user} collaborators={collaborators} readOnly={Boolean(user.publicAccess)} onReply={setReplyTarget} onDelete={(target) => { void deleteComment(target) }} onResolve={(target) => { void toggleCommentResolved(target) }} onReaction={(target, emoji) => { void toggleCommentReaction(target, emoji) }} />
                          {replies.length > 0 && (
                            <div className="comment-replies">
                              {replies.map((reply) => <CommentCard key={reply.id} comment={reply} isReply mode={mode} user={user} collaborators={collaborators} readOnly={Boolean(user.publicAccess)} onReply={setReplyTarget} onDelete={(target) => { void deleteComment(target) }} onResolve={(target) => { void toggleCommentResolved(target) }} onReaction={(target, emoji) => { void toggleCommentReaction(target, emoji) }} />)}
                            </div>
                          )}
                          {replyingHere && !user.publicAccess && renderReplyForm()}
                        </div>
                      )
                    })}
                    {!commentsLoading && comments.length === 0 && <div className="comment-message">{user.publicAccess ? '등록된 댓글이 없습니다.' : '첫 댓글을 남겨보세요.'}</div>}
                  </div>
                  {commentError && <div className="comment-error">{commentError}</div>}
                  {user.publicAccess ? <div className="public-viewer-comment-note"><Icon name="lock" size={12} /><span>공개 뷰어에서는 댓글을 조회만 할 수 있습니다.</span></div> : <form className="comment-form" onSubmit={(event) => { event.preventDefault(); void submitComment() }}>
                    <label className="comment-summary-editor">
                      <span>요약</span>
                      <textarea value={newComment} onChange={(event) => setNewComment(event.target.value)} placeholder="현재 상태와 핵심 결과를 입력하세요" maxLength={240} rows={2} />
                      <small>{newComment.length}/240</small>
                    </label>
                    <button
                      type="button"
                      className={`comment-detail-toggle ${commentDetailOpen ? 'open' : ''}`}
                      onClick={() => setCommentDetailOpen((current) => !current)}
                      aria-expanded={commentDetailOpen}
                    >
                      <span>{commentDetailOpen ? '상세 내용 접기' : newCommentDetail ? '작성한 상세 내용 보기' : '상세 내용 추가'}</span>
                      <Icon name="chevron-down" size={12} />
                    </button>
                    {commentDetailOpen && (
                      <label className="comment-detail-editor">
                        <span>상세</span>
                        <textarea value={newCommentDetail} onChange={(event) => setNewCommentDetail(event.target.value)} placeholder="수행 내용, 중요한 판단, 변경 범위, 검증 결과, 산출물과 다음 단계를 입력하세요." maxLength={6000} rows={7} />
                        <small>{newCommentDetail.length}/6000</small>
                      </label>
                    )}
                    <div className="mention-tools">
                      <span>멘션</span>
                      {collaborators.filter((collaborator) => collaborator.id !== user.id).map((collaborator) => <button type="button" key={collaborator.id} onClick={() => insertMention(collaborator)}>@{collaborator.name}</button>)}
                    </div>
                    <div><small>{selectedNode.data.reference ? '원본 노드에 등록' : '편집자와 뷰어 모두 작성 가능'}</small><button type="submit" disabled={!newComment.trim()}><Icon name="send" size={13} />등록</button></div>
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
                  <div className="history-item-actions">
                    <button disabled={historyLoading || dailyBackupPreviewLoadingDate !== null} onClick={() => { void previewDailyBackup(backup) }}>
                      {dailyBackupPreviewLoadingDate === backup.date ? '여는 중…' : '가상으로 열기'}
                    </button>
                    {mode === 'editor' && <button disabled={historyLoading || dailyBackupPreviewLoadingDate !== null} onClick={() => { void restoreDailyBackup(backup) }}>복원</button>}
                  </div>
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
      {sharedKnowledgeReviewOpen && mode === 'editor' && (
        <SharedKnowledgeReviewDialog
          activeMapId={activeMapId || null}
          clientId={CLIENT_ID}
          aiRequestOpen={Boolean(aiConversationLaunch)}
          onRequestAiCleanup={setAiConversationLaunch}
          onApplied={handleSharedKnowledgeReviewApplied}
          onClose={() => setSharedKnowledgeReviewOpen(false)}
        />
      )}
      {dailyBackupPreview && (
        <DailyBackupPreviewDialog
          preview={dailyBackupPreview}
          teamMembers={teamMembers}
          commentStats={commentStats}
          referenceCommentStats={referenceCommentStats}
          onClose={() => setDailyBackupPreview(null)}
        />
      )}
      {aiConversationTarget && (
        <AiConversationDialog
          key={`${aiConversationTarget.mapId}:${aiConversationTarget.cardId}:${aiConversationTarget.purpose}`}
          userId={user.id}
          documentId={aiConversationTarget.mapId}
          documentTitle={aiConversationTarget.documentTitle}
          cardId={aiConversationTarget.cardId}
          cardTitle={aiConversationTarget.cardTitle}
          purpose={aiConversationTarget.purpose}
          knowledgeSources={aiConversationTarget.knowledgeSources}
          initialRequest={aiConversationTarget.initialRequest}
          launchInWebUi={aionUiWebNavigation.configured || !isLoopbackHostname(window.location.hostname)}
          onClose={closeAiConversationDialog}
        />
      )}
      {aiConversationPicker && (
        <AiConversationPickerDialog
          key={`${aiConversationPicker.mapId}:${aiConversationPicker.cardId}`}
          mapId={aiConversationPicker.mapId}
          cardId={aiConversationPicker.cardId}
          cardTitle={aiConversationPicker.cardTitle}
          onSelect={(conversationId) => {
            const target = aiConversationPicker
            setAiConversationPicker(null)
            void openAiConversation(conversationId, target.cardId, target.mapId)
          }}
          onStartNew={() => {
            setAiConversationPicker(null)
            setAiDialogOpen(true)
          }}
          onDeleteUnavailable={(conversationId) => deleteUnavailableAiConversation(
            aiConversationPicker.mapId,
            aiConversationPicker.cardId,
            conversationId,
          )}
          onClose={() => setAiConversationPicker(null)}
        />
      )}
      {previewImageNode?.data.image && (
        <ImagePreviewDialog
          key={previewImageNode.data.image.assetId}
          src={imageAssetUrl(activeMapId, previewImageNode.data.image.assetId)}
          fileName={previewImageNode.data.image.fileName}
          naturalWidth={previewImageNode.data.image.naturalWidth}
          naturalHeight={previewImageNode.data.image.naturalHeight}
          onClose={() => setPreviewImageNodeId(null)}
        />
      )}
      {contentTooltip && (
        <div
          className="content-tooltip"
          style={{
            left: Math.max(8, Math.min(contentTooltip.x + 12, window.innerWidth - 340)),
            top: Math.max(8, Math.min(contentTooltip.y + 14, window.innerHeight - 90)),
          }}
          role="tooltip"
        >
          {contentTooltip.text}
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
            <span>{contextMenuNode?.data.kind === 'image' ? '이미지 메뉴' : '노드 메뉴'}</span>
            <strong>{contextMenuNode?.data.label}</strong>
          </div>
          {viewMode === 'mindmap' && (
            <>
              <button className="knowledge-connect primary" role="menuitem" onClick={() => startKnowledgeConnectionFromMenu('reuse-first')}>
                <span className="context-icon"><Icon name="share" size={15} /></span>
                <span><strong>주요 지식 연결</strong><small>이 카드를 먼저 활용할 대상 카드 선택</small></span>
              </button>
              <button className="knowledge-connect secondary" role="menuitem" onClick={() => startKnowledgeConnectionFromMenu('inspect-if-insufficient')}>
                <span className="context-icon"><Icon name="share" size={15} /></span>
                <span><strong>보조 지식 연결</strong><small>정보가 부족할 때 확인할 대상 선택</small></span>
              </button>
              <div className="context-divider" />
            </>
          )}
          {contextMenuNode?.data.kind === 'image' ? (
            <>
              <button role="menuitem" onClick={() => { void copyImageNodes(nodeContextMenu.nodeId) }}>
                <span className="context-icon"><Icon name="copy" size={15} /></span>
                <span><strong>이미지 복사{contextMenuImageCount > 1 ? ` (${contextMenuImageCount}개)` : ''}</strong><small>다른 문서에서도 현재 크기와 배치 유지</small></span>
              </button>
              <div className="context-divider" />
              <button className="danger" role="menuitem" onClick={() => deleteImageNodesById(nodeContextMenu.nodeId)}>
                <span className="context-icon"><Icon name="trash" size={15} /></span>
                <span><strong>이미지 삭제{contextMenuImageCount > 1 ? ` (${contextMenuImageCount}개)` : ''}</strong><small>선택한 이미지를 마인드맵에서 제거</small></span>
              </button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
      {canvasPasteMenu && mode === 'editor' && viewMode === 'mindmap'
        && (copiedImages || (copiedNodes && copiedNodes.nodes.length > 0 && copiedNodes.sourceMapId !== activeMapId)) && (
        <div
          className="node-context-menu"
          style={{
            left: Math.max(8, Math.min(canvasPasteMenu.x, window.innerWidth - 230)),
            top: Math.max(8, Math.min(canvasPasteMenu.y, window.innerHeight - 120)),
          }}
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
        >
          <div className="context-menu-title">
            <span>캔버스 메뉴</span>
            <strong>{copiedImages
              ? copiedImages.images.length === 1
                ? copiedImages.images[0].image.fileName
                : `복사한 이미지 ${copiedImages.images.length}개`
              : copiedNodes!.nodes.length === 1
                ? copiedNodes!.nodes[0].data.label.replace(/\s*\(ref\)\s*$/i, '')
                : `복사한 카드 ${copiedNodes!.nodes.length}개`}</strong>
          </div>
          {copiedImages ? (
            <button role="menuitem" onClick={() => pasteCopiedImagesAtPoint({ x: canvasPasteMenu.x, y: canvasPasteMenu.y })}>
              <span className="context-icon"><Icon name="paste" size={15} /></span>
              <span>
                <strong>이미지{copiedImages.images.length > 1 ? ` ${copiedImages.images.length}개` : ''} 붙여넣기</strong>
                <small>{copiedImages.images.length === 1
                  ? `${Math.round(copiedImages.images[0].image.displayWidth)} × ${Math.round(copiedImages.images[0].image.displayHeight)} 크기 유지`
                  : '각 이미지 크기와 상대 배치 유지'}</small>
              </span>
            </button>
          ) : (
            <button
              role="menuitem"
              onClick={() => {
                pasteNodeAsChild(null, 'reference', { x: canvasPasteMenu.x, y: canvasPasteMenu.y })
                setCanvasPasteMenu(null)
              }}
            >
              <span className="context-icon"><Icon name="share" size={15} /></span>
              <span><strong>Ref 지식 카드로 붙여넣기</strong><small>계층선 없이 이 위치에 배치 · 진행률 집계 제외</small></span>
            </button>
          )}
        </div>
      )}
      {aiConversationContextMenu && selectedNode && selectedNode.data.kind !== 'image' && mode === 'editor' && (
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
  const [theme, setTheme] = useState<UiTheme>(() => appliedUiTheme())

  const toggleTheme = useCallback(() => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark'
    applyUiTheme(nextTheme, true)
    setTheme(nextTheme)
  }, [theme])

  useEffect(() => {
    const synchronizeTheme = (event: StorageEvent) => {
      if (event.key !== UI_THEME_STORAGE_KEY) return
      const nextTheme = storedUiTheme(event.newValue)
      if (!nextTheme) return
      applyUiTheme(nextTheme)
      setTheme(nextTheme)
    }
    window.addEventListener('storage', synchronizeTheme)
    return () => window.removeEventListener('storage', synchronizeTheme)
  }, [])

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

  if (!user) return <LoginScreen onAuthenticated={setUser} theme={theme} onToggleTheme={toggleTheme} />

  return (
    <ReactFlowProvider>
      <Workspace user={user} onLogout={() => { void logout() }} initialDeepLink={deepLink} theme={theme} onToggleTheme={toggleTheme} />
    </ReactFlowProvider>
  )
}

export default App
