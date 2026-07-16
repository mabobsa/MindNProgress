import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDirectory = path.resolve(String(process.env.MNP_DATA_DIR ?? '').trim() || path.join(projectDirectory, 'server', 'data'))
const tokenFile = path.resolve(String(process.env.MNP_TOKEN_FILE ?? '').trim() || path.join(dataDirectory, '_integration-token'))
const apiBaseUrl = String(process.env.MNP_API_URL ?? 'http://127.0.0.1:4176').replace(/\/+$/, '')
let activeAttributionToken = ''
let activeEditorId = ''
let activeMapId = ''
let activeCardId = ''
const serverInstructions = `MindNProgress는 마인드맵과 업무 진행 관리를 결합한 웹 서비스입니다. MindNProgress 밖에서 시작해 문서 ID나 카드 ID가 없다면 mindnprogress_read_me_first를 먼저 호출하세요. 선택 문서와 카드가 있다면 mindnprogress_get_context로 제품 규칙과 최신 문서 구조를 먼저 확인하세요. get_context의 selection.taskLinks.startupInspection.required가 true이면 실제 작업 전에 targets의 업무 본문, 댓글, 첨부파일 목록과 관련 링크를 조사하세요. 특정 자료가 있다고 가정하지 마세요. 여러 카드로 구성된 새 문서는 mindnprogress_create_mindmap으로 한 번에 생성하고, 변경 후에는 최신 문서를 다시 조회해 결과를 검증하세요. 비밀번호 변경과 계정 관리 작업은 지원하지 않습니다.`
const productGuide = {
  version: '1.0',
  product: {
    name: 'MindNProgress',
    purpose: '아이디어를 계층형 마인드맵으로 구조화하고 실행 업무의 진행 상황을 같은 문서에서 관리하는 웹 서비스',
    roles: {
      editor: '문서, 카드, 업무, 관계, 체크리스트와 댓글을 생성·변경할 수 있음',
      viewer: '내용과 링크를 열람할 수 있지만 문서를 변경할 수 없음',
    },
  },
  dataModel: {
    document: '하나의 마인드맵. 제목, 아이콘 색상, 버전, 카드(nodes), 계층 연결선(edges)을 가짐',
    hierarchy: 'edge.source가 상위 카드이고 edge.target이 하위 카드임. 루트 카드는 문서당 하나를 권장',
    cardKinds: {
      root: '문서의 최상위 주제',
      branch: '주제나 영역을 묶는 중간 분류',
      task: '구체적인 실행 항목. 실제 업무라면 isWork=true로 설정',
    },
    workFields: {
      progress: '0~100의 진행률. 100이면 완료로 표시',
      status: 'planned, in-progress, done. done은 progress=100과 함께 사용',
      assigneeId: '담당자 사용자 ID. 담당자가 없으면 생략',
      dueDate: '마감일. 없는 업무는 생략',
      taskUrl: '관련 업무 링크. 링크가 없는 경우 생략',
      taskUrlContext: 'AI 대화 문맥에서는 선택 카드와 해당 계층의 최상위 카드 링크를 별도로 제공하며, 하위 카드에 링크를 상속하거나 덮어쓰지 않음',
      checklist: '세부 실행 항목. 체크 상태에 따라 진행률을 계산할 수 있음',
      blockedBy: '현재 업무보다 먼저 완료되어야 하는 카드 ID 목록. 계층 관계를 표현하는 용도로 사용하지 않음',
    },
  },
  views: {
    mindmap: '모든 카드의 계층과 연결 관계를 공간적으로 표시',
    kanban: 'isWork=true인 업무 카드를 상태별로 표시',
    timeline: 'isWork=true인 업무 중 일정 정보를 기준으로 표시',
    dashboard: '업무 진행률, 완료 상태와 병목을 요약',
  },
  authoringRules: [
    '루트는 전체 목적이나 프로젝트 이름으로 작성',
    '루트 아래에는 보통 3~7개의 핵심 영역을 branch로 구성',
    '실행 가능한 단위는 task로 만들고 실제 추적 대상이면 isWork=true로 지정',
    '계층 깊이는 보통 2~4단계로 유지하고 중복되는 카드는 합침',
    '제목은 짧고 명확하게, 설명에는 목적·범위·완료 조건을 기록',
    '존재하지 않는 담당자, 불필요한 업무 링크와 임의의 선행 관계를 만들지 않음',
    '진행률이 100이면 status=done, 완료가 아니면 progress를 100 미만으로 유지',
  ],
  operationRules: [
    '분석과 편집 전에 mindnprogress_get_context로 최신 버전과 제품 규칙을 확인',
    'get_context의 startupInspection이 요구되면 실제 작업 전에 선택 카드와 최상위 카드의 업무 링크를 조사하되 특정 첨부나 자료가 있다고 가정하지 않음',
    '여러 카드로 새 문서를 만들 때 mindnprogress_create_mindmap을 한 번만 호출',
    'create_document 후 save_document를 연속 호출해 전체 구조를 만들지 않음',
    '기존 문서 변경은 최신 version을 기준으로 수행하고 버전 충돌 시 최신 상태를 다시 조회',
    '변경 후 mindnprogress_get_document로 저장 결과를 검증하고 실제 변경 내용을 요약',
    '문서나 카드 접근 링크를 기록할 때 localhost나 127.0.0.1 주소를 만들지 말고 MCP 응답의 accessUrl을 사용',
    '삭제는 문서를 휴지통으로 이동하는 방식으로 처리',
    '비밀번호 변경이나 관리자 계정 관리는 MCP 범위에 포함하지 않음',
  ],
}

async function integrationToken() {
  const token = (await readFile(tokenFile, 'utf8')).trim()
  if (token.length < 32) throw new Error('MindNProgress 연동 토큰이 준비되지 않았습니다. API 서버를 다시 시작해 주세요.')
  return token
}

async function apiRequest(pathname, init = {}) {
  const token = await integrationToken()
  const { aiMapId, aiCardId, ...requestInit } = init
  const pathnameMapId = pathname.match(/^\/api\/maps\/([^/?]+)/)?.[1]
  const scopedMapId = String(aiMapId ?? (pathnameMapId ? decodeURIComponent(pathnameMapId) : '')).trim()
  const scopedCardId = String(aiCardId ?? (scopedMapId && scopedMapId === activeMapId ? activeCardId : '')).trim()
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...requestInit,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(activeAttributionToken ? { 'X-MNP-AI-Attribution': activeAttributionToken } : {}),
      ...(activeEditorId ? { 'X-MNP-AI-Editor-Id': activeEditorId } : {}),
      ...(scopedMapId ? { 'X-MNP-AI-Map-Id': scopedMapId } : {}),
      ...(scopedCardId ? { 'X-MNP-AI-Card-Id': scopedCardId } : {}),
      ...(requestInit.body ? { 'Content-Type': 'application/json' } : {}),
      ...requestInit.headers,
    },
    signal: AbortSignal.timeout(10_000),
  })
  const responseText = await response.text()
  let body = null
  if (responseText) {
    try {
      body = JSON.parse(responseText)
    } catch {
      if (!response.ok) throw new Error(`MindNProgress 요청 실패 (${response.status})`)
      return { ok: true, status: response.status }
    }
  }
  if (!response.ok) throw new Error(body?.error ?? `MindNProgress 요청 실패 (${response.status})`)
  return body ?? { ok: true, status: response.status }
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function documentAccessUrl(publicBaseUrl, mapId) {
  return `${String(publicBaseUrl).replace(/\/+$/, '')}/mindmap/${encodeURIComponent(mapId)}`
}

function cardAccessUrl(publicBaseUrl, mapId, cardId) {
  return `${documentAccessUrl(publicBaseUrl, mapId)}/${encodeURIComponent(cardId)}`
}

function registerTool(server, name, description, schema, handler) {
  server.tool(name, description, schema, async (input) => {
    try {
      return toolResult(await handler(input))
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : '요청을 처리하지 못했습니다.' }],
        isError: true,
      }
    }
  })
}

async function getDocument(mapId) {
  return (await apiRequest(`/api/maps/${encodeURIComponent(mapId)}`)).map
}

async function saveDocument(map, force = false, aiCardId = '') {
  return apiRequest(`/api/maps/${encodeURIComponent(map.id)}`, {
    method: 'PUT',
    aiCardId,
    body: JSON.stringify({
      map: { nodes: map.nodes, edges: map.edges },
      baseVersion: map.version,
      force,
    }),
  })
}

function descendantsOf(nodeId, edges) {
  const result = new Set()
  const stack = edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target)
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || result.has(current)) continue
    result.add(current)
    edges.filter((edge) => edge.source === current).forEach((edge) => stack.push(edge.target))
  }
  return result
}

function relatedCards(ids, nodes) {
  const idSet = new Set(ids)
  return nodes.filter((node) => idSet.has(node.id)).map((node) => ({
    id: node.id,
    label: node.data?.label ?? node.id,
    kind: node.data?.kind,
    status: node.data?.progress >= 100 ? 'done' : node.data?.status,
    progress: node.data?.progress ?? 0,
    isWork: Boolean(node.data?.isWork),
  }))
}

const mapIdSchema = { mapId: z.string().min(1).describe('문서 ID') }
const documentColor = z.enum(['violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'amber', 'orange', 'red', 'pink'])
const outlineKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/, '카드 key는 영문, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.')
const nodeDataSchema = z.object({
  label: z.string().min(1),
  description: z.string().default(''),
  progress: z.number().min(0).max(100).default(0),
  status: z.enum(['planned', 'in-progress', 'done']).default('planned'),
  kind: z.enum(['root', 'branch', 'task']).default('branch'),
  taskUrl: z.string().optional(),
  isWork: z.boolean().optional(),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional(),
  checklist: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean() })).optional(),
  blockedBy: z.array(z.string()).optional(),
}).passthrough()

const outlineCardSchema = z.object({
  key: outlineKey.describe('문서 안에서 고유한 카드 key'),
  parentKey: outlineKey.optional().describe('상위 카드 key. 루트 카드는 생략'),
  label: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  progress: z.number().min(0).max(100).default(0),
  status: z.enum(['planned', 'in-progress', 'done']).optional(),
  kind: z.enum(['root', 'branch', 'task']).optional(),
  taskUrl: z.string().optional(),
  isWork: z.boolean().optional(),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional(),
  checklist: z.array(z.object({
    text: z.string().min(1).max(500),
    done: z.boolean().default(false),
  })).max(50).optional(),
  blockedBy: z.array(outlineKey).optional().describe('선행 카드 key 목록'),
})

function buildMapFromOutline(cards) {
  const cardsByKey = new Map()
  cards.forEach((card) => {
    if (cardsByKey.has(card.key)) throw new Error(`카드 key가 중복되었습니다: ${card.key}`)
    cardsByKey.set(card.key, card)
  })

  const roots = cards.filter((card) => !card.parentKey)
  if (roots.length !== 1) throw new Error('상위 카드가 없는 루트 카드는 정확히 하나여야 합니다.')
  if (roots[0].kind && roots[0].kind !== 'root') throw new Error('상위 카드가 없는 카드는 kind=root이거나 kind를 생략해야 합니다.')
  const nestedRoot = cards.find((card) => card.parentKey && card.kind === 'root')
  if (nestedRoot) throw new Error(`하위 카드는 kind=root으로 지정할 수 없습니다: ${nestedRoot.key}`)

  const childrenByKey = new Map(cards.map((card) => [card.key, []]))
  cards.forEach((card) => {
    if (card.parentKey) {
      if (!cardsByKey.has(card.parentKey)) throw new Error(`상위 카드 key를 찾을 수 없습니다: ${card.parentKey}`)
      if (card.parentKey === card.key) throw new Error(`카드는 자기 자신을 상위 카드로 지정할 수 없습니다: ${card.key}`)
      childrenByKey.get(card.parentKey).push(card.key)
    }
    for (const blockedByKey of card.blockedBy ?? []) {
      if (!cardsByKey.has(blockedByKey)) throw new Error(`선행 카드 key를 찾을 수 없습니다: ${blockedByKey}`)
      if (blockedByKey === card.key) throw new Error(`카드는 자기 자신을 선행 카드로 지정할 수 없습니다: ${card.key}`)
    }
  })

  cards.forEach((card) => {
    const path = new Set()
    let current = card
    while (current.parentKey) {
      if (path.has(current.key)) throw new Error(`카드 계층에 순환 관계가 있습니다: ${card.key}`)
      path.add(current.key)
      current = cardsByKey.get(current.parentKey)
    }
    if (current.key !== roots[0].key) throw new Error(`루트 카드에 연결되지 않은 카드가 있습니다: ${card.key}`)
  })

  let nextLeafRow = 0
  const positions = new Map()
  const layout = (key, depth) => {
    const childKeys = childrenByKey.get(key)
    const childRows = childKeys.map((childKey) => layout(childKey, depth + 1))
    const row = childRows.length > 0
      ? (childRows[0] + childRows[childRows.length - 1]) / 2
      : nextLeafRow++
    positions.set(key, { x: depth * 340, y: row * 180 })
    return row
  }
  layout(roots[0].key, 0)
  const rootY = positions.get(roots[0].key).y

  const nodes = cards.map((card) => {
    const hasChildren = childrenByKey.get(card.key).length > 0
    const kind = card.parentKey ? (card.kind ?? (hasChildren ? 'branch' : 'task')) : 'root'
    const status = card.status ?? (card.progress >= 100 ? 'done' : card.progress > 0 ? 'in-progress' : 'planned')
    const position = positions.get(card.key)
    return {
      id: card.key,
      type: 'mind',
      position: { x: position.x, y: position.y - rootY },
      data: {
        label: card.label,
        description: card.description,
        progress: card.progress,
        status,
        kind,
        ...(card.taskUrl ? { taskUrl: card.taskUrl } : {}),
        ...(kind === 'task' || card.isWork !== undefined ? { isWork: card.isWork ?? true } : {}),
        ...(card.assigneeId ? { assigneeId: card.assigneeId } : {}),
        ...(card.dueDate ? { dueDate: card.dueDate } : {}),
        ...(card.checklist ? {
          checklist: card.checklist.map((item, index) => ({ id: `check-${card.key}-${index + 1}`, ...item })),
        } : {}),
        ...(card.blockedBy?.length ? { blockedBy: card.blockedBy } : {}),
      },
    }
  })
  const edges = cards.filter((card) => card.parentKey).map((card) => ({
    id: `edge-${card.parentKey}-${card.key}`,
    source: card.parentKey,
    target: card.key,
    type: 'bezier',
    markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
  }))
  return { nodes, edges, rootKey: roots[0].key }
}

async function main() {
  const server = new McpServer({ name: 'MindNProgress', version: '1.0.0' }, { instructions: serverInstructions })

  registerTool(server, 'mindnprogress_list_documents', '활성 문서 목록과 버전, 완료 현황을 조회합니다.', {}, async () =>
    apiRequest('/api/maps'))

  registerTool(server, 'mindnprogress_read_me_first', 'MindNProgress를 처음 사용하거나 MindNProgress 밖에서 대화를 시작했다면 가장 먼저 읽어야 하는 제품 가이드입니다. 문서 ID 없이 호출할 수 있으며 마인드맵 작성 규칙과 안전한 도구 사용 순서를 알려줍니다.', {}, async () => ({
    guide: productGuide,
    recommendedWorkflows: {
      exploreWithoutSelection: [
        'mindnprogress_list_documents로 문서 목록 확인',
        'mindnprogress_get_document로 대상 문서의 전체 구조 확인',
        '특정 카드를 정하면 이후 mindnprogress_get_context로 제품 규칙과 선택 카드 관계를 함께 확인',
      ],
      createMindmap: [
        '사용자 자료를 분석하고 루트 1개, 핵심 branch, 실행 task로 계층 구성',
        'mindnprogress_create_mindmap을 한 번 호출해 문서와 전체 구조를 원자적으로 생성',
        '반환된 문서 ID로 mindnprogress_get_document를 호출해 생성 결과 검증',
      ],
      editExistingDocument: [
        'mindnprogress_get_context로 최신 버전과 선택 카드 관계 확인',
        '목적에 맞는 카드 또는 문서 편집 도구 호출',
        'mindnprogress_get_document로 실제 저장 결과 검증',
      ],
    },
    important: [
      '여러 카드의 새 문서는 create_document와 save_document 조합이 아니라 mindnprogress_create_mindmap으로 생성',
      '업무로 추적할 task만 isWork=true로 설정',
      '업무 링크, 담당자와 마감일은 실제 값이 있을 때만 지정',
      '비밀번호 변경과 관리자 계정 관리는 MCP에서 지원하지 않음',
    ],
  }))

  registerTool(server, 'mindnprogress_get_context', 'MindNProgress의 제품 개념과 작성 규칙, 전체 최신 문서, 선택 카드와 최상위 카드의 업무 링크, 계층·의존성·댓글·담당자 정보를 한 번에 조회합니다. 대화를 시작한 뒤 다른 MindNProgress 도구보다 먼저 호출하세요.', {
    mapId: z.string().min(1).describe('현재 문서 ID'),
    cardId: z.string().min(1).describe('편집자가 선택한 카드 ID'),
    editorId: z.string().min(1).max(120).optional().describe('AI 대화를 시작한 MindNProgress 편집자 계정 ID'),
    attributionToken: z.string().min(32).max(200).optional().describe('MindNProgress의 AI 대화 시작 화면에서 전달된 작성자 귀속 토큰'),
  }, async ({ mapId, cardId, editorId, attributionToken }) => {
    activeMapId = mapId
    activeCardId = cardId
    if (editorId) activeEditorId = editorId
    if (attributionToken) activeAttributionToken = attributionToken
    const [documentResult, commentsResult, usersResult, health] = await Promise.all([
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}`),
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments?nodeId=${encodeURIComponent(cardId)}`),
      apiRequest('/api/assignees'),
      apiRequest('/api/health'),
    ])
    const map = documentResult.map
    const selectedCard = map.nodes.find((node) => node.id === cardId)
    if (!selectedCard) throw new Error(`선택 카드를 찾을 수 없습니다: ${cardId}`)

    const parentIds = map.edges.filter((edge) => edge.target === cardId).map((edge) => edge.source)
    const childIds = map.edges.filter((edge) => edge.source === cardId).map((edge) => edge.target)
    const siblingIds = [...new Set(parentIds.flatMap((parentId) => map.edges
      .filter((edge) => edge.source === parentId && edge.target !== cardId)
      .map((edge) => edge.target)))]
    const ancestorIds = new Set()
    const ancestorStack = [...parentIds]
    while (ancestorStack.length > 0) {
      const currentId = ancestorStack.pop()
      if (!currentId || ancestorIds.has(currentId)) continue
      ancestorIds.add(currentId)
      map.edges.filter((edge) => edge.target === currentId).forEach((edge) => ancestorStack.push(edge.source))
    }
    const descendantIds = descendantsOf(cardId, map.edges)
    const blockedByIds = selectedCard.data?.blockedBy ?? []
    const blockingIds = map.nodes.filter((node) => (node.data?.blockedBy ?? []).includes(cardId)).map((node) => node.id)
    const selectedHierarchyIds = new Set([cardId, ...ancestorIds])
    const topLevelCard = map.nodes.find((node) => selectedHierarchyIds.has(node.id)
      && node.data?.kind === 'root'
      && !map.edges.some((edge) => edge.target === node.id))
      ?? map.nodes.find((node) => selectedHierarchyIds.has(node.id)
        && !map.edges.some((edge) => edge.target === node.id))
      ?? selectedCard
    const taskLinkFor = (card) => {
      const url = typeof card?.data?.taskUrl === 'string' ? card.data.taskUrl.trim() : ''
      return url ? { cardId: card.id, label: card.data?.label ?? card.id, url } : null
    }
    const selectedTaskLink = taskLinkFor(selectedCard)
    const topLevelTaskLink = taskLinkFor(topLevelCard)
    const availableTaskLinks = [
      ...(selectedTaskLink ? [{ scope: selectedCard.id === topLevelCard.id ? 'selected-and-top-level' : 'selected-card', ...selectedTaskLink }] : []),
      ...(topLevelTaskLink && topLevelCard.id !== selectedCard.id ? [{ scope: 'top-level-card', ...topLevelTaskLink }] : []),
    ]
    const startupInspectionTargets = availableTaskLinks.filter((link, index, links) =>
      links.findIndex((candidate) => candidate.url === link.url) === index)

    return {
      guide: productGuide,
      document: {
        id: map.id,
        title: map.title,
        color: map.color,
        version: map.version,
        updatedAt: map.updatedAt,
        updatedBy: map.updatedBy,
        nodes: map.nodes,
        edges: map.edges,
        accessUrl: documentAccessUrl(health.publicBaseUrl, map.id),
      },
      selection: {
        card: selectedCard,
        accessUrl: cardAccessUrl(health.publicBaseUrl, map.id, selectedCard.id),
        parents: relatedCards(parentIds, map.nodes),
        children: relatedCards(childIds, map.nodes),
        siblings: relatedCards(siblingIds, map.nodes),
        ancestors: relatedCards(ancestorIds, map.nodes),
        descendants: relatedCards(descendantIds, map.nodes),
        blockedBy: relatedCards(blockedByIds, map.nodes),
        blocks: relatedCards(blockingIds, map.nodes),
        taskLinks: {
          selectedCard: selectedTaskLink,
          topLevelCard: topLevelTaskLink,
          available: availableTaskLinks,
          startupInspection: {
            required: startupInspectionTargets.length > 0,
            targets: startupInspectionTargets,
            checks: ['업무 제목과 본문', '댓글과 대화 내용', '첨부파일 목록', '본문과 댓글에 포함된 관련 링크'],
            instruction: '선택 카드의 작업을 수행하기 전에 targets의 업무를 조사하여 배경, 목적, 요구사항, 제약과 관련 자료를 파악하세요. 기획서나 첨부파일이 있다고 가정하지 말고 본문에 간략한 요구사항만 있을 가능성도 고려하세요.',
            fallback: 'targets가 없으면 MindNProgress 카드 정보로 진행합니다. 외부 업무 시스템 도구가 없거나 조회에 실패하면 임의로 추측하지 말고 조회하지 못한 대상과 원인을 알린 뒤, 확인된 카드 정보만으로 가능한 작업은 계속 진행하세요.',
          },
          rule: '선택 카드와 최상위 카드의 업무 링크를 독립적으로 유지합니다. 작업 시작 전에 startupInspection을 따르며, 두 링크가 모두 있으면 중복 URL을 제외하고 모두 조사합니다. 링크를 다른 카드 데이터에 상속하거나 복사하지 않습니다.',
        },
        comments: commentsResult.comments ?? [],
      },
      teamMembers: usersResult.users ?? [],
      nextStep: '사용자 요청을 수행한 뒤 변경이 있었다면 mindnprogress_get_document로 결과를 다시 확인하세요.',
    }
  })

  registerTool(server, 'mindnprogress_get_document', '문서의 모든 카드와 연결 관계 및 외부에서 접근 가능한 URL을 조회합니다.', mapIdSchema, async ({ mapId }) => {
    const [documentResult, health] = await Promise.all([
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}`),
      apiRequest('/api/health'),
    ])
    return {
      ...documentResult,
      access: {
        publicBaseUrl: health.publicBaseUrl,
        documentUrl: documentAccessUrl(health.publicBaseUrl, documentResult.map.id),
        cards: documentResult.map.nodes.map((node) => ({
          cardId: node.id,
          label: node.data?.label ?? node.id,
          accessUrl: cardAccessUrl(health.publicBaseUrl, documentResult.map.id, node.id),
        })),
        rule: '링크를 기록할 때 localhost나 127.0.0.1로 재작성하지 말고 accessUrl을 그대로 사용하세요.',
      },
    }
  })

  registerTool(server, 'mindnprogress_create_mindmap', '새 문서와 완성된 계층형 마인드맵을 한 번에 원자적으로 생성합니다. 여러 카드를 만들 때는 create_document 후 save_document를 호출하지 말고 반드시 이 도구를 우선 사용하세요. 카드 위치와 연결선은 자동 배치됩니다.', {
    title: z.string().min(1).max(120),
    color: documentColor.default('violet'),
    cards: z.array(outlineCardSchema).min(1).max(300).describe('루트부터 하위 카드까지 포함한 전체 카드 목록'),
  }, async ({ title, color, cards }) => {
    const { nodes, edges, rootKey } = buildMapFromOutline(cards)
    const created = await apiRequest('/api/maps', {
      method: 'POST',
      body: JSON.stringify({ title, color, map: { nodes, edges } }),
    })
    return {
      created: true,
      document: created.summary,
      rootCardId: rootKey,
      cardCount: nodes.length,
      message: '문서와 전체 마인드맵을 한 번의 저장으로 생성했습니다. 추가 save_document 호출은 필요하지 않습니다.',
    }
  })

  registerTool(server, 'mindnprogress_create_document', '루트 카드 하나만 있는 새 문서를 생성합니다. 처음부터 여러 카드로 구성할 때는 버전 충돌 방지를 위해 mindnprogress_create_mindmap을 사용하세요.', {
    title: z.string().min(1),
    color: documentColor.default('violet'),
    rootLabel: z.string().min(1),
    rootDescription: z.string().default(''),
  }, async ({ title, color, rootLabel, rootDescription }) => {
    const rootId = `node-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    return apiRequest('/api/maps', {
      method: 'POST',
      body: JSON.stringify({
        title,
        color,
        map: {
          nodes: [{
            id: rootId,
            type: 'mind',
            position: { x: 0, y: 0 },
            data: { label: rootLabel, description: rootDescription, progress: 0, status: 'planned', kind: 'root' },
          }],
          edges: [],
        },
      }),
    })
  })

  registerTool(server, 'mindnprogress_save_document', '문서의 전체 카드와 연결 관계를 저장합니다. 카드 추가, 복사, 이동, 삭제와 모든 카드 속성 변경을 지원합니다.', {
    mapId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    nodes: z.array(z.record(z.unknown())),
    edges: z.array(z.record(z.unknown())),
    force: z.boolean().default(false),
  }, async ({ mapId, baseVersion, nodes, edges, force }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}`, {
    method: 'PUT',
    body: JSON.stringify({ map: { nodes, edges }, baseVersion, force }),
  }))

  registerTool(server, 'mindnprogress_add_card', '문서에 새 카드 또는 하위 카드를 추가합니다.', {
    mapId: z.string().min(1),
    parentId: z.string().optional(),
    data: nodeDataSchema,
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  }, async ({ mapId, parentId, data, position }) => {
    const map = await getDocument(mapId)
    const parent = parentId ? map.nodes.find((node) => node.id === parentId) : null
    if (parentId && !parent) throw new Error('상위 카드를 찾을 수 없습니다.')
    const siblingCount = parentId ? map.edges.filter((edge) => edge.source === parentId).length : map.nodes.length
    const nodeId = `node-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const node = {
      id: nodeId,
      type: 'mind',
      position: position ?? {
        x: (parent?.position?.x ?? 0) + (parent ? 300 : 0),
        y: (parent?.position?.y ?? 0) + siblingCount * 150,
      },
      data,
    }
    map.nodes.push(node)
    if (parentId) map.edges.push({
      id: `edge-${parentId}-${nodeId}`,
      source: parentId,
      target: nodeId,
      type: 'bezier',
      markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
    })
    return saveDocument(map, false, parentId ?? '')
  })

  registerTool(server, 'mindnprogress_update_card', '카드 제목, 설명, 진행률, 상태, 업무 링크, 담당자, 마감일, 체크리스트와 선행 업무를 변경합니다.', {
    mapId: z.string().min(1),
    nodeId: z.string().min(1),
    data: nodeDataSchema.partial(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  }, async ({ mapId, nodeId, data, position }) => {
    const map = await getDocument(mapId)
    const node = map.nodes.find((item) => item.id === nodeId)
    if (!node) throw new Error('카드를 찾을 수 없습니다.')
    node.data = { ...node.data, ...data }
    if (position) node.position = position
    return saveDocument(map, false, nodeId)
  })

  registerTool(server, 'mindnprogress_move_card', '카드와 모든 하위 카드를 유지한 채 다른 카드의 하위로 이동합니다.', {
    mapId: z.string().min(1),
    nodeId: z.string().min(1),
    newParentId: z.string().min(1),
  }, async ({ mapId, nodeId, newParentId }) => {
    const map = await getDocument(mapId)
    if (!map.nodes.some((node) => node.id === nodeId) || !map.nodes.some((node) => node.id === newParentId)) {
      throw new Error('이동할 카드 또는 새 상위 카드를 찾을 수 없습니다.')
    }
    if (nodeId === newParentId || descendantsOf(nodeId, map.edges).has(newParentId)) {
      throw new Error('자기 자신이나 하위 카드 아래로 이동할 수 없습니다.')
    }
    map.edges = map.edges.filter((edge) => edge.target !== nodeId)
    map.edges.push({
      id: `edge-${newParentId}-${nodeId}`,
      source: newParentId,
      target: nodeId,
      type: 'bezier',
      markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
    })
    return saveDocument(map, false, nodeId)
  })

  registerTool(server, 'mindnprogress_delete_card', '카드를 삭제합니다. 기본적으로 모든 하위 카드도 함께 삭제합니다.', {
    mapId: z.string().min(1),
    nodeId: z.string().min(1),
    includeDescendants: z.boolean().default(true),
  }, async ({ mapId, nodeId, includeDescendants }) => {
    const map = await getDocument(mapId)
    const target = map.nodes.find((node) => node.id === nodeId)
    if (!target) throw new Error('카드를 찾을 수 없습니다.')
    if (target.data?.kind === 'root') throw new Error('루트 카드는 삭제할 수 없습니다.')
    const deletedIds = includeDescendants ? descendantsOf(nodeId, map.edges) : new Set()
    deletedIds.add(nodeId)
    map.nodes = map.nodes.filter((node) => !deletedIds.has(node.id))
    map.edges = map.edges.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target))
    return saveDocument(map, false, nodeId)
  })

  registerTool(server, 'mindnprogress_update_document_info', '문서 이름 또는 아이콘 색상을 변경합니다.', {
    mapId: z.string().min(1),
    baseVersion: z.number().int().positive(),
    title: z.string().min(1).optional(),
    color: documentColor.optional(),
    force: z.boolean().default(false),
  }, async ({ mapId, ...body }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}`, {
    method: 'PATCH', body: JSON.stringify(body),
  }))

  registerTool(server, 'mindnprogress_reorder_documents', '좌측 보드의 문서 순서를 변경합니다.', {
    mapIds: z.array(z.string()).min(1),
  }, async ({ mapIds }) => apiRequest('/api/maps/order', { method: 'PATCH', body: JSON.stringify({ mapIds }) }))

  registerTool(server, 'mindnprogress_move_document_to_trash', '문서를 휴지통으로 이동합니다.', mapIdSchema, async ({ mapId }) =>
    apiRequest(`/api/maps/${encodeURIComponent(mapId)}`, { method: 'DELETE' }))
  registerTool(server, 'mindnprogress_list_trash', '휴지통 문서 목록을 조회합니다.', {}, async () =>
    apiRequest('/api/maps/trash'))
  registerTool(server, 'mindnprogress_restore_document', '휴지통 문서를 복원합니다.', mapIdSchema, async ({ mapId }) =>
    apiRequest(`/api/maps/${encodeURIComponent(mapId)}/restore`, { method: 'POST' }))
  registerTool(server, 'mindnprogress_delete_trashed_documents', '휴지통에서 선택한 문서를 영구 삭제합니다. 문서, 댓글, 변경 이력이 함께 삭제되며 복구할 수 없습니다.', {
    mapIds: z.array(z.string().min(1)).min(1),
    confirmPermanentDeletion: z.literal(true),
  }, async ({ mapIds }) => apiRequest('/api/maps/trash', { method: 'DELETE', body: JSON.stringify({ mapIds }) }))
  registerTool(server, 'mindnprogress_empty_trash', '휴지통의 모든 문서를 영구 삭제합니다. 문서, 댓글, 변경 이력이 함께 삭제되며 복구할 수 없습니다.', {
    confirmPermanentDeletion: z.literal(true),
  }, async () => apiRequest('/api/maps/trash', { method: 'DELETE', body: JSON.stringify({ all: true }) }))

  registerTool(server, 'mindnprogress_list_history', '문서 변경 이력을 최신순으로 조회합니다. 다음 이력이 있으면 nextOffset을 offset으로 전달해 이어서 조회하세요.', {
    mapId: z.string().min(1),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }, async ({ mapId, offset, limit }) =>
    apiRequest(`/api/maps/${encodeURIComponent(mapId)}/history?offset=${offset}&limit=${limit}`))
  registerTool(server, 'mindnprogress_restore_history', '선택한 변경 이력으로 문서를 복원합니다.', {
    mapId: z.string().min(1), revisionId: z.string().min(1),
  }, async ({ mapId, revisionId }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/history/${encodeURIComponent(revisionId)}/restore`, { method: 'POST' }))

  registerTool(server, 'mindnprogress_list_users', '담당자로 지정할 수 있는 편집자 계정 목록을 조회합니다. active=false인 계정은 기존 담당자 표시용이며 새 담당자로 지정하지 마세요.', {}, async () =>
    apiRequest('/api/assignees'))
  registerTool(server, 'mindnprogress_list_comments', '문서 또는 특정 카드의 댓글과 답글을 조회합니다.', {
    mapId: z.string().min(1), nodeId: z.string().optional(),
  }, async ({ mapId, nodeId }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`))
  registerTool(server, 'mindnprogress_add_comment', '카드에 댓글 또는 답글을 작성합니다.', {
    mapId: z.string().min(1), nodeId: z.string().min(1), text: z.string().min(1).max(1000), parentId: z.string().optional(),
  }, async ({ mapId, ...body }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments`, {
    method: 'POST', aiCardId: body.nodeId, body: JSON.stringify(body),
  }))
  registerTool(server, 'mindnprogress_delete_comment', '댓글과 연결된 답글을 삭제합니다.', {
    mapId: z.string().min(1), commentId: z.string().min(1),
  }, async ({ mapId, commentId }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' }))
  registerTool(server, 'mindnprogress_set_comment_resolved', '댓글 스레드의 해결 또는 다시 열기 상태를 변경합니다.', {
    mapId: z.string().min(1), commentId: z.string().min(1), resolved: z.boolean(),
  }, async ({ mapId, commentId, resolved }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments/${encodeURIComponent(commentId)}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolved }) }))
  registerTool(server, 'mindnprogress_toggle_comment_reaction', '댓글의 이모지 반응을 추가하거나 취소합니다.', {
    mapId: z.string().min(1), commentId: z.string().min(1), emoji: z.enum(['👍', '❤️', '🎉', '👀']),
  }, async ({ mapId, commentId, emoji }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments/${encodeURIComponent(commentId)}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }))

  registerTool(server, 'mindnprogress_list_notifications', '현재 AI 편집자의 알림을 조회합니다.', {}, async () =>
    apiRequest('/api/notifications'))
  registerTool(server, 'mindnprogress_mark_notification_read', '알림을 읽음으로 표시합니다.', {
    notificationId: z.string().min(1),
  }, async ({ notificationId }) => apiRequest(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'PATCH' }))
  registerTool(server, 'mindnprogress_mark_all_notifications_read', '모든 알림을 읽음으로 표시합니다.', {}, async () =>
    apiRequest('/api/notifications/read-all', { method: 'POST' }))

  await server.connect(new StdioServerTransport())
}

main().catch((error) => {
  console.error('[MindNProgress MCP]', error)
  process.exit(1)
})
