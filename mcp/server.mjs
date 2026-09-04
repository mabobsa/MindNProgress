import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AI_DELEGATION_ID_PATTERN } from '../server/lib/aiDelegations.mjs'
import {
  sharedKnowledgeAuthoringPolicy,
  sharedKnowledgeMaintenancePolicy,
} from '../server/lib/sharedKnowledgeAudit.mjs'
import {
  applyCardTextPatch,
  cardTextIntegrity,
  sharedKnowledgeMaxLength,
  textIntegrity,
} from './cardTextPatch.mjs'
import { imageCardLocalAccess } from './imageAccess.mjs'
import { MCP_TOOL_USAGE_DIRECTORY_NAME, createFileToolUsageRecorder } from '../server/lib/mcpToolUsage.mjs'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDirectory = path.resolve(String(process.env.MNP_DATA_DIR ?? '').trim() || path.join(projectDirectory, 'server', 'data'))
const tokenFile = path.resolve(String(process.env.MNP_TOKEN_FILE ?? '').trim() || path.join(dataDirectory, '_integration-token'))
const apiBaseUrl = String(process.env.MNP_API_URL ?? 'http://127.0.0.1:4176').replace(/\/+$/, '')
const aionUiConversationId = String(process.env.AIONUI_CONVERSATION_ID ?? '').trim()
const toolUsageDirectory = path.resolve(String(process.env.MNP_MCP_USAGE_DIR ?? '').trim()
  || path.join(dataDirectory, MCP_TOOL_USAGE_DIRECTORY_NAME))
const toolUsageDisabled = String(process.env.MNP_MCP_USAGE_DISABLED ?? '').trim() === '1'
const toolUsageFlushIntervalMs = Number(String(process.env.MNP_MCP_USAGE_FLUSH_MS ?? '').trim())
const contextSchemaVersion = '3.0'
const commentSummaryMaxLength = 240
const commentSummaryTooLongMessage = 'summary는 240자 이하의 1~2문장만 입력하세요. 상세 내용은 summary 문자열에 이어 붙이지 말고 detail 인자로 분리하세요. 예: {"summary":"[결과] 구현과 검증을 완료했습니다.","detail":"## 수행 내용\\n..."}. 호환용 text로 우회하거나 상세를 여러 댓글로 나누지 마세요.'
const contextCommentLimit = 20
const mindMapGridSize = 24
const mindMapChildHorizontalGap = mindMapGridSize * 4
const mindMapWorkNodeVerticalStep = mindMapGridSize * 6
const mindMapDefaultNodeWidth = 218
let activeAttributionToken = ''
let activeEditorId = ''
let activeAiType = ''
let activeAiModel = ''
let activeMapId = ''
let activeCardId = ''
let activeResolvedAttributionExpiresAt = 0
let activeAttributionResolutionFailure = null
let activeAttributionResolutionPromise = null
let delegationOrigin = null
const attributionContinuationToken = Symbol('attributionContinuationToken')
let commentAttributionQueue = Promise.resolve()

// 도구 호출 계측은 실패해도 도구 호출 자체를 막지 않는다.
// 생성 실패나 쓰기 실패는 모두 삼키고 계측만 꺼진다.
const toolUsage = (() => {
  if (toolUsageDisabled) return null
  try {
    return createFileToolUsageRecorder(toolUsageDirectory, {
      conversationId: aionUiConversationId,
      flushOnExit: true,
      flushIntervalMs: Number.isFinite(toolUsageFlushIntervalMs) && toolUsageFlushIntervalMs > 0
        ? toolUsageFlushIntervalMs
        : undefined,
    })
  } catch {
    return null
  }
})()

function toolResultLength(result) {
  let length = 0
  for (const part of result?.content ?? []) {
    if (typeof part?.text === 'string') length += part.text.length
  }
  return length
}

function snapMindMapPosition(position) {
  return {
    x: Math.round(position.x / mindMapGridSize) * mindMapGridSize,
    y: Math.round(position.y / mindMapGridSize) * mindMapGridSize,
  }
}

function defaultChildMindMapPosition(parentPosition, siblingPositions, parentWidth = mindMapDefaultNodeWidth) {
  const alignedParentPosition = snapMindMapPosition(parentPosition)
  const normalizedParentWidth = Number.isFinite(parentWidth) && parentWidth > 0
    ? parentWidth
    : mindMapDefaultNodeWidth
  const nextY = siblingPositions.length > 0
    ? Math.max(...siblingPositions.map((position) => snapMindMapPosition(position).y)) + mindMapWorkNodeVerticalStep
    : alignedParentPosition.y
  return {
    x: snapMindMapPosition({
      x: alignedParentPosition.x + normalizedParentWidth + mindMapChildHorizontalGap,
      y: alignedParentPosition.y,
    }).x,
    y: nextY,
  }
}

const cardTextSafetyRules = Object.freeze([
  '한국어 자연어를 포함한 텍스트 필드는 실제 문자로 전송하고, 사람이 검토할 본문을 \\uXXXX 유니코드 이스케이프나 코드포인트 조립으로 생성하거나 옮겨 적지 않음',
  '같은 카드의 같은 필드에 여러 부분 수정을 적용할 때는 병렬 호출하지 않고 한 건씩 순차 적용하며, 직전 mindnprogress_patch_card_text 응답의 after.sha256을 다음 expectedSha256으로 사용하고 이전 해시를 재사용하지 않음',
])
const cardTextSafetyInstructions = cardTextSafetyRules.join(' ')

const knowledgeLinePolicy = Object.freeze({
  mode: 'actual-use-only',
  evaluateAt: 'after-work',
  discovery: '지식선을 만들기 위한 목적으로 다른 카드나 문서를 전수 검색하지 않음. 현재 작업 중 실제로 조회하고 근거로 사용한 MindNProgress 카드만 판단 대상임',
  autoConnectWhenAll: Object.freeze([
    'source 카드를 이번 작업에서 실제로 조회하고 내용을 사용함',
    '사용한 내용이 source 카드의 현재 유효하고 검증된 sharedKnowledge에 기록되어 있음',
    'source의 결론이 target 카드의 요구사항 판단, 구현 또는 검증에 직접 영향을 줌',
    '후속 세션에서도 같은 결론을 다시 사용할 가능성이 높음',
    'source와 target이 같은 문서에 있고 기존 동일 지식선이 없음',
  ]),
  proposeOnlyWhenAny: Object.freeze([
    'source 지식이 아직 확정되지 않았거나 설명과 댓글이 서로 충돌함',
    'source를 실제 근거로 사용하지 않고 관련 가능성만 확인함',
    'source가 다른 문서에 있어 Ref 카드가 먼저 필요함',
    '연결 필요성 또는 knowledgePolicy를 명확히 판단할 수 없음',
  ]),
  neverConnectFor: Object.freeze([
    '같은 주제, 비슷한 제목 또는 계층상 인접하다는 이유만 있는 관계',
    '한 번 확인하고 끝나는 일회성 참조',
    '계층 관계, 업무 선행 관계 또는 외부 전달물·결정 대기 관계',
  ]),
  policySelection: Object.freeze({
    'reuse-first': 'source의 확정 결론을 target 작업에서 우선 재사용해야 할 때 선택',
    'inspect-if-insufficient': 'target의 현재 정보가 부족할 때만 source를 참고하면 될 때 선택',
  }),
  reporting: Object.freeze({
    connected: '자동 연결한 source, target, policy와 실제 사용 근거를 최종 보고에 포함',
    proposed: '자동 연결하지 않은 후보는 source, target, 제안 policy, 보류 이유를 최종 보고에 포함',
    skipped: '이번 작업에서 다른 MindNProgress 카드를 실제 근거로 사용하지 않았다면 지식선 검색과 보고를 생략',
  }),
})

const serverInstructions = `MindNProgress는 마인드맵과 업무 진행 관리를 결합한 웹 서비스입니다. MindNProgress 밖에서 시작해 문서 ID나 카드 ID가 없다면 mindnprogress_read_me_first를 먼저 호출하세요. 선택 문서와 카드가 있다면 mindnprogress_get_context로 제품 규칙과 최신 문서 구조를 먼저 확인하세요. MCP 도구에서 카드를 지정할 때는 cardId 계열 인자를 사용하세요. nodeId 계열 인자는 기존 대화 호환용이므로 새 호출에서는 사용하지 마세요. AionUi 일반 대화는 get_context 호출 시 현재 대화의 AI 종류와 모델을 자동 확인하므로 aiType과 aiModel을 임의로 채우지 마세요. AionUi가 아닌 외부 MCP 세션만 자신이 현재 AI 종류와 모델을 정확히 알고 있을 때 get_context의 aiType과 aiModel에 함께 전달하고, 알지 못하면 추측하지 마세요. get_context의 selection.taskLinks.startupInspection을 따르세요. mode가 knowledge-guided이면 primary 선행 지식 중 kind=image인 항목은 imageAccess.localPath의 원본을 사용 가능한 로컬 이미지 열람 도구로 직접 확인하고 설명과 댓글을 함께 사용하며, 일반 카드는 sharedKnowledge를 먼저 재사용하고 설명과 댓글로 보완합니다. fallbackSources와 fallbackTargets는 정보가 부족할 때만 선택적으로 조사합니다. mode가 default이고 required가 true이면 targets의 업무 본문, 댓글, 첨부파일 목록과 관련 링크를 조사하세요. 지식선 생성과 제안은 get_context의 guide.knowledgeLinePolicy를 따르세요. 진행 과정과 결과는 댓글에 기록하고, 다른 카드나 후속 세션이 재사용할 현재 유효한 사실·결정·제약·검증 결과만 sharedKnowledge에 남기세요. 진행 기록·도구 로그·중복·폐기 결론은 넣지 말고 같은 주제의 결론은 새 이력으로 덧붙이지 말고 기존 절을 안전하게 교체하세요. 실제로 실행할 카드에 독립적으로 완료 여부를 판정할 구현·검증 조건이 2개 이상이면 결과 중심 체크리스트로 작성하고 진행에 맞춰 갱신하세요. 별도 하위 카드로 추적할 작업은 체크리스트에 중복하지 마세요. AI 댓글은 1~2문장의 summary와 작업을 이어가거나 검증하는 데 필요한 사실을 충실히 담은 detail로 작성하며, 요약 때문에 상세를 축약하지 마세요. 외부 전달물이나 결정 대기는 waitingItems로 기록하고 제목에 대기 문구를 붙이지 마세요. 대기를 등록할 때는 [차단], 해제할 때는 [진행] 댓글로 이유와 재개 상태를 기록하세요. 카드 일부 필드만 변경할 때는 mindnprogress_update_card의 data에 변경할 필드만 보내고 현재 카드 전체 데이터를 재전송하지 마세요. 기존 description 또는 sharedKnowledge 내부의 일부만 고칠 때는 조회 결과의 textIntegrity SHA-256과 mindnprogress_patch_card_text를 사용하세요. ${cardTextSafetyInstructions} 과도한 sharedKnowledge를 정리할 때는 후보 목록과 전용 검토 문맥을 조회한 뒤 mindnprogress_apply_shared_knowledge_review로 현재 해시가 일치하는 결과만 원자적으로 저장하세요. 일반 카드에서 생략한 필드와 위치는 보존되지만 완료 상태 또는 진행률 100 적용 시 waitingItems는 자동으로 해제되며, Ref 카드는 원본 관리 필드가 최신 원본 값으로 동기화될 수 있습니다. 선택 카드 밖의 형제·하위·선행 카드를 함께 수정하기 전에는 mindnprogress_get_ai_work_states로 해당 카드에 다른 AI 작업이 진행 중인지 확인하세요. running 또는 waiting-confirmation인 카드는 사용자 지시 없이 동시에 수정하지 마세요. 등록된 AI 작업공간의 최신 목록·경로·상태가 필요하면 폴더명을 추측하지 말고 mindnprogress_get_ai_workspace_pool을 호출하세요. 작업공간 선택·점유·전환·해제는 MindNProgress만 수행하며 AI가 임의로 worker를 선택하지 않습니다. 현재 위임 실행이 사용자의 중지로 끊긴 뒤 같은 대화에서 직접 이어 실제 작업을 완료했다면 카드 기록과 작업공간 체크포인트를 마친 뒤 최종 답변 직전에 mindnprogress_complete_ai_delegation을 호출하세요. 같은 대화의 과거 위임만 중지됐거나 현재 위임이 중단 없이 진행됐다면 호출하지 마세요. 도구가 required=false를 반환하면 오류가 아니며 최종 답변을 마치면 자동으로 상위 AI에 보고됩니다. 지식선만 변경할 때는 전체 문서를 다시 보내지 말고 지식선 전용 도구를 사용하세요. 조회 도구는 문서 version을 변경하지 않지만 카드·관계 편집과 AI 대화 ID 연결은 version을 증가시킬 수 있습니다. 특정 자료가 있다고 가정하지 마세요. 여러 카드로 구성된 새 문서는 mindnprogress_create_mindmap으로 한 번에 생성하고, 변경 후에는 최신 문서를 다시 조회해 결과를 검증하세요. 비밀번호 변경과 계정 관리 작업은 지원하지 않습니다.`
const productGuide = {
  version: '4.13',
  product: {
    name: 'MindNProgress',
    purpose: '아이디어를 계층형 마인드맵으로 구조화하고 실행 업무의 진행 상황을 같은 문서에서 관리하는 웹 서비스',
    roles: {
      editor: '문서, 카드, 업무, 관계, 체크리스트와 댓글을 생성·변경할 수 있음',
      viewer: '내용과 링크를 열람할 수 있지만 문서를 변경할 수 없음',
    },
  },
  dataModel: {
    document: '하나의 마인드맵. 제목, 아이콘 색상, 버전, 카드(nodes), 계층선과 지식선(edges)을 가짐',
    documentLayout: '좌측 목록에서 개별 문서와 1단계 그룹을 섞어 배치하는 구조. 그룹 안에는 문서 ID와 순서를 저장하며 그룹 중첩은 지원하지 않음',
    hierarchy: 'data.relation이 knowledge가 아닌 edge에서 source가 상위 카드이고 target이 하위 카드임. 루트 카드는 문서당 하나를 권장',
    knowledgeLine: 'data.relation=knowledge인 edge는 source 카드의 결과를 target 카드가 선행 지식으로 사용함. knowledgePolicy는 reuse-first 또는 inspect-if-insufficient',
    cardContent: {
      description: '업무의 목적, 범위, 요구사항과 완료 조건. 사용자가 작성한 원래 맥락을 보존함',
      sharedKnowledge: '다른 카드나 후속 AI 세션에서 재사용할 안정적인 사실, 결정, 제약, 조사 결과와 사용 방법',
      comments: '시간순 진행 과정, 검증 결과, 차단 사유와 완료 기록. 새 댓글은 요약과 접을 수 있는 상세 내용으로 구분',
      aiConversations: '카드에서 시작한 AionUi 대화 목록. focused 컨텍스트는 최근 대화 ID와 전체 개수만 제공하며, 이어서 작업할 대화를 판단할 때는 mindnprogress_list_ai_conversations로 후보의 실행 환경과 상태를 비교한 뒤 필요한 conversationId만 전문 조회',
    },
    cardKinds: {
      root: '문서의 최상위 주제',
      branch: '주제나 영역을 묶는 중간 분류',
      task: '구체적인 실행 항목. 실제 업무라면 isWork=true로 설정',
      image: '마인드맵에 배치한 이미지 지식. MCP 응답의 imageAccess.localPath를 로컬 이미지 열람 도구로 직접 확인하고 description을 보조 설명으로 사용',
    },
    workFields: {
      progress: '0~100의 진행률. isWork=true 업무는 직접 관리하고, 최상위 카드와 하위 업무가 있는 일반 isWork=false 묶음 카드는 모든 실제 하위 업무를 동일 가중치로 평균한 읽기 전용 요약값을 서버가 자동 계산함',
      status: 'planned, in-progress, done. 직접 관리하는 업무는 done을 progress=100과 함께 사용하며 자동 진행률 카드의 상태도 하위 업무에서 파생됨',
      assigneeId: '담당자 사용자 ID. 담당자가 없으면 생략',
      dueDate: '마감일. 없는 업무는 생략',
      taskUrl: '관련 업무나 외부 자료를 가리키는 범용 링크. Dooray 형식은 전용 카드 표현과 메타데이터를 사용하고 그 밖의 URL도 그대로 유지하며, 링크가 없는 경우 생략',
      taskUrlContext: 'AI 대화 문맥에서는 선택 카드와 해당 계층의 최상위 카드 링크를 별도로 제공하며, 하위 카드에 링크를 상속하거나 덮어쓰지 않음',
      checklist: '해당 카드 안에서 완료할 결과 중심 구현·검증 항목. 비어 있지 않은 체크리스트를 저장하면 완료 비율로 진행률과 상태를 자동 계산하며, 별도 하위 카드로 추적할 작업은 중복하지 않음',
      blockedBy: '현재 업무보다 먼저 완료되어야 하는 카드 ID 목록. 계층 관계를 표현하는 용도로 사용하지 않음',
      waitingItems: '서버·아트·기획 등 외부 전달물이나 결정 대기 목록. label은 자유 입력하며 note, resumeCondition, since를 함께 기록할 수 있음. 상태와 진행률에는 영향을 주지 않음',
    },
  },
  knowledgeLinePolicy,
  views: {
    mindmap: '모든 카드의 계층과 연결 관계를 공간적으로 표시',
    kanban: 'isWork=true인 업무 카드를 상태별로 표시',
    timeline: 'isWork=true인 업무 중 일정 정보를 기준으로 표시',
    dashboard: '업무 진행률, 완료 상태와 병목을 요약',
  },
  commentRules: {
    summary: '현재 상태와 핵심 결과를 1~2문장으로 전달. [진행], [차단], [결과] 중 알맞은 머리말로 시작',
    detail: '다른 AI 세션이나 편집자가 댓글만 읽어도 작업을 이어가거나 결과를 검증할 수 있도록 현재 작업에 해당하는 수행 내용, 중요한 판단, 변경 범위, 검증 방법과 실제 결과, 산출물, 제한사항, 다음 단계 또는 재개 조건을 구체적으로 기록',
    detailRequired: '코드·문서·카드 변경, 외부 시스템 처리, 검증, 중요한 결정, 실패 또는 차단이 발생하면 상세를 작성. 새로운 사실이 없는 단순 상태 알림만 상세 생략 가능',
    omit: '해당하지 않는 빈 항목, 개별 도구 호출 목록, 의미 없는 반복, 원문 로그 전체와 카드 본문의 단순 복사는 제외',
    legacy: 'contentFormat이 summary-detail이 아닌 기존 댓글은 마이그레이션 전 원문이므로 요청 없이 자동 분리하거나 다시 쓰지 않음',
  },
  sharedKnowledgePolicy: {
    ...sharedKnowledgeAuthoringPolicy,
    maintenance: sharedKnowledgeMaintenancePolicy,
  },
  authoringRules: [
    '루트는 전체 목적이나 프로젝트 이름으로 작성',
    '루트 아래에는 보통 3~7개의 핵심 영역을 branch로 구성',
    '실행 가능한 단위는 task로 만들고 실제 추적 대상이면 isWork=true로 지정',
    '계층 깊이는 보통 2~4단계로 유지하고 중복되는 카드는 합침',
    '제목은 짧고 명확하게, description에는 목적·범위·요구사항·완료 조건을 기록',
    '실제로 실행할 카드에 독립적으로 완료 여부를 판정할 구현·검증 조건이 2개 이상이면 결과 중심 체크리스트로 작성하고 진행에 맞춰 갱신함. 별도 하위 카드로 추적할 작업은 중복하지 않으며 단일 작업, 탐색 중인 아이디어 또는 아직 완료 조건을 확정할 수 없는 카드에는 억지로 만들지 않음',
    '다른 카드나 후속 세션이 재사용할 현재 유효한 사실·결정·제약·검증 결과와 적용 조건만 sharedKnowledge에 요약하고 진행 과정은 댓글에 기록',
    '새 재사용 정보나 기존 결론의 변경이 없으면 sharedKnowledge를 수정하지 않으며, 같은 주제의 결론이 바뀌면 이력을 덧붙이지 않고 기존 절만 안전하게 교체',
    'sharedKnowledge를 수정할 때 기존 description의 사용자 요청과 배경을 임의로 덮어쓰지 않음',
    '존재하지 않는 담당자, 불필요한 업무 링크와 임의의 선행 관계를 만들지 않음',
    '문서 내부 선행 업무는 blockedBy, 외부 전달물·결정 대기는 waitingItems로 구분하고 제목에 “(서버 대기)” 같은 문구를 붙이지 않음',
    '진행률이 100이면 status=done, 완료가 아니면 progress를 100 미만으로 유지',
    '최상위 카드와 하위 업무가 있는 일반 isWork=false 묶음 카드의 진행률·상태는 서버가 모든 실제 isWork=true 후손에서 자동 계산하므로 수동으로 덮어쓰지 않음. 각 업무는 동일 가중치이며 중간 묶음의 요약값은 상위 집계에 다시 포함하지 않음. 이미지·Ref·Dooray 지식 카드와 하위 업무가 없는 비업무 카드는 자동 집계하지 않음',
  ],
  operationRules: [
    '분석과 편집 전에 mindnprogress_get_context로 최신 버전과 제품 규칙을 확인',
    'AionUi에서 시작한 대화에 attributionToken이 없으면 mindnprogress_get_context가 현재 대화의 AI 종류와 모델을 AionUi에서 확인해 임시 귀속함. 조회 실패 중에는 읽기 도구를 계속 사용할 수 있지만 모델 미지정 기록을 막기 위해 편집 도구는 AI_ATTRIBUTION_UNRESOLVED로 거부됨',
    'mindnprogress_get_context를 한 번 호출하라는 지침은 성공 응답 기준임. 사용자 중지, 취소, 시간 초과 또는 연결 종료로 응답을 받지 못한 시도는 횟수에 포함하지 않고 같은 대화를 이어갈 때 다시 호출하며, 성공 응답 뒤에는 같은 대화에서 반복 호출하지 않음',
    'MCP 도구에서 카드를 지정할 때는 cardId, parentCardId, newParentCardId를 사용하고 댓글의 상위 답글은 parentCommentId를 사용함. nodeId, parentId, newParentId는 기존 대화 호환용이므로 새 호출에서는 사용하지 않음',
    'get_context의 startupInspection.mode가 knowledge-guided이면 주요 선행 지식을 먼저 활용하되 kind=image인 source는 imageAccess.localPath의 원본을 로컬 이미지 열람 도구로 직접 확인하고, fallback은 정보가 부족할 때만 조사',
    'startupInspection.mode가 default이고 조사가 요구되면 실제 작업 전에 선택 카드와 최상위 카드의 업무 링크를 조사하되 특정 첨부나 자료가 있다고 가정하지 않음',
    '여러 카드로 새 문서를 만들 때 mindnprogress_create_mindmap을 한 번만 호출',
    '문서 그룹이나 혼합 순서를 변경할 때 먼저 전체 문서와 documentLayout을 조회하고 모든 활성 문서를 정확히 한 번 유지',
    'create_document 후 save_document를 연속 호출해 전체 구조를 만들지 않음',
    '지식선 추가·정책 변경·삭제는 전체 save_document 대신 지식선 전용 도구를 사용',
    '카드 일부 필드만 변경할 때 mindnprogress_update_card의 data에는 변경할 필드만 보내고 현재 카드 전체 데이터를 재전송하지 않음. 일반 카드에서 생략한 필드와 위치는 보존되지만 완료 상태 또는 진행률 100 적용 시 waitingItems가 자동으로 해제되며 Ref 카드는 원본 관리 필드가 최신 원본 값으로 동기화될 수 있음',
    '기존 description 또는 sharedKnowledge 내부의 일부만 수정할 때는 조회 응답의 textIntegrity SHA-256을 expectedSha256으로 지정해 mindnprogress_patch_card_text를 사용하고 필드 전체를 다시 생성하지 않음',
    ...cardTextSafetyRules,
    '과도한 sharedKnowledge를 정리할 때는 mindnprogress_list_shared_knowledge_candidates에서 후보를 고르고 mindnprogress_get_shared_knowledge_review_context로 한 카드 원문과 관계를 확인한 뒤 mindnprogress_apply_shared_knowledge_review로 저장함. cleaned는 정리한 replacement를 보내고, 장문 전체가 계속 필요할 때만 replacement 없이 accepted-long을 사용함',
    'sharedKnowledge 정리 후보가 있으면 주 1회와 주요 마일스톤 완료·인수인계 시점에 점검하되 자동으로 삭제하거나 축약하지 않고 우선 정리·정리 권장·관심 순으로 카드별 승인을 받음. accepted-long 승인은 30일 뒤 다시 검토함',
    'mindnprogress_update_card의 responseMode는 full이 기본값이며 저장된 전체 카드 본문과 관계를 연속 작업용으로 반환하되 AI 대화 상세 목록과 렌더링 전용 필드는 제외함. 단일 카드와 서버가 함께 조정한 카드만 필요하면 affected를 명시함',
    '선택 카드 밖의 형제·하위·선행 카드를 함께 수정하기 전에는 mindnprogress_get_ai_work_states로 해당 카드의 AI 작업 상태를 확인하고, running 또는 waiting-confirmation인 카드는 사용자 지시 없이 동시에 수정하지 않음',
    '등록된 AI 작업공간의 최신 목록·경로·상태는 폴더명이나 과거 대화로 추측하지 않고 mindnprogress_get_ai_workspace_pool로 조회함. 작업공간 선택·점유·전환·해제는 MindNProgress만 수행하며 AI가 임의로 worker를 사용하지 않음',
    '하위 카드의 기존 AI 대화를 이어갈지 새로 시작할지 판단할 때는 mindnprogress_list_ai_conversations로 후보를 먼저 비교하고, 같은 업무 흐름이며 idle이고 실행 환경이 호환되는 대화를 우선 이어감. 목적·모델·작업공간이 다르거나 문맥이 독립되어야 할 때만 새 대화를 선택',
    '복수의 독립적인 완료 조건이 있는 업무를 위임할 때 상위 AI가 위임 전에 필요한 최소한의 결과 중심 체크리스트를 확인함. 누락된 경우 하위 AI가 실제 작업 전에 작성하고 진행에 맞춰 갱신하며, 개수를 맞추기 위해 억지로 나누거나 별도 하위 카드의 작업을 중복하지 않음',
    'mindnprogress_delegate_ai_work의 위임 기준은 AionUi 대화 ID에 영속 기록된 시작 카드로 고정되며, MCP 재연결·프로세스 재생성이나 다른 카드의 get_context 추가 조회에도 바뀌지 않음. 직계 자식뿐 아니라 모든 깊이의 계층상 하위 카드에 위임 가능',
    'AI 위임이 recovery-required 또는 integration-recovery-required이면 AionCore 재시작, 재시도 가능한 연결 끊김 또는 필수 체크포인트·통합 실패로 이전 실행을 명시적으로 이어야 하는 상태임. 원 지시를 자동 반복하거나 새 위임을 만들지 말고 mindnprogress_recover_ai_delegation으로 기존 대화와 작업공간을 재개함',
    '현재 위임 실행이 사용자의 중지로 끊긴 뒤 같은 AI 대화에서 직접 이어 실제 작업을 완료했다면 카드 결과와 필요한 작업공간 체크포인트까지 마친 마지막 턴에서 최종 답변 직전에 mindnprogress_complete_ai_delegation을 호출함. 같은 대화의 과거 위임이 중지된 적이 있더라도 현재 위임이 중단 없이 진행됐다면 호출하지 않음. 도구가 required=false를 반환하면 오류가 아니며 최종 답변을 마치면 자동으로 상위 AI에 보고됨. mindnprogress_recover_ai_delegation으로 시작한 복구 operation도 다시 중지된 경우에만 같은 규칙을 적용함',
    '하위 작업 결과로 자동 재개된 턴에서 다음 작업을 위임하기로 판단하면 최종 응답 전에 mindnprogress_delegate_ai_work를 실제로 호출하고 성공 결과를 확인함. 실제 호출 없이 “위임하겠습니다” 또는 “이어서 진행하겠습니다”와 같은 미래형 약속으로 턴을 끝내지 않으며, 위임할 수 없으면 차단 원인과 필요한 조치를 현재 응답에 명시함',
    'AI 작업공간 pool에 등록된 Unity 프로젝트의 독립 하위 작업은 MindNProgress가 서로 다른 worker, 브랜치와 lease를 배정하므로 병렬 위임할 수 있음. 가용 worker가 없으면 위임은 waiting-workspace로 서버에 보존되고 worker 회수 후 FIFO로 자동 시작되므로 같은 요청을 재시도하지 않음. 통합 작업공간에 커밋되지 않은 추적 변경이 있으면 waiting-integration-clean으로 보존되며 이 상태에서는 하위 AI 전문이 아직 전달되지 않음. 차단 파일을 사용자와 상위 AI에 알리고 작업공간이 깨끗해지면 같은 위임을 자동 시작하므로 재위임하지 않음. 등록된 pool 작업은 lease 없이 AionCore에 전달되지 않음. 중지된 위임을 resume하면 같은 AI 대화와 기존 worker lease 및 변경을 이어서 사용하고, 같은 카드·대화에 다른 활성 위임이 있으면 중복 실행하지 않음. 완료 결과는 체크포인트 후 main에 직렬 통합됨. 통합 충돌은 main을 건드리지 않고 해당 작업을 수행한 같은 AI 대화를 worker 통합 브랜치에서 재개해 해결·검증하며, 통합이 끝난 뒤에만 상위 대화를 재개함. pool 미등록 프로젝트만 같은 작업공간 충돌을 피하도록 순차 위임함',
    'AI worker에서 Unity Play, 재임포트, 동적 폰트·Atlas 생성 등 검증을 시작하기 전에 mindnprogress_checkpoint_ai_workspace로 의도한 변경 경로와 실제 변경을 설명하는 구조화 commitMessage를 함께 고정함. summary에는 [김용민] prefix나 [MnP] 출처를 넣지 않고 background, cause, changes를 구체적으로 작성하며 scope는 필요한 경우에만 작성함. 서버가 현재 문서·카드 제목과 안정적인 mapId·cardId 및 상대 경로로 [MnP] 섹션을 생성함. 파일 변경이 없는 조사·검증 작업은 mindnprogress_confirm_ai_workspace_no_changes로 확인함. 검증 후 보완했다면 새 변경 내용에 맞는 commitMessage로 다시 체크포인트를 만들고 검증함. 체크포인트 이후 자동 변경은 main 통합에서 제외됨',
    '조회 도구는 문서 version을 변경하지 않으며 카드·관계 편집과 AI 대화 ID 연결 같은 저장 작업만 version을 증가시킴',
    '기존 문서 변경은 최신 version을 기준으로 수행하고 버전 충돌 시 최신 상태를 다시 조회',
    '변경 후 mindnprogress_get_document로 저장 결과를 검증하고 실제 변경 내용을 요약',
    '의미 있는 진행·차단·완료는 요약과 상세로 구분한 댓글로 기록하고, 재사용할 결론은 sharedKnowledge에도 반영',
    '댓글 summary는 [진행](수행 내용·현재 상태·다음 단계), [차단](차단 원인·재개 조건), [결과](완료 내용·검증 결과·산출물) 머리말로 시작하는 1~2문장으로 작성하고, 등록 전에 최근 댓글을 확인해 같은 내용을 반복하지 않음',
    '댓글 detail은 다른 세션이 작업을 이어가거나 결과를 검증하는 데 필요한 수행 내용, 판단, 변경 범위, 검증 방법과 실제 결과, 산출물, 제한사항, 다음 단계 또는 재개 조건 중 해당 내용을 구체적으로 기록하며 summary가 있다는 이유로 상세를 축약하지 않음',
    '코드·문서·카드 변경, 외부 시스템 처리, 검증, 중요한 결정, 실패 또는 차단이 있으면 detail을 작성하고, 새로운 사실이 없는 단순 상태 알림에만 생략. 개별 도구 호출 목록, 의미 없는 반복, 원문 로그 전체와 카드 본문의 단순 복사는 제외',
    'waitingItems가 해제되면 서버가 관련 사용자에게 알림을 자동 생성하므로 별도 알림 요청은 불필요',
    'waitingItems를 등록할 때는 [차단] 댓글에 대기 이유와 재개 조건을, 해제할 때는 [진행] 댓글에 해제 사실과 다음 단계를 기록',
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
  const {
    aiMapId,
    aiCardId,
    aiAttributionToken,
    aiEditorId,
    aiType,
    aiModel,
    timeoutMs = 10_000,
    requestAttributionContinuation,
    allowUnresolvedAttribution = false,
    ...requestInit
  } = init
  if (aionUiConversationId
    && activeResolvedAttributionExpiresAt > 0
    && activeResolvedAttributionExpiresAt <= Date.now() + 1_000) {
    activeAttributionToken = ''
    activeResolvedAttributionExpiresAt = 0
  }
  const pathnameMapId = pathname.match(/^\/api\/maps\/([^/?]+)/)?.[1]
  const scopedMapId = String(aiMapId ?? (pathnameMapId ? decodeURIComponent(pathnameMapId) : '')).trim()
  const scopedCardId = String(aiCardId ?? (scopedMapId && scopedMapId === activeMapId ? activeCardId : '')).trim()
  let scopedAttributionToken = String(aiAttributionToken ?? activeAttributionToken).trim()
  const scopedEditorId = String(aiEditorId ?? activeEditorId).trim()
  const scopedAiType = String(aiType ?? activeAiType).trim()
  const scopedAiModel = String(aiModel ?? activeAiModel).trim()
  const requestMethod = String(requestInit.method ?? 'GET').toUpperCase()
  const mutatesState = !['GET', 'HEAD', 'OPTIONS'].includes(requestMethod)
  if (!allowUnresolvedAttribution
    && mutatesState
    && aionUiConversationId
    && !scopedAttributionToken
    && !(scopedAiType && scopedAiModel)) {
    try {
      await resolveCurrentAionUiConversationAttribution({
        mapId: scopedMapId,
        cardId: scopedCardId,
        editorId: scopedEditorId,
      })
    } catch {
      // 아래의 일관된 오류로 쓰기를 차단하고, 원인은 상태에 보존합니다.
    }
    scopedAttributionToken = String(activeAttributionToken).trim()
    if (!scopedAttributionToken) {
      const detail = activeAttributionResolutionFailure?.message
        ?? 'AionUi에서 현재 대화의 AI 종류와 모델을 확인하지 못했습니다. 모델 정보를 확인한 뒤 다시 시도하세요.'
      const error = new Error(`AI_ATTRIBUTION_UNRESOLVED: ${detail}`)
      error.code = 'AI_ATTRIBUTION_UNRESOLVED'
      throw error
    }
  }
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    ...requestInit,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(scopedAttributionToken ? { 'X-MNP-AI-Attribution': scopedAttributionToken } : {}),
      ...(scopedEditorId ? { 'X-MNP-AI-Editor-Id': scopedEditorId } : {}),
      ...(!scopedAttributionToken && scopedAiType && scopedAiModel
        ? { 'X-MNP-AI-Type': scopedAiType, 'X-MNP-AI-Model': scopedAiModel }
        : {}),
      ...(scopedMapId ? { 'X-MNP-AI-Map-Id': scopedMapId } : {}),
      ...(scopedCardId ? { 'X-MNP-AI-Card-Id': scopedCardId } : {}),
      ...(aionUiConversationId ? { 'X-MNP-AI-Conversation-Id': aionUiConversationId } : {}),
      ...(requestAttributionContinuation ? { 'X-MNP-AI-Request-Attribution-Continuation': 'true' } : {}),
      ...(requestInit.body ? { 'Content-Type': 'application/json' } : {}),
      ...requestInit.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const responseText = await response.text()
  let body = null
  if (responseText) {
    try {
      body = JSON.parse(responseText)
    } catch {
      if (!response.ok) throw new Error(`MindNProgress 요청 실패 (${response.status})`)
      body = { ok: true, status: response.status }
    }
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? `MindNProgress 요청 실패 (${response.status})`)
    error.status = response.status
    error.code = body?.code
    throw error
  }
  const result = body ?? { ok: true, status: response.status }
  if (requestAttributionContinuation && result && typeof result === 'object') {
    const continuationToken = String(response.headers.get('x-mnp-ai-attribution-continuation') ?? '').trim()
    if (continuationToken.length >= 32 && continuationToken.length <= 200) {
      Object.defineProperty(result, attributionContinuationToken, { value: continuationToken })
    }
  }
  return result
}

async function resolveCurrentAionUiConversationAttribution({ mapId, cardId, editorId }) {
  if (!aionUiConversationId || activeAttributionToken || (activeAiType && activeAiModel)) return null
  if (activeAttributionResolutionPromise) return activeAttributionResolutionPromise
  const hasDocumentScope = Boolean(mapId && cardId)

  activeAttributionResolutionPromise = (async () => {
    try {
      const result = await apiRequest('/api/integrations/aionui/conversation-attribution/resolve', {
        method: 'POST',
        aiMapId: hasDocumentScope ? mapId : '',
        aiCardId: hasDocumentScope ? cardId : '',
        aiEditorId: editorId,
        aiAttributionToken: '',
        aiType: '',
        aiModel: '',
        allowUnresolvedAttribution: true,
        body: JSON.stringify({}),
      })
      const attributionToken = String(result?.attributionToken ?? '').trim()
      if (attributionToken.length < 32 || attributionToken.length > 200) {
        const error = new Error('MindNProgress가 현재 AionUi 대화의 AI 작성자 귀속 토큰을 발급하지 못했습니다.')
        error.code = 'AI_ATTRIBUTION_UNRESOLVED'
        throw error
      }
      activeAttributionToken = attributionToken
      activeResolvedAttributionExpiresAt = Number.isFinite(Number(result?.expiresAt)) ? Number(result.expiresAt) : 0
      activeAiType = ''
      activeAiModel = ''
      activeAttributionResolutionFailure = null
      return result
    } catch (error) {
      activeAttributionResolutionFailure = {
        code: error?.code ?? 'AI_ATTRIBUTION_UNRESOLVED',
        message: error instanceof Error
          ? error.message
          : 'AionUi에서 현재 대화의 AI 종류와 모델을 확인하지 못했습니다.',
      }
      throw error
    } finally {
      activeAttributionResolutionPromise = null
    }
  })()
  return activeAttributionResolutionPromise
}

function rememberDelegationOrigin({ mapId, cardId, editorId, attributionToken, aiType, aiModel }) {
  if (delegationOrigin) return
  delegationOrigin = {
    mapId,
    cardId,
    editorId: editorId ?? '',
    attributionToken: attributionToken ?? '',
    aiType: attributionToken ? '' : (aiType ?? ''),
    aiModel: attributionToken ? '' : (aiModel ?? ''),
  }
}

function adoptAttributionContinuation(result, scope = null) {
  const continuationToken = result?.[attributionContinuationToken]
  if (!continuationToken) return
  activeAttributionToken = continuationToken
  activeResolvedAttributionExpiresAt = 0
  activeAiType = ''
  activeAiModel = ''
  if (scope && delegationOrigin?.mapId === scope.mapId && delegationOrigin?.cardId === scope.cardId) {
    delegationOrigin.attributionToken = continuationToken
    delegationOrigin.aiType = ''
    delegationOrigin.aiModel = ''
  }
}

function delegationOriginForMap(mapId) {
  if (delegationOrigin?.mapId === mapId) return delegationOrigin
  if (aionUiConversationId) {
    return {
      mapId,
      cardId: '',
      editorId: activeEditorId,
      attributionToken: activeAttributionToken,
      aiType: activeAiType,
      aiModel: activeAiModel,
    }
  }
  throw new Error('현재 대화가 시작된 카드 범위를 확인할 수 없습니다. 이 대화가 시작된 카드로 mindnprogress_get_context를 먼저 호출해 주세요.')
}

function runCommentWithAttribution(operation) {
  const queued = commentAttributionQueue.catch(() => undefined).then(operation)
  commentAttributionQueue = queued.then(() => undefined, () => undefined)
  return queued
}

// 응답은 AI가 소비하므로 압축이 기본이다. 들여쓰기는 구조 파악에 도움이 되지 않고 토큰만 늘린다.
// 사람이 직접 읽어야 하는 도구에서만 prettyResult로 명시한다.
function toolResult(value, pretty = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, pretty ? 2 : 0) }] }
}

function documentAccessUrl(publicBaseUrl, mapId) {
  return `${String(publicBaseUrl).replace(/\/+$/, '')}/mindmap/${encodeURIComponent(mapId)}`
}

function cardAccessUrl(publicBaseUrl, mapId, cardId) {
  return `${documentAccessUrl(publicBaseUrl, mapId)}/${encodeURIComponent(cardId)}`
}

function registerTool(server, name, description, schema, handler, options = {}) {
  toolUsage?.declare(name)
  server.tool(name, description, schema, async (input) => {
    try {
      const result = toolResult(await handler(input), options.prettyResult === true)
      toolUsage?.record(name, { ok: true, chars: toolResultLength(result) })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'
      toolUsage?.record(name, { ok: false, chars: message.length })
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
      }
    }
  })
}

function resolveAliasedId(preferredValue, legacyValue, {
  preferredName,
  legacyName,
  required = true,
}) {
  if (preferredValue !== undefined && legacyValue !== undefined && preferredValue !== legacyValue) {
    throw new Error(`${preferredName}와 호환용 ${legacyName}의 값이 서로 다릅니다.`)
  }
  const resolved = preferredValue ?? legacyValue
  if (required && resolved === undefined) {
    throw new Error(`${preferredName}를 입력해 주세요.`)
  }
  return resolved
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

async function mutateDocument(mapId, aiCardId, mutation, maxAttempts = 3) {
  let lastError = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const map = await getDocument(mapId)
    const result = mutation(map)
    try {
      const saved = await saveDocument(map, false, aiCardId)
      return { saved, result }
    } catch (error) {
      lastError = error
      if (error?.code !== 'VERSION_CONFLICT' || attempt === maxAttempts - 1) throw error
    }
  }
  throw lastError ?? new Error('문서를 변경하지 못했습니다.')
}

function isKnowledgeEdge(edge) {
  return edge?.data?.relation === 'knowledge'
}

function isHierarchyEdge(edge) {
  return !isKnowledgeEdge(edge)
}

function knowledgePolicyOf(edge) {
  return edge?.data?.knowledgePolicy === 'inspect-if-insufficient' ? 'inspect-if-insufficient' : 'reuse-first'
}

function createsKnowledgeCycle(sourceId, targetId, edges) {
  if (sourceId === targetId) return true
  const knowledgeEdges = edges.filter(isKnowledgeEdge)
  const visited = new Set()
  const stack = [targetId]
  while (stack.length > 0) {
    const currentId = stack.pop()
    if (!currentId || visited.has(currentId)) continue
    if (currentId === sourceId) return true
    visited.add(currentId)
    knowledgeEdges
      .filter((edge) => edge.source === currentId)
      .forEach((edge) => stack.push(edge.target))
  }
  return false
}

function descendantsOf(nodeId, edges) {
  const hierarchyEdges = edges.filter(isHierarchyEdge)
  const result = new Set()
  const stack = hierarchyEdges.filter((edge) => edge.source === nodeId).map((edge) => edge.target)
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || result.has(current)) continue
    result.add(current)
    hierarchyEdges.filter((edge) => edge.source === current).forEach((edge) => stack.push(edge.target))
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
    sharedKnowledge: node.data?.sharedKnowledge ?? '',
    waitingItems: Array.isArray(node.data?.waitingItems) ? node.data.waitingItems : [],
  }))
}

function compactCard(node) {
  return {
    id: node.id,
    label: node.data?.label ?? node.id,
    kind: node.data?.kind,
    status: node.data?.progress >= 100 ? 'done' : node.data?.status,
    progress: node.data?.progress ?? 0,
    isWork: Boolean(node.data?.isWork),
    waitingItems: Array.isArray(node.data?.waitingItems)
      ? node.data.waitingItems.map(({ id, label, resumeCondition, since }) => ({ id, label, resumeCondition, since }))
      : [],
  }
}

function compactRelatedCards(ids, nodes) {
  const idSet = new Set(ids)
  return nodes.filter((node) => idSet.has(node.id)).map(compactCard)
}

function contentCard(node, mapId = '') {
  const imageAccess = imageCardLocalAccess(dataDirectory, mapId, node)
  const data = { ...(node.data ?? {}) }
  const aiConversationCount = Array.isArray(data.aiConversations) ? data.aiConversations.length : data.aiConversationId ? 1 : 0
  delete data.aiConversations
  if (aiConversationCount > 0) data.aiConversationCount = aiConversationCount
  return {
    id: node.id,
    type: node.type ?? 'mind',
    data,
    textIntegrity: cardTextIntegrity(data),
    ...(imageAccess ? { imageAccess } : {}),
  }
}

function updateCardFullNode(node) {
  const data = { ...(node.data ?? {}) }
  const aiConversationCount = Array.isArray(data.aiConversations) ? data.aiConversations.length : data.aiConversationId ? 1 : 0
  delete data.aiConversations
  if (aiConversationCount > 0) data.aiConversationCount = aiConversationCount
  return {
    id: node.id,
    position: node.position,
    data,
  }
}

function updateCardFullEdge(edge) {
  const relation = isKnowledgeEdge(edge) ? 'knowledge' : 'hierarchy'
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    data: {
      relation,
      ...(relation === 'knowledge' ? { knowledgePolicy: knowledgePolicyOf(edge) } : {}),
    },
  }
}

function updateCardFullMap(map) {
  return {
    id: map.id,
    title: map.title,
    color: map.color,
    version: map.version,
    updatedAt: map.updatedAt,
    updatedBy: map.updatedBy,
    nodes: map.nodes.map(updateCardFullNode),
    edges: map.edges.map(updateCardFullEdge),
  }
}

function changedCardIds(previousMap, savedMap) {
  const previousNodes = new Map(previousMap.nodes.map((node) => [node.id, JSON.stringify(node)]))
  return savedMap.nodes
    .filter((node) => previousNodes.get(node.id) !== JSON.stringify(node))
    .map((node) => node.id)
}

function rootCardOf(map) {
  const hierarchyTargets = new Set(map.edges.filter(isHierarchyEdge).map((edge) => edge.target))
  return map.nodes.find((item) => item.data?.kind === 'root' && !hierarchyTargets.has(item.id))
    ?? map.nodes.find((item) => item.data?.kind === 'root')
    ?? map.nodes.find((item) => !hierarchyTargets.has(item.id))
    ?? map.nodes[0]
}

function rootRollup(rootCard) {
  if (!rootCard) return null
  return {
    id: rootCard.id,
    label: rootCard.data?.label ?? rootCard.id,
    status: rootCard.data?.progress >= 100 ? 'done' : rootCard.data?.status,
    progress: rootCard.data?.progress ?? 0,
  }
}

const affectedFirstResponseModeDescription = 'affected가 기본이며 변경된 카드와 문서·Root 요약만 반환합니다. 변경 전과 같은 API 원본 전체 문서가 필요할 때만 full을 지정하거나 mindnprogress_get_document를 호출하세요.'

function affectedCardsOf(previousMap, savedMap, mapId, requestedCardIds, rootCardId, excludedCardIds = []) {
  const requested = new Set(requestedCardIds)
  const excluded = new Set(excludedCardIds)
  const affectedIds = new Set([...requested, ...changedCardIds(previousMap, savedMap)])
  return savedMap.nodes
    .filter((item) => affectedIds.has(item.id) && !excluded.has(item.id))
    .map((item) => ({
      reason: requested.has(item.id) ? 'requested' : item.id === rootCardId ? 'root-rollup' : 'server-adjusted',
      card: {
        ...contentCard(item, mapId),
        position: item.position,
      },
    }))
}

function deletedRelationsOf(map, deletedCardIds, targetCardId) {
  const deleted = new Set(deletedCardIds)
  return {
    previousParentCardId: map.edges
      .find((edge) => isHierarchyEdge(edge) && edge.target === targetCardId)?.source ?? null,
    detachedChildCardIds: [...new Set(map.edges
      .filter((edge) => isHierarchyEdge(edge) && edge.source === targetCardId && !deleted.has(edge.target))
      .map((edge) => edge.target))],
    removedKnowledgeLines: map.edges
      .filter((edge) => isKnowledgeEdge(edge) && (deleted.has(edge.source) || deleted.has(edge.target)))
      .map((edge) => ({
        id: edge.id,
        sourceCardId: edge.source,
        targetCardId: edge.target,
        knowledgePolicy: knowledgePolicyOf(edge),
      })),
  }
}

function focusedDocument(map, publicBaseUrl) {
  const hierarchyEdges = map.edges.filter(isHierarchyEdge)
  const knowledgeEdges = map.edges.filter(isKnowledgeEdge)
  return {
    id: map.id,
    title: map.title,
    color: map.color,
    version: map.version,
    updatedAt: map.updatedAt,
    updatedBy: map.updatedBy,
    accessUrl: documentAccessUrl(publicBaseUrl, map.id),
    stats: {
      cardCount: map.nodes.length,
      hierarchyEdgeCount: hierarchyEdges.length,
      knowledgeEdgeCount: knowledgeEdges.length,
    },
    outline: map.nodes.map((node) => {
      const parentId = hierarchyEdges.find((edge) => edge.target === node.id)?.source ?? null
      return {
        ...compactCard(node),
        parentId,
        childCount: hierarchyEdges.filter((edge) => edge.source === node.id).length,
        blockedByIds: Array.isArray(node.data?.blockedBy) ? node.data.blockedBy : [],
      }
    }),
    knowledgeLinks: knowledgeEdges.map((edge) => ({
      sourceId: edge.source,
      targetId: edge.target,
      policy: knowledgePolicyOf(edge),
    })),
  }
}

function paginateComments(comments, { offset = 0, limit = 50, order = 'desc' } = {}) {
  const ordered = order === 'asc' ? comments : [...comments].reverse()
  const items = ordered.slice(offset, offset + limit)
  const nextOffset = offset + items.length
  return {
    items,
    page: {
      total: comments.length,
      offset,
      limit,
      order,
      hasMore: nextOffset < comments.length,
      nextOffset: nextOffset < comments.length ? nextOffset : null,
    },
  }
}

function focusedCommentWindow(comments, mapId, cardId) {
  const items = comments.slice(-contextCommentLimit)
  const hasMore = comments.length > items.length
  const hasDetail = items.some((comment) => comment.hasDetail === true)
  return {
    comments: items,
    commentsPage: {
      total: comments.length,
      included: items.length,
      order: 'asc',
      hasMore,
      tool: 'mindnprogress_list_comments',
      detailToolArguments: hasDetail ? {
        mapId,
        cardId,
        offset: 0,
        limit: Math.max(1, items.length),
        order: 'desc',
        includeDetail: true,
      } : null,
      nextToolArguments: hasMore ? {
        mapId,
        cardId,
        offset: items.length,
        limit: 50,
        order: 'desc',
        includeDetail: false,
      } : null,
    },
  }
}

function compactTeamMember(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active !== false,
  }
}

const mapIdSchema = { mapId: z.string().min(1).describe('문서 ID') }

const checkpointCommitMessageSchema = z.object({
  summary: z.string().min(1).max(80)
    .describe('실제 변경을 설명하는 커밋 제목. [김용민] prefix는 서버가 추가하므로 포함하지 않음'),
  background: z.string().min(1).max(2000)
    .describe('왜 이 변경이 필요한지 설명하는 [배경] 본문'),
  cause: z.string().min(1).max(2000)
    .describe('기존 상태의 문제나 요구사항과의 차이를 설명하는 [원인] 본문'),
  changes: z.string().min(1).max(4000)
    .describe('이번 체크포인트에 포함된 실제 변경을 설명하는 [수정] 본문'),
  scope: z.string().min(1).max(2000).optional()
    .describe('영향 범위나 부작용 없음의 근거가 필요할 때 작성하는 [적용 범위] 본문'),
}).strict()
const documentColor = z.enum(['violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'amber', 'orange', 'red', 'pink'])
const knowledgePolicySchema = z.enum(['reuse-first', 'inspect-if-insufficient'])
const outlineKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/, '카드 key는 영문, 숫자, 밑줄, 하이픈만 사용할 수 있습니다.')
const waitingItemSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  label: z.string().min(1).max(120),
  note: z.string().max(1000).optional(),
  resumeCondition: z.string().max(500).optional(),
  since: z.string().datetime().optional(),
})
const documentLayoutSchema = z.object({
  version: z.literal(1),
  items: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('map'), id: z.string().min(1) }),
    z.object({ type: z.literal('group'), id: z.string().regex(/^group-[a-zA-Z0-9_-]{1,100}$/) }),
  ])).max(1100),
  groups: z.array(z.object({
    id: z.string().regex(/^group-[a-zA-Z0-9_-]{1,100}$/),
    name: z.string().min(1).max(80),
    mapIds: z.array(z.string().min(1)).max(1000),
  })).max(100),
})
const nodeDataSchema = z.object({
  label: z.string().min(1),
  description: z.string().default(''),
  sharedKnowledge: z.string().max(10_000).default(''),
  progress: z.number().min(0).max(100).default(0),
  status: z.enum(['planned', 'in-progress', 'done']).default('planned'),
  kind: z.enum(['root', 'branch', 'task', 'image']).default('branch'),
  taskUrl: z.string().optional(),
  isWork: z.boolean().optional(),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional(),
  checklist: z.array(z.object({
    id: z.string().describe('카드 안에서 유지할 고유한 체크리스트 항목 ID. 기존 항목을 갱신할 때는 조회한 ID를 보존'),
    text: z.string().describe('완료 여부를 객관적으로 판정할 수 있는 결과 중심 구현·검증 항목'),
    done: z.boolean().describe('항목 완료 여부'),
  })).optional().describe('체크리스트 전체 배열. 이 필드를 보내면 기존 배열을 통째로 교체하며, 항목이 하나 이상이면 완료 비율로 progress와 status를 자동 계산'),
  blockedBy: z.array(z.string()).optional(),
  waitingItems: z.array(waitingItemSchema).max(20).optional(),
}).passthrough()

const cardTextPatchOperationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('replace_once'),
    find: z.string().min(1).max(100_000).describe('원문에서 정확히 한 번 일치해야 하는 문자열'),
    replace: z.string().max(100_000).describe('일치 문자열을 대신할 문자열. 삭제하려면 빈 문자열'),
  }),
  z.object({
    type: z.literal('replace_between'),
    startMarker: z.string().min(1).max(10_000).describe('원문에서 정확히 한 번 일치하는 시작 경계. 결과에 보존됨'),
    endMarker: z.string().min(1).max(10_000).describe('원문에서 정확히 한 번 일치하며 시작 경계 뒤에 있는 종료 경계. 결과에 보존됨'),
    replacement: z.string().max(100_000).describe('두 경계 사이를 대신할 문자열'),
  }),
  z.object({
    type: z.literal('append'),
    text: z.string().min(1).max(100_000).describe('기존 원문 뒤에 추가할 문자열'),
    separator: z.enum(['none', 'newline', 'blank-line']).default('blank-line').describe('기존 원문과 추가 문자열 사이의 구분자'),
  }),
])

const outlineCardSchema = z.object({
  key: outlineKey.describe('문서 안에서 고유한 카드 key'),
  parentKey: outlineKey.optional().describe('상위 카드 key. 루트 카드는 생략'),
  label: z.string().min(1).max(200),
  description: z.string().max(5000).default(''),
  sharedKnowledge: z.string().max(10_000).default(''),
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
  waitingItems: z.array(waitingItemSchema.omit({ id: true })).max(20).optional().describe('외부 전달물이나 결정을 기다리는 자유 입력 대기 목록'),
})

function normalizeWaitingItems(items) {
  if (!Array.isArray(items)) return items
  const now = new Date().toISOString()
  return items.map((item) => ({
    ...item,
    id: item.id || `wait-${randomBytes(8).toString('hex')}`,
    since: item.since || now,
  }))
}

function checklistProgressPatch(checklist) {
  if (!Array.isArray(checklist) || checklist.length === 0) return {}
  const completedCount = checklist.filter((item) => item.done).length
  const progress = Math.round((completedCount / checklist.length) * 100)
  return {
    progress,
    status: progress >= 100 ? 'done' : progress > 0 ? 'in-progress' : 'planned',
  }
}

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
    const checklistState = checklistProgressPatch(card.checklist)
    const progress = checklistState.progress ?? card.progress
    const status = checklistState.status ?? card.status ?? (progress >= 100 ? 'done' : progress > 0 ? 'in-progress' : 'planned')
    const position = positions.get(card.key)
    return {
      id: card.key,
      type: 'mind',
      position: { x: position.x, y: position.y - rootY },
      data: {
        label: card.label,
        description: card.description,
        sharedKnowledge: card.sharedKnowledge,
        progress,
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
        ...(card.waitingItems?.length && status !== 'done' ? { waitingItems: normalizeWaitingItems(card.waitingItems) } : {}),
      },
    }
  })
  const edges = cards.filter((card) => card.parentKey).map((card) => ({
    id: `edge-${card.parentKey}-${card.key}`,
    source: card.parentKey,
    target: card.key,
    type: 'default',
    data: { relation: 'hierarchy' },
    markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
  }))
  return { nodes, edges, rootKey: roots[0].key }
}

async function main() {
  const server = new McpServer({ name: 'MindNProgress', version: '1.0.0' }, { instructions: serverInstructions })

  registerTool(server, 'mindnprogress_list_documents', '활성 문서 목록과 버전, 완료 현황 및 좌측 목록의 문서 그룹·혼합 순서를 조회합니다.', {}, async () =>
    apiRequest('/api/maps'))

  registerTool(server, 'mindnprogress_list_shared_knowledge_candidates', '전체 문서 또는 한 문서에서 정리가 필요한 sharedKnowledge 후보를 원문 없이 조회합니다. 우선순위, 길이, SHA-256, 반복 문장 수, 검토 상태와 지식선 소비자 수를 반환하며 accepted-long 승인도 30일이 지나면 다시 후보로 포함합니다. 문서 버전은 변경하지 않습니다.', {
    mapId: z.string().min(1).optional().describe('한 문서만 조회할 때 지정하는 문서 ID'),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
  }, async ({ mapId, offset, limit }) => {
    const query = new URLSearchParams()
    if (mapId) query.set('mapId', mapId)
    const result = await apiRequest(`/api/shared-knowledge/audit${query.size > 0 ? `?${query}` : ''}`)
    const candidates = result.audit.candidates.slice(offset, offset + limit)
    const nextOffset = offset + candidates.length
    return {
      generatedAt: result.audit.generatedAt,
      thresholds: result.audit.thresholds,
      maintenance: result.audit.maintenance,
      summary: result.audit.summary,
      candidates,
      page: {
        total: result.audit.candidates.length,
        offset,
        limit,
        hasMore: nextOffset < result.audit.candidates.length,
        nextOffset: nextOffset < result.audit.candidates.length ? nextOffset : null,
      },
    }
  })

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
      'description은 업무 요청과 완료 조건, sharedKnowledge는 다른 카드가 재사용할 안정적인 결론에 사용',
      'sharedKnowledge에는 현재 유효한 재사용 결론만 남기고 진행 기록·도구 로그·중복·폐기 결론은 댓글과 분리하며 같은 주제의 결론은 새 이력 대신 기존 절을 교체',
      '정리 후보가 있으면 주 1회와 주요 마일스톤·인수인계 시점에 점검하되 자동 변경 없이 카드별로 승인하고 accepted-long은 30일 뒤 다시 검토',
      '외부 전달물이나 결정 대기는 waitingItems에 기록하고 카드 제목에는 대기 문구를 추가하지 않음',
      '카드 일부 필드만 변경할 때는 mindnprogress_update_card에 변경할 필드만 전달하고 현재 카드 전체 데이터를 재전송하지 않음',
      '기존 description 또는 sharedKnowledge 내부만 고칠 때는 조회 결과의 textIntegrity SHA-256과 mindnprogress_patch_card_text를 사용',
      '과도한 sharedKnowledge 정리는 후보 목록과 전용 문맥을 조회한 뒤 해시 조건부 검토 도구로 저장',
    '선택 카드 이외의 관련 카드를 수정하기 전에는 mindnprogress_get_ai_work_states로 다른 AI 작업과의 충돌 여부를 확인',
    '하위 카드의 기존 AI 대화를 이어갈지 새로 시작할지 판단할 때는 mindnprogress_list_ai_conversations로 후보를 먼저 비교하고, 같은 업무 흐름이며 idle이고 실행 환경이 호환되는 대화를 우선 이어감. 목적·모델·작업공간이 다르거나 문맥이 독립되어야 할 때만 새 대화를 선택',
      '지식선만 변경할 때는 전체 문서를 다시 보내지 않고 지식선 전용 도구를 사용',
      '조회 도구는 문서 version을 올리지 않지만 편집 도구와 AI 대화 ID 연결은 version을 올릴 수 있음',
      '업무 링크, 담당자와 마감일은 실제 값이 있을 때만 지정',
      '비밀번호 변경과 관리자 계정 관리는 MCP에서 지원하지 않음',
    ],
  }))

  registerTool(server, 'mindnprogress_get_context', 'MindNProgress의 제품 개념과 작성 규칙, 최신 문서 개요, 선택 카드와 업무 링크, 계층·의존성·댓글·담당자 정보를 한 번에 조회합니다. focused는 작업 관련 원문과 문서 개요를, full은 전체 문서 원문을 반환합니다. 대화를 시작한 뒤 다른 MindNProgress 도구보다 먼저 호출하세요. AionUi 일반 대화는 현재 대화의 AI 종류와 모델을 자동 확인합니다. AionUi가 아닌 외부 MCP 세션만 현재 AI 종류와 모델을 정확히 알고 있을 때 aiType과 aiModel을 함께 전달하세요.', {
    mapId: z.string().min(1).describe('현재 문서 ID'),
    cardId: z.string().min(1).describe('편집자가 선택한 카드 ID'),
    editorId: z.string().min(1).max(120).optional().describe('AI 대화를 시작한 MindNProgress 편집자 계정 ID'),
    attributionToken: z.string().min(32).max(200).optional().describe('MindNProgress의 AI 대화 시작 화면에서 전달된 작성자 귀속 토큰'),
    aiType: z.string().min(1).max(120).optional().describe('attributionToken이 없는 외부 MCP 세션에서 현재 AI가 직접 밝히는 AI 종류(예: Codex CLI)'),
    aiModel: z.string().min(1).max(160).optional().describe('attributionToken이 없는 외부 MCP 세션에서 현재 AI가 직접 밝히는 모델(예: GPT-5.6-Sol)'),
    detailLevel: z.enum(['focused', 'full']).default('focused').describe('focused는 선택 카드와 주요 지식 원문 및 문서 개요, full은 현재의 전체 문서 원문을 반환'),
  }, async ({ mapId, cardId, editorId, attributionToken, aiType, aiModel, detailLevel }) => {
    if ((aiType && !aiModel) || (!aiType && aiModel)) {
      throw new Error('AI 종류와 모델은 함께 지정해 주세요.')
    }
    activeMapId = mapId
    activeCardId = cardId
    activeEditorId = editorId ?? ''
    activeAttributionToken = attributionToken ?? ''
    activeResolvedAttributionExpiresAt = 0
    activeAiType = attributionToken ? '' : (aiType ?? '')
    activeAiModel = attributionToken ? '' : (aiModel ?? '')
    activeAttributionResolutionFailure = null
    let resolvedConversationAttribution = null
    if (!activeAttributionToken && !activeAiType && !activeAiModel && aionUiConversationId) {
      try {
        resolvedConversationAttribution = await resolveCurrentAionUiConversationAttribution({ mapId, cardId, editorId: activeEditorId })
      } catch {
        // 조회는 계속 허용하되 이후 쓰기는 apiRequest에서 재확인 후 차단합니다.
      }
    }
    const [documentResult, commentsResult, usersResult, health] = await Promise.all([
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}`, { aiCardId: cardId, requestAttributionContinuation: true }),
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments?includeDetail=false`),
      apiRequest('/api/assignees'),
      apiRequest('/api/health'),
    ])
    const map = documentResult.map
    const selectedCard = map.nodes.find((node) => node.id === cardId)
    if (!selectedCard) throw new Error(`선택 카드를 찾을 수 없습니다: ${cardId}`)
    rememberDelegationOrigin({
      mapId,
      cardId,
      editorId,
      attributionToken: activeAttributionToken,
      aiType: activeAiType,
      aiModel: activeAiModel,
    })
    adoptAttributionContinuation(documentResult, { mapId, cardId })

    const hierarchyEdges = map.edges.filter(isHierarchyEdge)
    const knowledgeEdges = map.edges.filter(isKnowledgeEdge)
    const parentIds = hierarchyEdges.filter((edge) => edge.target === cardId).map((edge) => edge.source)
    const childIds = hierarchyEdges.filter((edge) => edge.source === cardId).map((edge) => edge.target)
    const siblingIds = [...new Set(parentIds.flatMap((parentId) => hierarchyEdges
      .filter((edge) => edge.source === parentId && edge.target !== cardId)
      .map((edge) => edge.target)))]
    const ancestorIds = new Set()
    const ancestorStack = [...parentIds]
    while (ancestorStack.length > 0) {
      const currentId = ancestorStack.pop()
      if (!currentId || ancestorIds.has(currentId)) continue
      ancestorIds.add(currentId)
      hierarchyEdges.filter((edge) => edge.target === currentId).forEach((edge) => ancestorStack.push(edge.source))
    }
    const descendantIds = descendantsOf(cardId, hierarchyEdges)
    const blockedByIds = selectedCard.data?.blockedBy ?? []
    const blockingIds = map.nodes.filter((node) => (node.data?.blockedBy ?? []).includes(cardId)).map((node) => node.id)
    const selectedHierarchyIds = new Set([cardId, ...ancestorIds])
    const topLevelCard = map.nodes.find((node) => selectedHierarchyIds.has(node.id)
      && node.data?.kind === 'root'
      && !hierarchyEdges.some((edge) => edge.target === node.id))
      ?? map.nodes.find((node) => selectedHierarchyIds.has(node.id)
        && !hierarchyEdges.some((edge) => edge.target === node.id))
      ?? selectedCard
    const taskLinkFor = (card) => {
      const url = typeof card?.data?.taskUrl === 'string' ? card.data.taskUrl.trim() : ''
      if (!url) return null
      let provider = 'web'
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:'
          && /^(?:[a-z0-9-]+\.)+dooray\.com$/i.test(parsed.hostname)) {
          if (/^\/(?:task\/\d+\/\d+|project\/tasks\/\d+)\/?$/.test(parsed.pathname)) provider = 'dooray-task'
          else if (/^\/(?:wiki\/\d+\/\d+|project\/pages\/\d+)\/?$/.test(parsed.pathname)) provider = 'dooray-wiki'
        }
      } catch {
        provider = 'unknown'
      }
      const externalLink = card.data?.externalLink?.url === url ? card.data.externalLink : null
      return {
        cardId: card.id,
        label: card.data?.label ?? card.id,
        url,
        provider,
        ...(externalLink ? {
          preview: {
            title: externalLink.title ?? card.data?.label ?? card.id,
            resolvedAt: externalLink.resolvedAt,
            ...(externalLink.provider === 'dooray-task' ? {
              taskNumber: externalLink.taskNumber,
              workflowName: externalLink.workflowName,
              closed: externalLink.closed,
            } : {
              wikiId: externalLink.wikiId,
              pageId: externalLink.pageId,
            }),
          },
        } : {}),
      }
    }
    const selectedTaskLink = taskLinkFor(selectedCard)
    const topLevelTaskLink = taskLinkFor(topLevelCard)
    const availableTaskLinks = [
      ...(selectedTaskLink ? [{ scope: selectedCard.id === topLevelCard.id ? 'selected-and-top-level' : 'selected-card', ...selectedTaskLink }] : []),
      ...(topLevelTaskLink && topLevelCard.id !== selectedCard.id ? [{ scope: 'top-level-card', ...topLevelTaskLink }] : []),
    ]
    const startupInspectionTargets = availableTaskLinks.filter((link, index, links) =>
      links.findIndex((candidate) => candidate.url === link.url) === index)
    const allComments = commentsResult.comments ?? []
    const incomingKnowledge = knowledgeEdges
      .filter((edge) => edge.target === cardId)
      .map((edge) => {
        const sourceCard = map.nodes.find((node) => node.id === edge.source)
        if (!sourceCard) return null
        const imageAccess = imageCardLocalAccess(dataDirectory, mapId, sourceCard)
        return {
          policy: knowledgePolicyOf(edge),
          card: sourceCard,
          ...(imageAccess ? { imageAccess } : {}),
          accessUrl: cardAccessUrl(health.publicBaseUrl, map.id, sourceCard.id),
          comments: allComments.filter((comment) => comment.nodeId === sourceCard.id),
          taskLink: taskLinkFor(sourceCard),
        }
      })
      .filter(Boolean)
    const primaryKnowledge = incomingKnowledge.filter((source) => source.policy === 'reuse-first')
    const fallbackKnowledge = incomingKnowledge.filter((source) => source.policy === 'inspect-if-insufficient')
    const hasKnowledgeGuidance = incomingKnowledge.length > 0
    const conversationInspectionSources = primaryKnowledge
      .filter((source) => typeof source.card.data?.aiConversationId === 'string' && source.card.data.aiConversationId.trim())
      .map((source) => ({
        cardId: source.card.id,
        label: source.card.data?.label ?? source.card.id,
        conversationAvailable: true,
        toolArguments: { mapId, cardId: source.card.id },
      }))
    const conversationInspection = {
      mode: conversationInspectionSources.length > 0 ? 'on-demand' : 'unavailable',
      required: false,
      tool: 'mindnprogress_get_ai_conversation_transcript',
      sources: conversationInspectionSources,
      triggers: [
        '공유 지식, 설명과 댓글만으로 현재 작업에 필요한 결정 근거가 부족함',
        '예외 조건 또는 이전 실패 원인을 확인해야 함',
        '공유 지식과 댓글이 서로 충돌하여 원래 대화 맥락이 필요함',
        '사용자가 과거 AI 대화를 직접 확인하도록 요청함',
      ],
      instruction: conversationInspectionSources.length > 0
        ? 'primarySources의 sharedKnowledge, 설명과 댓글을 먼저 사용하세요. 그래도 현재 작업에 필요한 결정 근거, 예외 조건 또는 이전 실패 원인이 구체적으로 부족할 때만 sources 중 필요한 카드의 toolArguments로 대화 기록을 조회하세요.'
        : '대화가 연결된 주요 선행 지식 카드가 없습니다. 공유 지식, 설명과 댓글을 사용하고 대화 기록 도구를 호출하지 마세요.',
      evidenceRule: '대화 내용은 보조 근거로 취급합니다. 실제 코드와 산출물로 검증하고, 대화 전문을 댓글이나 sharedKnowledge에 복사하지 말며, 검증된 재사용 가능 결론만 sharedKnowledge에 요약하세요.',
    }
    const knowledgePrimaryTargets = selectedTaskLink ? [{
      scope: selectedCard.id === topLevelCard.id ? 'selected-and-top-level' : 'selected-card',
      reason: '현재 카드에 직접 연결된 업무 요구사항 확인',
      ...selectedTaskLink,
    }] : []
    const knowledgeFallbackTargets = [
      ...incomingKnowledge.flatMap((source) => source.taskLink ? [{
        scope: source.policy === 'reuse-first' ? 'primary-knowledge-source' : 'fallback-knowledge-source',
        reason: source.policy === 'reuse-first' ? '카드 결과와 댓글만으로 부족할 때 원본 확인' : '주요 지식만으로 부족할 때 확인',
        ...source.taskLink,
      }] : []),
      ...(topLevelTaskLink && topLevelCard.id !== selectedCard.id ? [{
        scope: 'top-level-card',
        reason: '선행 지식과 현재 카드 업무만으로 전체 배경이 부족할 때 확인',
        ...topLevelTaskLink,
      }] : []),
    ].filter((link, index, links) =>
      !knowledgePrimaryTargets.some((candidate) => candidate.url === link.url)
      && links.findIndex((candidate) => candidate.url === link.url) === index)
    const startupInspection = hasKnowledgeGuidance ? {
      mode: 'knowledge-guided',
      required: knowledgePrimaryTargets.length > 0,
      targets: knowledgePrimaryTargets,
      primarySources: primaryKnowledge.map((source) => ({
        cardId: source.card.id,
        label: source.card.data?.label ?? source.card.id,
        kind: source.card.data?.kind,
        ...(source.imageAccess ? { imageAccess: source.imageAccess } : {}),
      })),
      fallbackSources: fallbackKnowledge.map((source) => ({
        cardId: source.card.id,
        label: source.card.data?.label ?? source.card.id,
        kind: source.card.data?.kind,
        ...(source.imageAccess ? { imageAccess: source.imageAccess } : {}),
      })),
      fallbackTargets: knowledgeFallbackTargets,
      conversationInspection,
      checks: ['현재 카드에 직접 연결된 업무 요구사항', '이미지 선행 지식의 원본과 설명', '일반 선행 지식 카드의 공유 지식과 설명', '선행 지식 카드의 댓글'],
      instruction: 'primarySources 중 kind=image인 항목은 imageAccess.localPath의 원본 파일을 사용 가능한 로컬 이미지 열람 도구로 직접 확인하고 설명과 댓글을 함께 사용하세요. 일반 카드는 sharedKnowledge를 먼저 재사용하고 설명과 댓글로 보완합니다. targets는 현재 카드에 직접 연결된 업무가 있을 때만 조사하며 최상위 업무와 선행 지식 원본을 처음부터 다시 조사하지 마세요.',
      fallback: '현재 작업에 필요한 정보가 구체적으로 부족할 때만 fallbackSources와 fallbackTargets에서 필요한 범위를 선택적으로 확인하세요. 외부 업무 도구가 없거나 조회에 실패하면 확인된 카드와 댓글로 가능한 작업은 계속 진행하세요.',
    } : {
      mode: 'default',
      required: startupInspectionTargets.length > 0,
      targets: startupInspectionTargets,
      fallbackTargets: [],
      conversationInspection: {
        mode: 'not-applicable',
        required: false,
        tool: 'mindnprogress_get_ai_conversation_transcript',
        sources: [],
        instruction: '선행 지식선이 없어 대화 기록을 주요 지식으로 조회하지 않습니다.',
      },
      checks: ['업무 제목과 본문', '댓글과 대화 내용', '첨부파일 목록', '본문과 댓글에 포함된 관련 링크'],
      instruction: '선택 카드의 작업을 수행하기 전에 targets의 업무를 조사하여 배경, 목적, 요구사항, 제약과 관련 자료를 파악하세요. 기획서나 첨부파일이 있다고 가정하지 말고 본문에 간략한 요구사항만 있을 가능성도 고려하세요.',
      fallback: 'targets가 없으면 MindNProgress 카드 정보로 진행합니다. 외부 업무 시스템 도구가 없거나 조회에 실패하면 임의로 추측하지 말고 조회하지 못한 대상과 원인을 알린 뒤, 확인된 카드 정보만으로 가능한 작업은 계속 진행하세요.',
    }

    const selectedComments = allComments.filter((comment) => comment.nodeId === cardId)
    const focusedSelectedComments = focusedCommentWindow(selectedComments, mapId, cardId)
    const focusedPrimaryKnowledge = primaryKnowledge.map((source) => ({
      policy: source.policy,
      card: contentCard(source.card),
      ...(source.imageAccess ? { imageAccess: source.imageAccess } : {}),
      accessUrl: source.accessUrl,
      ...focusedCommentWindow(source.comments, mapId, source.card.id),
      taskLink: source.taskLink,
      detailTool: 'mindnprogress_get_card',
      detailToolArguments: { mapId, cardId: source.card.id, includeCommentDetail: true },
    }))
    const focusedFallbackKnowledge = fallbackKnowledge.map((source) => ({
      policy: source.policy,
      card: compactCard(source.card),
      ...(source.imageAccess ? { imageAccess: source.imageAccess } : {}),
      accessUrl: source.accessUrl,
      comments: [],
      commentsPage: {
        total: source.comments.length,
        included: 0,
        order: 'asc',
        hasMore: source.comments.length > 0,
        tool: 'mindnprogress_list_comments',
        nextToolArguments: source.comments.length > 0
          ? { mapId, cardId: source.card.id, offset: 0, limit: 50, order: 'desc', includeDetail: true }
          : null,
      },
      taskLink: source.taskLink,
      detailTool: 'mindnprogress_get_card',
      detailToolArguments: { mapId, cardId: source.card.id, includeCommentDetail: true },
    }))
    const taskLinks = {
      selectedCard: selectedTaskLink,
      topLevelCard: topLevelTaskLink,
      available: availableTaskLinks,
      startupInspection,
      rule: hasKnowledgeGuidance
        ? '지식선이 있으므로 현재 카드의 직접 업무와 선행 지식을 우선합니다. 최상위 업무와 지식 원본 링크는 부족할 때만 선택적으로 조사하며 링크를 다른 카드 데이터에 상속하거나 복사하지 않습니다.'
        : '선택 카드와 최상위 카드의 업무 링크를 독립적으로 유지합니다. 작업 시작 전에 startupInspection을 따르며, 두 링크가 모두 있으면 중복 URL을 제외하고 모두 조사합니다. 링크를 다른 카드 데이터에 상속하거나 복사하지 않습니다.',
    }
    const knowledgeRule = hasKnowledgeGuidance
      ? 'primary 중 kind=image인 source는 imageAccess.localPath의 원본을 로컬 이미지 열람 도구로 직접 확인하고 설명과 댓글을 함께 사용합니다. 일반 source는 sharedKnowledge를 먼저 사용하고 설명과 댓글로 보완합니다. fallback 및 각 source의 taskLink는 현재 작업에 필요한 정보가 부족할 때만 확인합니다.'
      : '들어오는 지식선이 없어 기본 업무 조사 절차를 사용합니다.'
    const full = detailLevel === 'full'
    const selectedImageAccess = imageCardLocalAccess(dataDirectory, mapId, selectedCard)

    return {
      contextSchemaVersion,
      detailLevel,
      ...(resolvedConversationAttribution ? {
        aiAttribution: {
          status: 'resolved',
          source: 'aionui-conversation',
          authorName: resolvedConversationAttribution.authorName,
          conversationId: aionUiConversationId,
        },
      } : activeAttributionResolutionFailure ? {
        aiAttribution: {
          status: 'unresolved',
          source: 'aionui-conversation',
          code: activeAttributionResolutionFailure.code,
          message: activeAttributionResolutionFailure.message,
          instruction: '조회는 계속할 수 있지만 모델 미지정 기록을 방지하기 위해 편집은 거부됩니다. AionUi에서 대화의 모델 선택이 완료됐는지 확인한 뒤 다시 시도하세요.',
        },
      } : {}),
      guide: productGuide,
      document: full ? {
        id: map.id,
        title: map.title,
        color: map.color,
        version: map.version,
        updatedAt: map.updatedAt,
        updatedBy: map.updatedBy,
        nodes: map.nodes,
        edges: map.edges,
        accessUrl: documentAccessUrl(health.publicBaseUrl, map.id),
      } : focusedDocument(map, health.publicBaseUrl),
      selection: {
        card: full
          ? { ...selectedCard, ...(selectedImageAccess ? { imageAccess: selectedImageAccess } : {}) }
          : contentCard(selectedCard, mapId),
        accessUrl: cardAccessUrl(health.publicBaseUrl, map.id, selectedCard.id),
        parents: full ? relatedCards(parentIds, map.nodes) : compactRelatedCards(parentIds, map.nodes),
        children: full ? relatedCards(childIds, map.nodes) : compactRelatedCards(childIds, map.nodes),
        siblings: full ? relatedCards(siblingIds, map.nodes) : compactRelatedCards(siblingIds, map.nodes),
        ancestors: full ? relatedCards(ancestorIds, map.nodes) : compactRelatedCards(ancestorIds, map.nodes),
        descendants: full ? relatedCards(descendantIds, map.nodes) : compactRelatedCards(descendantIds, map.nodes),
        blockedBy: full ? relatedCards(blockedByIds, map.nodes) : compactRelatedCards(blockedByIds, map.nodes),
        blocks: full ? relatedCards(blockingIds, map.nodes) : compactRelatedCards(blockingIds, map.nodes),
        knowledgeSources: full ? {
          primary: primaryKnowledge,
          fallback: fallbackKnowledge,
          all: incomingKnowledge,
          rule: knowledgeRule,
        } : {
          primary: focusedPrimaryKnowledge,
          fallback: focusedFallbackKnowledge,
          rule: knowledgeRule,
        },
        aiWorkCoordination: {
          tool: 'mindnprogress_get_ai_work_states',
          delegationOrigin: documentResult.delegationOrigin ?? {
            mapId: delegationOrigin?.mapId ?? mapId,
            cardId: delegationOrigin?.cardId ?? cardId,
            conversationId: aionUiConversationId || null,
            source: 'mcp-process',
          },
          siblingCardIds: siblingIds,
          toolArguments: siblingIds.length > 0 ? { mapId, cardIds: siblingIds } : null,
          instruction: '형제 카드를 포함해 선택 카드 이외의 관련 카드를 수정하려면 해당 카드 ID로 AI 작업 상태를 먼저 조회하세요. running 또는 waiting-confirmation이면 다른 AI가 작업 중이므로 사용자 지시 없이 동시에 수정하지 마세요. idle은 AI 대화가 쉬는 상태일 뿐 카드 업무 완료를 뜻하지 않으며, unknown은 충돌 없음으로 간주하지 마세요.',
          childDelegation: {
            candidateTool: 'mindnprogress_list_ai_conversations',
            delegateTool: 'mindnprogress_delegate_ai_work',
            statusTool: 'mindnprogress_list_ai_delegations',
            recoveryTool: 'mindnprogress_recover_ai_delegation',
            waitStateInstruction: 'delegateTool 응답이 waiting-integration-clean이면 통합 작업공간의 추적 변경 때문에 하위 AI 전문이 아직 전달되지 않은 상태입니다. 차단 파일을 사용자에게 알리고 같은 위임의 자동 시작을 기다리며 재위임하지 마세요.',
            instruction: '이 대화가 시작된 카드의 계층상 하위 카드에 작업을 맡길 때는 후보 목록과 필요한 대화 전문을 근거로 resume 또는 new를 선택하고 실행 가능한 지시를 전달하세요. 위임 기준은 AionUi 대화 ID에 영속 기록되므로 MCP 재연결·프로세스 재생성이나 다른 카드의 get_context 조회와 무관하게 유지되며, 직계 자식뿐 아니라 모든 깊이의 하위 카드에 위임할 수 있습니다. AI 작업공간 pool에 등록된 Unity 프로젝트의 독립 하위 작업은 MindNProgress가 서로 다른 worker와 브랜치를 배정하므로 병렬 위임할 수 있습니다. 가용 worker가 없어 waiting-workspace로 접수되면 서버가 대기열을 보존하고 자동 시작하므로 동일 위임을 재호출하거나 순차 우회하지 마세요. 중지된 위임을 resume하면 같은 AI 대화뿐 아니라 기존 worker lease와 변경도 이어서 사용하며, 같은 카드·대화에 다른 활성 위임이 있으면 중복 실행하지 않습니다. 완료 변경의 통합 충돌은 main이 아닌 같은 worker에서 해당 하위 AI 대화를 자동 재개해 해결하며, 통합과 최종 검증이 끝난 뒤에만 상위 대화가 재개됩니다. recovery-required 또는 integration-recovery-required는 AionCore 재시작, 재시도 가능한 연결 끊김 또는 필수 체크포인트·통합 실패로 명시적 재개가 필요한 상태이므로 새 위임이나 원 지시 자동 반복 대신 recoveryTool로 기존 대화·작업공간을 이어가세요. pool 미등록 프로젝트만 같은 작업공간 충돌을 피하도록 순차 위임하세요. 하위 AI 턴이 사용자에 의해 중지되거나 재시도 가능한 Agent 연결 끊김이 발생하면 위임은 재개 대기 상태를 유지하고, 같은 하위 대화에서 이어진 턴이 실제 완료된 뒤에만 현재 대화를 자동으로 다시 시작합니다. 주기적으로 확인하거나 일반적인 다음 작업 제안 문구를 보내지 마세요. 자동 재개된 턴에서 다음 작업을 위임하기로 판단했다면 최종 응답 전에 mindnprogress_delegate_ai_work를 실제로 호출하고 성공 결과를 확인하세요. 실제 호출 없이 “위임하겠습니다” 또는 “이어서 진행하겠습니다”와 같은 미래형 약속으로 턴을 끝내지 말고, 위임할 수 없다면 차단 원인과 필요한 조치를 현재 응답에 명시하세요.',
          },
        },
        taskLinks,
        comments: full ? selectedComments : focusedSelectedComments.comments,
        ...(full ? {} : { commentsPage: focusedSelectedComments.commentsPage }),
      },
      teamMembers: full ? (usersResult.users ?? []) : (usersResult.users ?? []).map(compactTeamMember),
      nextStep: '사용자 요청을 수행한 뒤 의미 있는 진행과 결과는 1~2문장의 summary와 작업을 이어가거나 검증하는 데 필요한 사실을 담은 detail 댓글로 기록하고, 재사용할 결론은 sharedKnowledge에 요약한 다음 mindnprogress_get_document로 결과를 다시 확인하세요. 작업 중 선택 카드 이외의 MindNProgress 카드를 실제 근거로 사용했다면 guide.knowledgeLinePolicy에 따라 작업 종료 전에 연결 또는 제안 여부를 판단하세요. 외부 전달물이나 결정 때문에 멈추면 제목을 바꾸지 말고 waitingItems와 [차단] 댓글을 추가하며, 재개할 때 해당 항목을 제거하고 [진행] 댓글을 남기세요.',
    }
  })

  registerTool(server, 'mindnprogress_get_document', '문서의 모든 카드와 연결 관계, 외부 접근 URL 및 이미지 카드의 로컬 원본 경로를 조회합니다.', mapIdSchema, async ({ mapId }) => {
    const [documentResult, health] = await Promise.all([
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}`),
      apiRequest('/api/health'),
    ])
    return {
      ...documentResult,
      access: {
        publicBaseUrl: health.publicBaseUrl,
        documentUrl: documentAccessUrl(health.publicBaseUrl, documentResult.map.id),
        cards: documentResult.map.nodes.map((node) => {
          const imageAccess = imageCardLocalAccess(dataDirectory, documentResult.map.id, node)
          return {
            cardId: node.id,
            label: node.data?.label ?? node.id,
            kind: node.data?.kind,
            accessUrl: cardAccessUrl(health.publicBaseUrl, documentResult.map.id, node.id),
            ...(imageAccess ? { imageAccess } : {}),
          }
        }),
        rule: '웹 링크를 기록할 때 localhost나 127.0.0.1로 재작성하지 말고 accessUrl을 그대로 사용하세요. 이미지 카드의 imageAccess.localPath는 기록용 링크가 아니라 로컬 원본을 직접 열람할 때만 사용하세요.',
      },
    }
  })

  registerTool(server, 'mindnprogress_get_ai_work_states', '카드에 연결된 AionUi 대화의 현재 작업 상태를 조회합니다. 형제·하위·선행 카드 등 선택 카드 밖의 관련 카드를 수정하기 전에 호출해 다른 AI와의 동시 작업 충돌을 확인하세요. 이 조회는 문서 데이터, 버전과 변경 이력을 수정하지 않습니다.', {
    mapId: z.string().min(1).describe('조회할 문서 ID'),
    cardIds: z.array(z.string().min(1).max(120)).max(200).optional().describe('조회할 카드 ID 목록. 생략하면 문서의 모든 카드를 조회'),
  }, async ({ mapId, cardIds = [] }) => {
    const query = new URLSearchParams()
    cardIds.forEach((cardId) => query.append('cardId', cardId))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const result = await apiRequest(`/api/maps/${encodeURIComponent(mapId)}/ai-conversation-work-states${suffix}`)
    return {
      ...result,
      coordinationRule: 'state가 running 또는 waiting-confirmation인 카드는 다른 AI가 작업 중인 것으로 취급하고 사용자 지시 없이 동시에 수정하지 마세요. idle은 카드 업무 완료를 뜻하지 않으며, unknown은 AionUi 상태 확인 실패이므로 충돌 없음으로 간주하지 마세요.',
    }
  })

  registerTool(server, 'mindnprogress_get_ai_workspace_pool', 'MindNProgress가 관리하는 AI 작업공간의 최신 목록, 역할, 경로, Unity 인스턴스 해시와 현재 상태를 읽기 전용으로 조회합니다. 폴더명이나 과거 대화에서 worker 목록을 추측하지 말고 이 도구를 사용하세요. 작업공간을 직접 점유하거나 상태를 변경하지 않으며 다른 대화의 lease ID와 job ID는 반환하지 않습니다.', {}, async () => {
    const result = await apiRequest('/api/ai-workspaces')
    return {
      ...result,
      statusGuide: {
        idle: '새 위임 후보가 될 수 있지만 실제 배정은 MindNProgress가 수행합니다.',
        leased: '다른 AI 작업에 점유된 상태입니다.',
        quarantined: '자동 재사용할 수 없으며 원인을 확인하고 명시적으로 복구해야 합니다.',
        integration: '사용자 작업과 완료 결과의 통합 기준이며 AI worker로 직접 선택하지 않습니다.',
      },
      coordinationRule: 'AI는 작업공간을 직접 선택·점유·전환·해제하지 않습니다. 실제 작업에서는 MindNProgress 위임 전문과 .ai-session.json에 배정된 projectRoot만 사용하세요.',
    }
  })

  registerTool(server, 'mindnprogress_complete_ai_delegation', '현재 위임 실행이 사용자의 중지로 끊긴 뒤 같은 AionUi 대화에서 직접 이어 실제 작업을 완료했음을 명시적으로 확인합니다. 같은 대화의 과거 위임이 중지됐더라도 현재 위임이 중단 없이 진행됐다면 호출하지 마세요. 카드 결과와 필요한 작업공간 체크포인트를 모두 기록한 마지막 작업 턴에서 최종 답변 직전에만 호출합니다. 도구가 required=false를 반환하면 오류가 아니며 최종 답변을 마치면 자동으로 상위 AI에 보고됩니다.', {
    mapId: z.string().min(1).describe('현재 위임 카드가 속한 문서 ID'),
  }, async ({ mapId }) => {
    const origin = delegationOriginForMap(mapId)
    return apiRequest(`/api/maps/${encodeURIComponent(mapId)}/ai-delegations/complete`, {
      method: 'POST',
      aiMapId: origin.mapId,
      aiCardId: origin.cardId,
      aiAttributionToken: origin.attributionToken,
      aiEditorId: origin.editorId,
      aiType: origin.aiType,
      aiModel: origin.aiModel,
      body: JSON.stringify({}),
    })
  })

  registerTool(server, 'mindnprogress_list_ai_conversations', '카드에서 시작한 모든 AionUi 대화 후보를 최신순으로 조회합니다. 각 대화의 AI·모델·모드·사고 강도·스킬·MCP·작업공간·시작자·최근 활동 시각과 현재 실행 상태를 반환합니다. 기존 대화를 이어갈지 새 대화를 만들지 판단할 때 전문 조회보다 먼저 사용하세요. 이 조회는 문서 버전을 변경하지 않습니다.', {
    mapId: z.string().min(1).describe('조회할 문서 ID'),
    cardId: z.string().min(1).max(120).describe('AI 대화 후보를 조회할 카드 ID'),
  }, async ({ mapId, cardId }) => {
    const result = await apiRequest(`/api/maps/${encodeURIComponent(mapId)}/cards/${encodeURIComponent(cardId)}/ai-conversations`, {
      aiMapId: mapId,
      aiCardId: cardId,
    })
    return {
      ...result,
      selectionRule: {
        exclude: 'runtime.state가 running 또는 waiting-confirmation이거나 available=false인 대화는 자동 이어가기 후보에서 제외하세요.',
        preferResume: '현재 지시가 같은 업무 흐름의 후속 작업이고 실행 환경(agent, model, mode, workspace, MCP)이 호환되는 idle 대화가 있으면 가장 관련성 높은 기존 대화를 우선 이어가세요.',
        chooseNew: '업무 목적이나 필요한 실행 환경이 다르거나, 독립 검토가 필요하거나, 기존 문맥이 현재 지시를 방해할 가능성이 구체적으로 있을 때만 새 대화를 선택하세요.',
        inspect: '목록 메타데이터만으로 관련성을 판단하기 어려운 후보에 한해서 mindnprogress_get_ai_conversation_transcript에 conversationId를 지정해 확인하세요.',
      },
    }
  })

  registerTool(server, 'mindnprogress_checkpoint_ai_workspace', 'MindNProgress가 할당한 AI worker에서 의도한 구현 변경만 실제 변경을 설명하는 커밋 메시지로 체크포인트에 고정합니다. Unity Play Mode, 재임포트, 동적 폰트·Atlas 생성 등 검증을 시작하기 전에 호출하고, 검증 후 수정했다면 새 변경 내용에 맞는 메시지로 다시 호출하세요. 서버가 현재 문서·카드 제목과 안정적인 ID로 [MnP] 출처 섹션을 생성합니다. 전달한 paths만 커밋되며 체크포인트 이후의 자동 변경은 완료 통합에서 제외됩니다. 파일 변경이 없다면 이 도구가 아니라 mindnprogress_confirm_ai_workspace_no_changes를 사용하세요.', {
    mapId: z.string().min(1).describe('할당된 작업 문서 ID'),
    leaseId: z.string().min(1).max(120).describe('최초 위임 전문의 할당된 작업공간 leaseId'),
    jobId: z.string().min(1).max(120).describe('최초 위임 전문의 할당된 작업공간 jobId'),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(2000)
      .describe('검증 전에 고정할 의도된 변경의 projectRoot 상대 경로. git status를 확인해 실제 수정·추가한 파일만 전달'),
    commitMessage: checkpointCommitMessageSchema
      .describe('이번 paths의 실제 변경을 설명하는 구조화 커밋 메시지. 서버가 [김용민] prefix, [MnP] 출처와 본문 섹션을 생성하므로 출처를 직접 넣지 않음'),
  }, async ({ mapId, leaseId, jobId, paths, commitMessage }) => {
    const origin = delegationOriginForMap(mapId)
    return apiRequest(`/api/ai-workspaces/${encodeURIComponent(leaseId)}/checkpoint`, {
      method: 'POST',
      aiMapId: origin.mapId,
      aiCardId: origin.cardId,
      aiAttributionToken: origin.attributionToken,
      aiEditorId: origin.editorId,
      aiType: origin.aiType,
      aiModel: origin.aiModel,
      timeoutMs: 60_000,
      body: JSON.stringify({ jobId, paths, commitMessage }),
    })
  })

  registerTool(server, 'mindnprogress_confirm_ai_workspace_no_changes', 'MindNProgress가 할당한 AI worker에서 의도한 파일 변경이 없는 조사·검증 작업임을 명시적으로 확인합니다. git status와 diff를 확인해 구현 변경이 전혀 없을 때만 호출하세요. 파일 변경이 있으면 mindnprogress_checkpoint_ai_workspace에 paths와 구조화 commitMessage를 전달해야 합니다.', {
    mapId: z.string().min(1).describe('할당된 작업 문서 ID'),
    leaseId: z.string().min(1).max(120).describe('최초 위임 전문의 할당된 작업공간 leaseId'),
    jobId: z.string().min(1).max(120).describe('최초 위임 전문의 할당된 작업공간 jobId'),
  }, async ({ mapId, leaseId, jobId }) => {
    const origin = delegationOriginForMap(mapId)
    return apiRequest(`/api/ai-workspaces/${encodeURIComponent(leaseId)}/checkpoint`, {
      method: 'POST',
      aiMapId: origin.mapId,
      aiCardId: origin.cardId,
      aiAttributionToken: origin.attributionToken,
      aiEditorId: origin.editorId,
      aiType: origin.aiType,
      aiModel: origin.aiModel,
      timeoutMs: 60_000,
      body: JSON.stringify({ jobId, paths: [], confirmNoChanges: true }),
    })
  })

  registerTool(server, 'mindnprogress_delegate_ai_work', '이 대화가 시작된 카드의 계층상 하위 카드 AI 대화에 구체적인 작업을 위임합니다. 직계 자식뿐 아니라 모든 깊이의 하위 카드를 지원하며, 다른 카드를 get_context로 조회해도 위임 기준 카드는 바뀌지 않습니다. 기존 대화를 이어가거나 새 대화를 만들 수 있습니다. 중지된 위임을 resume하면 같은 AI 대화와 기존 작업공간 lease를 함께 이어가며, 같은 카드·대화의 활성 위임은 중복 생성하지 않습니다. 등록된 AI 작업공간 pool은 독립 worker를 자동 배정하고 lease 없이 실행하지 않으며, 가용 worker가 없으면 waiting-workspace로 접수해 FIFO 대기 후 자동 시작합니다. waiting-integration-clean은 통합 작업공간의 추적 변경 때문에 하위 전문을 아직 전달하지 않은 대기 상태이며, 변경이 정리되면 같은 위임을 자동 시작하므로 재위임하지 마세요. 완료 변경은 main에 직렬 통합합니다. 통합 충돌은 같은 하위 AI가 worker에서 해결하며, 실제 통합과 최종 검증이 끝난 뒤에만 결과를 포함한 메시지로 현재 상위 AI 대화를 자동 재개합니다. 먼저 후보 목록과 작업 상태를 확인하고, 현재 문서 version을 sourceRevision으로 전달하세요.', {
    mapId: z.string().min(1).describe('이 대화가 시작된 상위 카드가 속한 문서 ID'),
    targetCardId: z.string().min(1).max(120).describe('작업을 맡길 대화 시작 카드의 계층상 하위 카드 ID. 모든 깊이의 하위 카드를 지원'),
    strategy: z.enum(['resume', 'new']).describe('resume은 연결된 기존 대화 이어가기, new는 새 대화 생성'),
    conversationId: z.string().min(1).max(120).optional().describe('resume일 때 이어갈 대상 카드의 conversationId'),
    instruction: z.string().min(1).max(100000).describe('하위 AI가 제안에 그치지 않고 실제로 수행할 구체적인 지시와 완료 조건'),
    decisionReason: z.string().min(1).max(1000).describe('이 기존 대화를 선택했거나 새 대화가 필요하다고 판단한 근거'),
    sourceRevision: z.number().int().positive().describe('get_context 또는 get_document에서 확인한 현재 문서 version'),
    idempotencyKey: z.string().regex(AI_DELEGATION_ID_PATTERN).describe('같은 위임의 중복 실행을 막는 안정적인 키. 영문·숫자로 시작하고 영문·숫자·밑줄·하이픈·콜론을 사용해 sourceRevision과 targetCardId를 포함하는 형식을 권장'),
    newConversation: z.object({
      agentId: z.string().min(1).max(512),
      modelId: z.string().min(1).max(512),
      modeId: z.string().min(1).max(512).optional(),
      thoughtLevelId: z.string().min(1).max(512).optional(),
      enabledSkillIds: z.array(z.string().min(1).max(512)).max(128).optional(),
      disabledBuiltinSkillIds: z.array(z.string().min(1).max(512)).max(128).optional(),
      mcpIds: z.array(z.string().min(1).max(512)).max(128).optional(),
      workspace: z.string().min(1).max(4096).optional(),
    }).optional().describe('new일 때 명시적으로 사용할 실행 환경. 생략하면 대상 카드의 최근 대화, 그마저 없으면 현재 상위 대화 설정을 상속'),
  }, async ({ mapId, ...delegation }) => {
    const origin = delegationOriginForMap(mapId)
    return apiRequest(`/api/maps/${encodeURIComponent(mapId)}/ai-delegations`, {
      method: 'POST',
      aiMapId: origin.mapId,
      aiCardId: origin.cardId,
      aiAttributionToken: origin.attributionToken,
      aiEditorId: origin.editorId,
      aiType: origin.aiType,
      aiModel: origin.aiModel,
      timeoutMs: 60_000,
      body: JSON.stringify(delegation),
    })
  })

  registerTool(server, 'mindnprogress_list_ai_delegations', '문서의 AI 작업 위임 상태와 감사 정보를 조회합니다. worker 대기(waiting-workspace), 통합 작업공간 정리 대기(waiting-integration-clean), 하위 실행·자원 대기(waiting-resource), 통합 대기, AI 충돌 해결, 상위 대기·재개, 완료 또는 실패 상태와 대상 대화·turnId·작업공간 결과를 반환하며 문서 버전을 변경하지 않습니다.', {
    mapId: z.string().min(1),
    parentCardId: z.string().min(1).max(120).optional().describe('상위 카드로 필터'),
    targetCardId: z.string().min(1).max(120).optional().describe('하위 대상 카드로 필터'),
  }, async ({ mapId, parentCardId, targetCardId }) => {
    const query = new URLSearchParams()
    if (parentCardId) query.set('parentCardId', parentCardId)
    if (targetCardId) query.set('targetCardId', targetCardId)
    const suffix = query.size > 0 ? `?${query}` : ''
    return apiRequest(`/api/maps/${encodeURIComponent(mapId)}/ai-delegations${suffix}`, { aiMapId: mapId })
  })

  registerTool(server, 'mindnprogress_get_card', '한 카드의 설명, 공유 지식, 업무 필드와 댓글을 선택적으로 조회합니다. description과 sharedKnowledge의 길이·SHA-256은 textIntegrity로 반환하며 이미지 카드는 로컬 원본 경로도 반환합니다. get_context의 fallback 카드 또는 간략 개요에서 원문이 필요할 때 사용하세요.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1),
    commentOffset: z.number().int().nonnegative().default(0),
    commentLimit: z.number().int().min(1).max(100).default(20),
    commentOrder: z.enum(['asc', 'desc']).default('desc'),
    includeCommentDetail: z.boolean().default(false).describe('true이면 댓글 상세 본문을 함께 반환. 요약만으로 작업 판단이 어려울 때 사용'),
  }, async ({ mapId, cardId, commentOffset, commentLimit, commentOrder, includeCommentDetail }) => {
    const [documentResult, commentsResult, health] = await Promise.all([
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}`),
      apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments?nodeId=${encodeURIComponent(cardId)}&includeDetail=${includeCommentDetail}`),
      apiRequest('/api/health'),
    ])
    const card = documentResult.map.nodes.find((node) => node.id === cardId)
    if (!card) throw new Error(`카드를 찾을 수 없습니다: ${cardId}`)
    const commentPage = paginateComments(commentsResult.comments ?? [], {
      offset: commentOffset,
      limit: commentLimit,
      order: commentOrder,
    })
    return {
      document: {
        id: documentResult.map.id,
        title: documentResult.map.title,
        version: documentResult.map.version,
        updatedAt: documentResult.map.updatedAt,
        updatedBy: documentResult.map.updatedBy,
      },
      card: contentCard(card, mapId),
      accessUrl: cardAccessUrl(health.publicBaseUrl, documentResult.map.id, card.id),
      comments: commentPage.items,
      commentsPage: commentPage.page,
    }
  })

  registerTool(server, 'mindnprogress_get_shared_knowledge_review_context', '정리 후보 한 카드의 sharedKnowledge 원문, 무결성 해시, 검토 신호, 계층·지식선 관계와 최근 댓글을 조회합니다. 후보 목록에서 선택한 카드만 호출하고 반환된 document.version과 card.textIntegrity.sha256을 저장 요청에 그대로 사용하세요.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1).max(120),
    commentLimit: z.number().int().min(0).max(20).default(10),
    includeCommentDetail: z.boolean().default(false).describe('true이면 최근 댓글의 상세 본문도 포함. 요약만으로 현재 결론을 판단할 수 없을 때만 사용'),
  }, async ({ mapId, cardId, commentLimit, includeCommentDetail }) => {
    const query = new URLSearchParams({
      commentLimit: String(commentLimit),
      includeCommentDetail: String(includeCommentDetail),
    })
    const result = await apiRequest(
      `/api/maps/${encodeURIComponent(mapId)}/cards/${encodeURIComponent(cardId)}/shared-knowledge-review-context?${query}`,
      { aiMapId: mapId, aiCardId: cardId },
    )
    return result.context
  })

  registerTool(server, 'mindnprogress_create_mindmap', '새 문서와 완성된 계층형 마인드맵을 한 번에 원자적으로 생성합니다. 여러 카드를 만들 때는 create_document 후 save_document를 호출하지 말고 반드시 이 도구를 우선 사용하세요. 실제로 실행할 카드에 독립적으로 판정할 구현·검증 조건이 2개 이상이면 결과 중심 checklist를 작성하되 별도 하위 카드와 중복하지 마세요. 비어 있지 않은 checklist를 보내면 완료 비율로 progress와 status를 자동 계산합니다. 카드 위치와 연결선은 자동 배치됩니다.', {
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
    rootSharedKnowledge: z.string().max(10_000).default(''),
  }, async ({ title, color, rootLabel, rootDescription, rootSharedKnowledge }) => {
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
            data: { label: rootLabel, description: rootDescription, sharedKnowledge: rootSharedKnowledge, progress: 0, status: 'planned', kind: 'root' },
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

  registerTool(server, 'mindnprogress_add_card', '문서에 새 카드 또는 하위 카드를 추가합니다. 실제로 실행할 카드에 독립적으로 판정할 구현·검증 조건이 2개 이상이면 결과 중심 checklist를 작성하되 별도 하위 카드의 작업은 중복하지 마세요. 비어 있지 않은 checklist를 보내면 완료 비율로 progress와 status를 자동 계산합니다. 외부 전달물이나 결정 대기는 제목이 아니라 waitingItems로 기록합니다. 기본 affected 응답은 추가한 카드와 문서 요약만 반환하며, full은 변경 전과 같은 API 원본 전체 문서를 반환합니다.', {
    mapId: z.string().min(1),
    parentCardId: z.string().min(1).optional().describe('새 카드를 추가할 상위 카드 ID. 최상위 카드를 추가할 때는 생략'),
    parentId: z.string().min(1).optional().describe('기존 대화 호환용 상위 카드 ID. 새 호출에서는 parentCardId 사용'),
    data: nodeDataSchema,
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    responseMode: z.enum(['full', 'affected']).default('affected').describe(affectedFirstResponseModeDescription),
  }, async ({ mapId, parentCardId, parentId, data, position, responseMode }) => {
    const resolvedParentCardId = resolveAliasedId(parentCardId, parentId, {
      preferredName: 'parentCardId',
      legacyName: 'parentId',
      required: false,
    })
    const map = await getDocument(mapId)
    const previousMap = responseMode === 'affected' ? structuredClone(map) : null
    const parent = resolvedParentCardId ? map.nodes.find((node) => node.id === resolvedParentCardId) : null
    if (resolvedParentCardId && !parent) throw new Error('상위 카드를 찾을 수 없습니다.')
    const siblingIds = new Set(resolvedParentCardId
      ? map.edges.filter((edge) => isHierarchyEdge(edge) && edge.source === resolvedParentCardId).map((edge) => edge.target)
      : [])
    const siblingPositions = map.nodes.filter((node) => siblingIds.has(node.id)).map((node) => node.position)
    const nodeId = `node-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const checklistState = checklistProgressPatch(data.checklist)
    const normalizedData = { ...data, ...checklistState }
    const node = {
      id: nodeId,
      type: 'mind',
      position: position ?? (parent
        ? defaultChildMindMapPosition(
          parent.position,
          siblingPositions,
          parent.data?.image?.displayWidth ?? parent.data?.externalLink?.displayWidth ?? mindMapDefaultNodeWidth,
        )
        : snapMindMapPosition({ x: 0, y: map.nodes.length * mindMapWorkNodeVerticalStep })),
      data: {
        ...normalizedData,
        waitingItems: normalizedData.status === 'done' || normalizedData.progress >= 100 ? [] : normalizeWaitingItems(normalizedData.waitingItems),
      },
    }
    map.nodes.push(node)
    if (resolvedParentCardId) map.edges.push({
      id: `edge-${resolvedParentCardId}-${nodeId}`,
      source: resolvedParentCardId,
      target: nodeId,
      sourceHandle: parent?.data?.kind === 'image' ? 'image-source-right' : undefined,
      type: 'default',
      data: { relation: 'hierarchy' },
      markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
    })
    const saved = await saveDocument(map, false, resolvedParentCardId ?? '')
    const savedMap = saved.map
    if (responseMode === 'full') {
      return {
        responseMode,
        map: savedMap,
        summary: saved.summary,
        createdCardId: nodeId,
      }
    }
    const createdCard = savedMap.nodes.find((item) => item.id === nodeId)
    if (!createdCard) throw new Error('저장 후 추가한 카드를 찾을 수 없습니다.')
    const rootCard = rootCardOf(savedMap)
    return {
      responseMode,
      document: saved.summary,
      card: {
        ...contentCard(createdCard, mapId),
        position: createdCard.position,
      },
      parentCardId: resolvedParentCardId ?? null,
      root: rootRollup(rootCard),
      affectedCards: affectedCardsOf(previousMap, savedMap, mapId, [], rootCard?.id, [nodeId]),
    }
  })

  registerTool(server, 'mindnprogress_update_card', '카드의 일부 필드만 부분 병합 방식으로 변경합니다. data에 포함한 필드만 변경되고 일반 카드에서 생략한 필드와 position은 보존되므로 현재 카드 전체 데이터를 재전송하지 마세요. 실제로 실행할 카드에 독립적으로 판정할 구현·검증 조건이 2개 이상이면 결과 중심 checklist를 작성하되 별도 하위 카드의 작업은 중복하지 마세요. checklist는 기존 항목 ID를 보존한 전체 배열로 보내며, 항목이 하나 이상이면 완료 비율로 progress와 status를 자동 계산합니다. 기존 description 또는 sharedKnowledge 내부의 일부만 고칠 때는 이 도구로 필드 전체를 보내지 말고 mindnprogress_patch_card_text를 사용하세요. 빈 문자열과 빈 배열은 해당 필드를 명시적으로 초기화합니다. 단, status=done 또는 progress>=100이면 waitingItems가 자동으로 비워지며 Ref 카드는 원본 관리 필드가 최신 원본 값으로 동기화될 수 있습니다. 최상위 카드와 하위 업무가 있는 일반 isWork=false 묶음 카드의 progress·status는 서버가 다시 계산합니다. description은 업무 요청과 배경에 사용합니다. sharedKnowledge는 다른 카드가 재사용할 현재 유효한 결론에만 사용하고 진행 기록·도구 로그·중복·폐기 결론은 댓글로 분리하세요. responseMode는 full이 기본값이며 연속 작업용 전체 카드 본문과 관계를 반환합니다. 단일 카드와 서버가 함께 조정한 카드만 필요하면 affected를 사용하세요.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1).optional().describe('수정할 카드 ID. 새 호출에서는 이 필드를 사용'),
    nodeId: z.string().min(1).optional().describe('기존 대화 호환용 카드 ID. 새 호출에서는 cardId 사용'),
    data: nodeDataSchema.partial().describe('변경할 카드 필드만 포함하는 부분 병합 데이터. 일반 카드에서 생략한 필드는 보존되므로 현재 카드 전체 데이터를 재전송하지 않습니다. checklist는 전체 배열을 교체하며 항목이 하나 이상이면 완료 비율로 progress와 status를 자동 계산합니다. 빈 문자열과 빈 배열은 명시적 초기화이며, 완료 상태 또는 진행률 100 적용 시 waitingItems는 자동으로 비워지고 Ref 카드는 원본 관리 필드가 최신 원본 값으로 동기화될 수 있습니다. 자동 집계 대상 카드의 progress와 status는 저장 시 서버가 다시 계산합니다.'),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    responseMode: z.enum(['full', 'affected']).default('full').describe('full은 저활용 필드를 제외한 최신 전체 문서를 반환하며 기본값입니다. affected는 직접 수정 카드와 서버가 함께 조정한 카드 및 문서·Root 요약만 반환합니다.'),
  }, async ({ mapId, cardId, nodeId, data, position, responseMode }) => {
    const resolvedCardId = resolveAliasedId(cardId, nodeId, {
      preferredName: 'cardId',
      legacyName: 'nodeId',
    })
    const map = await getDocument(mapId)
    const node = map.nodes.find((item) => item.id === resolvedCardId)
    if (!node) throw new Error('카드를 찾을 수 없습니다.')
    const previousMap = responseMode === 'affected' ? structuredClone(map) : null
    const checklistState = checklistProgressPatch(data.checklist)
    const nextData = {
      ...node.data,
      ...data,
      ...checklistState,
      ...(data.waitingItems === undefined ? {} : { waitingItems: normalizeWaitingItems(data.waitingItems) }),
    }
    node.data = nextData.status === 'done' || nextData.progress >= 100
      ? { ...nextData, waitingItems: [] }
      : nextData
    if (position) node.position = position
    const saved = await saveDocument(map, false, resolvedCardId)
    const savedMap = saved.map
    const savedCard = savedMap.nodes.find((item) => item.id === resolvedCardId)
    if (!savedCard) throw new Error('저장 후 카드를 찾을 수 없습니다.')
    const changedFields = [...new Set([...Object.keys(data), ...Object.keys(checklistState), ...(position ? ['position'] : [])])]
    if (responseMode === 'full') {
      return {
        responseMode,
        map: updateCardFullMap(savedMap),
        summary: saved.summary,
        changedCardId: resolvedCardId,
        changedFields,
      }
    }
    const rootCard = rootCardOf(savedMap)
    return {
      responseMode,
      document: saved.summary,
      card: {
        ...contentCard(savedCard, mapId),
        position: savedCard.position,
      },
      root: rootRollup(rootCard),
      affectedCards: affectedCardsOf(previousMap, savedMap, mapId, [resolvedCardId], rootCard?.id),
      changedFields,
    }
  })

  registerTool(server, 'mindnprogress_patch_card_text', `기존 카드의 description 또는 sharedKnowledge 전체를 다시 생성하지 않고 일부만 안전하게 수정합니다. 먼저 mindnprogress_get_card에서 대상 필드의 textIntegrity.sha256을 받아 expectedSha256으로 전달하세요. 해시가 달라졌거나 경계 문자열이 유일하지 않으면 저장하지 않습니다. ${cardTextSafetyInstructions} sharedKnowledge에서 같은 주제의 결론을 갱신할 때는 새 이력을 뒤에 추가하지 말고 이 도구로 기존 절을 교체하세요. Ref 카드는 원본 카드를 직접 수정해야 합니다.`, {
    mapId: z.string().min(1),
    cardId: z.string().min(1),
    field: z.enum(['description', 'sharedKnowledge']).describe('부분 수정할 텍스트 필드'),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).describe('mindnprogress_get_card의 card.textIntegrity에서 확인한 현재 필드 SHA-256'),
    operation: cardTextPatchOperationSchema,
  }, async ({ mapId, cardId, field, expectedSha256, operation }) => {
    const { saved, result } = await mutateDocument(mapId, cardId, (map) => {
      const node = map.nodes.find((item) => item.id === cardId)
      if (!node) throw new Error(`카드를 찾을 수 없습니다: ${cardId}`)
      if (node.data?.reference) {
        throw new Error('TEXT_PATCH_REFERENCE_CARD: Ref 카드는 동기화 대상이므로 원본 카드를 직접 수정해 주세요.')
      }

      const beforeText = typeof node.data?.[field] === 'string' ? node.data[field] : ''
      const before = textIntegrity(beforeText)
      if (before.sha256 !== expectedSha256) {
        throw new Error(`TEXT_HASH_MISMATCH: 원문이 조회 이후 변경되었습니다. 다시 조회해 최신 해시를 사용하세요. (currentSha256=${before.sha256})`)
      }

      const nextText = applyCardTextPatch(beforeText, operation)
      if (nextText === beforeText) {
        throw new Error('TEXT_PATCH_NO_CHANGE: 부분 수정 결과가 현재 원문과 같습니다.')
      }
      if (field === 'sharedKnowledge' && nextText.length > sharedKnowledgeMaxLength) {
        throw new Error(`TEXT_PATCH_LENGTH_LIMIT: sharedKnowledge는 ${sharedKnowledgeMaxLength.toLocaleString('en-US')}자 이하여야 합니다. (resultLength=${nextText.length})`)
      }
      node.data = { ...node.data, [field]: nextText }
      return { before, nextText }
    })

    const savedCard = saved.map.nodes.find((item) => item.id === cardId)
    if (!savedCard) throw new Error('저장 후 카드를 찾을 수 없습니다.')
    const storedText = typeof savedCard.data?.[field] === 'string' ? savedCard.data[field] : ''
    if (storedText !== result.nextText) {
      throw new Error('TEXT_PATCH_VERIFICATION_FAILED: 저장된 텍스트가 계산한 결과와 일치하지 않습니다.')
    }
    return {
      document: saved.summary,
      card: {
        id: savedCard.id,
        label: savedCard.data?.label ?? savedCard.id,
      },
      field,
      operation: operation.type,
      before: result.before,
      after: textIntegrity(storedText),
      verification: { storedMatchesExpected: true },
    }
  })

  registerTool(server, 'mindnprogress_apply_shared_knowledge_review', '검토 문맥에서 만든 sharedKnowledge 정리 결과를 한 문서에 원자적으로 저장하고 검토 완료로 기록합니다. 모든 카드의 현재 SHA-256과 문서 버전이 일치할 때만 전체 요청을 한 번에 반영하며 하나라도 다르면 아무것도 저장하지 않습니다. 본문을 줄이거나 재구성한 경우 cleaned와 replacement를, 현재 장문 전체가 계속 필요하면 accepted-long만 사용하세요. Ref 카드는 지원하지 않습니다.', {
    mapId: z.string().min(1),
    baseVersion: z.number().int().positive().describe('검토 문맥의 document.version'),
    patches: z.array(z.object({
      cardId: z.string().min(1).max(120),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).describe('검토 문맥의 card.textIntegrity.sha256'),
      reviewResult: z.enum(['cleaned', 'accepted-long']),
      replacement: z.string().max(10_000).optional().describe('cleaned일 때만 보내는 정리된 sharedKnowledge 전체. accepted-long일 때는 생략'),
    })).min(1).max(20),
  }, async ({ mapId, baseVersion, patches }) => apiRequest(
    `/api/maps/${encodeURIComponent(mapId)}/shared-knowledge/reviews`,
    {
      method: 'POST',
      aiMapId: mapId,
      body: JSON.stringify({ baseVersion, patches }),
    },
  ))

  registerTool(server, 'mindnprogress_recover_ai_delegation', 'AionCore 재시작, 연결 끊김 또는 필수 체크포인트·통합 실패로 recovery-required 또는 integration-recovery-required가 된 AI 위임을 기존 대화와 기존 작업공간에서 명시적으로 재개합니다. 원래 지시를 자동 재생하지 않으며, 현재 카드·Git·작업공간 상태를 확인한 뒤 미완료 부분만 수행하도록 새 복구 지시를 전달합니다.', {
    mapId: z.string().min(1).describe('복구할 위임이 속한 문서 ID'),
    delegationId: z.string().regex(AI_DELEGATION_ID_PATTERN).describe('mindnprogress_list_ai_delegations에서 확인한 복구 대상 위임 ID'),
    instruction: z.string().min(1).max(100000).describe('현재 상태를 확인한 뒤 이어서 수행할 범위와 완료 조건. 원래 지시의 단순 복사 대신 중복 실행을 피할 확인 기준을 포함'),
    sourceRevision: z.number().int().positive().describe('get_context 또는 get_document에서 확인한 현재 문서 version'),
  }, async ({ mapId, delegationId, instruction, sourceRevision }) => {
    const origin = delegationOriginForMap(mapId)
    return apiRequest(`/api/maps/${encodeURIComponent(mapId)}/ai-delegations/${encodeURIComponent(delegationId)}/recover`, {
      method: 'POST',
      aiMapId: origin.mapId,
      aiCardId: origin.cardId,
      aiAttributionToken: origin.attributionToken,
      aiEditorId: origin.editorId,
      aiType: origin.aiType,
      aiModel: origin.aiModel,
      timeoutMs: 60_000,
      body: JSON.stringify({ instruction, sourceRevision }),
    })
  })

  registerTool(server, 'mindnprogress_move_card', '카드와 모든 하위 카드를 유지한 채 다른 카드의 하위로 이동합니다. 기본 affected 응답은 이동한 카드와 상위 관계 변화만 반환하며, full은 변경 전과 같은 API 원본 전체 문서를 반환합니다.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1).optional().describe('이동할 카드 ID. 새 호출에서는 이 필드를 사용'),
    nodeId: z.string().min(1).optional().describe('기존 대화 호환용 카드 ID. 새 호출에서는 cardId 사용'),
    newParentCardId: z.string().min(1).optional().describe('새 상위 카드 ID. 새 호출에서는 이 필드를 사용'),
    newParentId: z.string().min(1).optional().describe('기존 대화 호환용 새 상위 카드 ID. 새 호출에서는 newParentCardId 사용'),
    responseMode: z.enum(['full', 'affected']).default('affected').describe(affectedFirstResponseModeDescription),
  }, async ({ mapId, cardId, nodeId, newParentCardId, newParentId, responseMode }) => {
    const resolvedCardId = resolveAliasedId(cardId, nodeId, {
      preferredName: 'cardId',
      legacyName: 'nodeId',
    })
    const resolvedParentCardId = resolveAliasedId(newParentCardId, newParentId, {
      preferredName: 'newParentCardId',
      legacyName: 'newParentId',
    })
    const map = await getDocument(mapId)
    if (!map.nodes.some((node) => node.id === resolvedCardId) || !map.nodes.some((node) => node.id === resolvedParentCardId)) {
      throw new Error('이동할 카드 또는 새 상위 카드를 찾을 수 없습니다.')
    }
    if (resolvedCardId === resolvedParentCardId || descendantsOf(resolvedCardId, map.edges).has(resolvedParentCardId)) {
      throw new Error('자기 자신이나 하위 카드 아래로 이동할 수 없습니다.')
    }
    const previousMap = responseMode === 'affected' ? structuredClone(map) : null
    const previousParentCardId = map.edges
      .find((edge) => isHierarchyEdge(edge) && edge.target === resolvedCardId)?.source ?? null
    map.edges = map.edges.filter((edge) => isKnowledgeEdge(edge) || edge.target !== resolvedCardId)
    map.edges.push({
      id: `edge-${resolvedParentCardId}-${resolvedCardId}`,
      source: resolvedParentCardId,
      target: resolvedCardId,
      type: 'default',
      data: { relation: 'hierarchy' },
      markerEnd: { type: 'arrowclosed', width: 16, height: 16 },
    })
    const saved = await saveDocument(map, false, resolvedCardId)
    const savedMap = saved.map
    if (responseMode === 'full') {
      return {
        responseMode,
        map: savedMap,
        summary: saved.summary,
        movedCardId: resolvedCardId,
      }
    }
    const movedCard = savedMap.nodes.find((item) => item.id === resolvedCardId)
    if (!movedCard) throw new Error('저장 후 이동한 카드를 찾을 수 없습니다.')
    const rootCard = rootCardOf(savedMap)
    return {
      responseMode,
      document: saved.summary,
      card: {
        ...contentCard(movedCard, mapId),
        position: movedCard.position,
      },
      hierarchy: {
        previousParentCardId,
        newParentCardId: resolvedParentCardId,
      },
      root: rootRollup(rootCard),
      affectedCards: affectedCardsOf(previousMap, savedMap, mapId, [], rootCard?.id, [resolvedCardId]),
    }
  })

  registerTool(server, 'mindnprogress_delete_card', '카드를 삭제합니다. 일반 카드는 기본적으로 모든 하위 카드도 함께 삭제합니다. 최상위 카드는 직계 자식이 정확히 하나일 때만 삭제할 수 있고 해당 자식이 새 최상위 카드로 승격되며, 직계 자식이 없거나 여러 개면 삭제하지 않습니다. 기본 affected 응답은 삭제한 카드 ID와 끊어진 계층·지식선 관계 및 함께 조정된 카드만 반환하며, full은 변경 전과 같은 API 원본 전체 문서를 반환합니다.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1).optional().describe('삭제할 카드 ID. 새 호출에서는 이 필드를 사용'),
    nodeId: z.string().min(1).optional().describe('기존 대화 호환용 카드 ID. 새 호출에서는 cardId 사용'),
    includeDescendants: z.boolean().default(true),
    responseMode: z.enum(['full', 'affected']).default('affected').describe(affectedFirstResponseModeDescription),
  }, async ({ mapId, cardId, nodeId, includeDescendants, responseMode }) => {
    const resolvedCardId = resolveAliasedId(cardId, nodeId, {
      preferredName: 'cardId',
      legacyName: 'nodeId',
    })
    const map = await getDocument(mapId)
    const target = map.nodes.find((node) => node.id === resolvedCardId)
    if (!target) throw new Error('카드를 찾을 수 없습니다.')
    const rootChildIds = target.data?.kind === 'root'
      ? [...new Set(map.edges
          .filter((edge) => isHierarchyEdge(edge) && edge.source === resolvedCardId
            && map.nodes.some((node) => node.id === edge.target))
          .map((edge) => edge.target))]
      : []
    if (target.data?.kind === 'root' && rootChildIds.length === 0) {
      throw new Error('최상위 카드에 승격할 자식 카드가 없어 삭제할 수 없습니다. 문서 전체를 삭제하려면 문서를 휴지통으로 이동하세요.')
    }
    if (target.data?.kind === 'root' && rootChildIds.length > 1) {
      throw new Error(`최상위 카드의 직계 자식이 ${rootChildIds.length}개여서 삭제할 수 없습니다. 최상위로 승격할 카드 하나만 남긴 뒤 다시 시도하세요.`)
    }
    const promotedRootCardId = rootChildIds[0] ?? null
    const previousMap = responseMode === 'affected' ? structuredClone(map) : null
    const deletesRoot = target.data?.kind === 'root'
    const deletedIds = !deletesRoot && includeDescendants ? descendantsOf(resolvedCardId, map.edges) : new Set()
    deletedIds.add(resolvedCardId)
    const deletedCardIds = [...deletedIds]
    const relationChanges = deletedRelationsOf(map, deletedCardIds, resolvedCardId)
    map.nodes = map.nodes
      .filter((node) => !deletedIds.has(node.id))
      .map((node) => node.id === promotedRootCardId
        ? { ...node, data: { ...node.data, kind: 'root' } }
        : node)
    map.edges = map.edges.filter((edge) => !deletedIds.has(edge.source) && !deletedIds.has(edge.target))
    const saved = await saveDocument(map, false, resolvedCardId)
    const savedMap = saved.map
    if (responseMode === 'full') {
      return {
        responseMode,
        map: savedMap,
        summary: saved.summary,
        deletedCardIds,
        relationChanges,
        promotedRootCardId,
      }
    }
    const rootCard = rootCardOf(savedMap)
    return {
      responseMode,
      document: saved.summary,
      deletedCardIds,
      relationChanges,
      promotedRootCardId,
      root: rootRollup(rootCard),
      affectedCards: affectedCardsOf(previousMap, savedMap, mapId, [], rootCard?.id),
    }
  })

  registerTool(server, 'mindnprogress_add_knowledge_line', 'source 카드의 결과를 target 카드가 선행 지식으로 사용하도록 지식선을 추가합니다. 호출 전 mindnprogress_get_context의 guide.knowledgeLinePolicy를 따르세요. 전체 문서를 전달하지 않고 최신 버전에 관계만 안전하게 반영하며 순환과 중복 연결을 거부합니다.', {
    mapId: z.string().min(1),
    sourceCardId: z.string().min(1).describe('선행 지식을 제공하는 카드 ID'),
    targetCardId: z.string().min(1).describe('선행 지식을 사용하는 카드 ID'),
    knowledgePolicy: knowledgePolicySchema.default('reuse-first'),
  }, async ({ mapId, sourceCardId, targetCardId, knowledgePolicy }) => {
    const edgeId = `knowledge-${sourceCardId}-${targetCardId}-${Date.now()}-${randomBytes(3).toString('hex')}`
    const { saved, result } = await mutateDocument(mapId, targetCardId, (map) => {
      if (!map.nodes.some((node) => node.id === sourceCardId)) throw new Error('선행 지식을 제공하는 카드를 찾을 수 없습니다.')
      if (!map.nodes.some((node) => node.id === targetCardId)) throw new Error('선행 지식을 사용하는 카드를 찾을 수 없습니다.')
      if (sourceCardId === targetCardId) throw new Error('카드는 자기 자신을 선행 지식으로 연결할 수 없습니다.')
      if (map.edges.some((edge) => isKnowledgeEdge(edge) && edge.source === sourceCardId && edge.target === targetCardId)) {
        throw new Error('이미 연결된 지식선입니다.')
      }
      if (createsKnowledgeCycle(sourceCardId, targetCardId, map.edges)) throw new Error('순환 지식선은 추가할 수 없습니다.')
      const knowledgeLine = {
        id: edgeId,
        source: sourceCardId,
        target: targetCardId,
        type: 'default',
        reconnectable: false,
        data: { relation: 'knowledge', knowledgePolicy },
        markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
      }
      map.edges.push(knowledgeLine)
      return knowledgeLine
    })
    return {
      mapId,
      version: saved.map.version,
      knowledgeLine: {
        id: result.id,
        sourceCardId: result.source,
        targetCardId: result.target,
        knowledgePolicy: knowledgePolicyOf(result),
      },
    }
  })

  registerTool(server, 'mindnprogress_update_knowledge_line', 'source와 target 카드로 지식선을 찾아 주요 지식 우선 또는 정보 부족 시 확인 정책만 변경합니다. 최신 버전에 관계만 다시 적용하므로 전체 문서 저장이 필요하지 않습니다.', {
    mapId: z.string().min(1),
    sourceCardId: z.string().min(1),
    targetCardId: z.string().min(1),
    knowledgePolicy: knowledgePolicySchema,
  }, async ({ mapId, sourceCardId, targetCardId, knowledgePolicy }) => {
    const { saved, result } = await mutateDocument(mapId, targetCardId, (map) => {
      const matches = map.edges.filter((edge) => isKnowledgeEdge(edge) && edge.source === sourceCardId && edge.target === targetCardId)
      if (matches.length === 0) throw new Error('변경할 지식선을 찾을 수 없습니다.')
      if (matches.length > 1) throw new Error('같은 카드 사이에 중복 지식선이 있어 안전하게 변경할 수 없습니다.')
      matches[0].data = { ...matches[0].data, relation: 'knowledge', knowledgePolicy }
      return matches[0]
    })
    return {
      mapId,
      version: saved.map.version,
      knowledgeLine: {
        id: result.id,
        sourceCardId: result.source,
        targetCardId: result.target,
        knowledgePolicy: knowledgePolicyOf(result),
      },
    }
  })

  registerTool(server, 'mindnprogress_delete_knowledge_line', 'source와 target 카드 사이의 지식선을 삭제합니다. 카드와 계층선은 변경하지 않으며 최신 버전에 관계 삭제만 다시 적용합니다.', {
    mapId: z.string().min(1),
    sourceCardId: z.string().min(1),
    targetCardId: z.string().min(1),
  }, async ({ mapId, sourceCardId, targetCardId }) => {
    const { saved, result } = await mutateDocument(mapId, targetCardId, (map) => {
      const matches = map.edges.filter((edge) => isKnowledgeEdge(edge) && edge.source === sourceCardId && edge.target === targetCardId)
      if (matches.length === 0) throw new Error('삭제할 지식선을 찾을 수 없습니다.')
      const deletedIds = new Set(matches.map((edge) => edge.id))
      map.edges = map.edges.filter((edge) => !deletedIds.has(edge.id))
      return matches.map((edge) => edge.id)
    })
    return {
      mapId,
      version: saved.map.version,
      deletedKnowledgeLineIds: result,
      sourceCardId,
      targetCardId,
    }
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

  registerTool(server, 'mindnprogress_save_document_layout', '좌측 목록의 그룹, 그룹 안 문서 순서, 그룹과 개별 문서가 섞인 최상위 순서를 저장합니다. 먼저 mindnprogress_list_documents로 현재 documentLayout과 전체 문서 ID를 확인하고, 모든 활성 문서를 정확히 한 번 포함하세요.', {
    documentLayout: documentLayoutSchema,
  }, async ({ documentLayout }) => apiRequest('/api/maps/layout', {
    method: 'PATCH',
    body: JSON.stringify({ documentLayout }),
  }))

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
  registerTool(server, 'mindnprogress_list_comments', '문서 또는 특정 카드의 댓글과 답글을 페이지 단위로 조회합니다. 기본 응답은 요약과 상세 존재 여부만 포함하며, 작업 근거나 검증 내용이 더 필요할 때 includeDetail=true를 사용하세요. 다음 댓글이 있으면 nextOffset을 offset으로 전달하세요.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1).optional().describe('댓글을 조회할 카드 ID. 생략하면 문서 전체 댓글 조회'),
    nodeId: z.string().min(1).optional().describe('기존 대화 호환용 카드 ID. 새 호출에서는 cardId 사용'),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
    order: z.enum(['asc', 'desc']).default('desc'),
    includeDetail: z.boolean().default(false),
  }, async ({ mapId, cardId, nodeId, offset, limit, order, includeDetail }) => {
    const resolvedCardId = resolveAliasedId(cardId, nodeId, {
      preferredName: 'cardId',
      legacyName: 'nodeId',
      required: false,
    })
    const query = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      order,
      includeDetail: String(includeDetail),
    })
    if (resolvedCardId) query.set('nodeId', resolvedCardId)
    return apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments?${query}`)
  })
  registerTool(server, 'mindnprogress_add_comment', '카드에 댓글 또는 답글을 요약과 상세로 작성합니다. 필수 summary는 [진행], [차단], [결과]로 시작하는 240자 이하의 1~2문장으로 작성하고, 긴 내용은 반드시 별도 detail 인자에 작업을 이어가거나 검증하는 데 필요한 수행 내용·판단·변경 범위·검증 결과·산출물·다음 단계 중 해당 내용을 충실히 기록하세요. summary 문자열 안에 detail이나 도구 호출 마크업을 이어 붙이거나 상세를 여러 댓글로 분산하지 마세요.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1).optional().describe('댓글을 작성할 카드 ID. 새 호출에서는 이 필드를 사용'),
    nodeId: z.string().min(1).optional().describe('기존 대화 호환용 카드 ID. 새 호출에서는 cardId 사용'),
    summary: z.string().min(1).max(commentSummaryMaxLength, commentSummaryTooLongMessage).describe('필수. [진행], [차단], [결과]로 시작하는 240자 이하의 1~2문장 요약. 긴 내용은 별도 detail 인자로 분리'),
    detail: z.string().max(6000).optional().describe('작업을 이어가거나 검증하는 데 필요한 상세 내용'),
    parentCommentId: z.string().min(1).optional().describe('답글을 작성할 상위 댓글 ID'),
    parentId: z.string().min(1).optional().describe('기존 대화 호환용 상위 댓글 ID. 새 호출에서는 parentCommentId 사용'),
  }, async ({ mapId, cardId, nodeId, summary, detail, parentCommentId, parentId }) => {
    const resolvedCardId = resolveAliasedId(cardId, nodeId, {
      preferredName: 'cardId',
      legacyName: 'nodeId',
    })
    const resolvedParentCommentId = resolveAliasedId(parentCommentId, parentId, {
      preferredName: 'parentCommentId',
      legacyName: 'parentId',
      required: false,
    })
    return runCommentWithAttribution(async () => {
      const result = await apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments`, {
        method: 'POST', aiCardId: resolvedCardId, requestAttributionContinuation: true,
        body: JSON.stringify({ nodeId: resolvedCardId, summary, detail, parentId: resolvedParentCommentId }),
      })
      adoptAttributionContinuation(result)
      return result
    })
  })
  registerTool(server, 'mindnprogress_update_comment', '기존 댓글 또는 답글의 요약과 상세를 제자리에서 수정합니다. summary를 보내면 기존 단일 본문 댓글도 summary-detail 형식으로 전환되므로, 향후 마이그레이션에서는 원문을 확인한 뒤 summary와 detail을 함께 보내세요. 댓글 ID, 작성자, 생성 시각, 답글 관계, 반응과 해결 상태는 유지됩니다.', {
    mapId: z.string().min(1),
    commentId: z.string().min(1),
    summary: z.string().min(1).max(240).optional(),
    detail: z.string().max(6000).optional().describe('빈 문자열이면 기존 상세 삭제'),
    text: z.string().min(1).max(1000).optional().describe('이전 호출과의 호환용. 새 형식 댓글의 요약 변경에는 summary 사용'),
    expectedText: z.string().max(1000).optional().describe('조건부 수정에 사용할 현재 댓글 원문. 서버 값과 다르면 다른 편집자의 변경을 덮어쓰지 않고 실패'),
  }, async ({ mapId, commentId, summary, detail, text, expectedText }) => {
    if (summary === undefined && detail === undefined && text === undefined) throw new Error('수정할 댓글 내용을 입력해 주세요.')
    return apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments/${encodeURIComponent(commentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ summary, detail, text, expectedText }),
    })
  })
  registerTool(server, 'mindnprogress_delete_comment', '댓글과 연결된 답글을 삭제합니다.', {
    mapId: z.string().min(1), commentId: z.string().min(1),
  }, async ({ mapId, commentId }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' }))
  registerTool(server, 'mindnprogress_set_comment_resolved', '댓글 스레드의 해결 또는 다시 열기 상태를 변경합니다.', {
    mapId: z.string().min(1), commentId: z.string().min(1), resolved: z.boolean(),
  }, async ({ mapId, commentId, resolved }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments/${encodeURIComponent(commentId)}/resolve`, { method: 'PATCH', body: JSON.stringify({ resolved }) }))
  registerTool(server, 'mindnprogress_toggle_comment_reaction', '댓글의 이모지 반응을 추가하거나 취소합니다.', {
    mapId: z.string().min(1), commentId: z.string().min(1), emoji: z.enum(['👍', '❤️', '🎉', '👀']),
  }, async ({ mapId, commentId, emoji }) => apiRequest(`/api/maps/${encodeURIComponent(mapId)}/comments/${encodeURIComponent(commentId)}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }))

  registerTool(server, 'mindnprogress_get_ai_conversation_transcript', '카드에 연결된 AionUi 대화의 전체 내용을 AionUi 세션 목록의 "전체 복사"와 같은 텍스트 형식으로 조회합니다. conversationId를 생략하면 최근 연결 대화를 사용하고, 여러 대화 중 하나를 지정할 수 있습니다. 사용자·어시스턴트·시스템 메시지를 시간순으로 반환하며 도구 호출 메시지는 제외합니다.', {
    mapId: z.string().min(1),
    cardId: z.string().min(1),
    conversationId: z.string().min(1).max(120).optional().describe('여러 연결 대화 중 조회할 대화 ID. 생략하면 최근 연결 대화'),
  }, async ({ mapId, cardId, conversationId: requestedConversationId }) => {
    const map = await getDocument(mapId)
    const card = map.nodes.find((node) => node.id === cardId)
    if (!card) throw new Error('카드를 찾을 수 없습니다.')
    const conversationId = String(requestedConversationId ?? card.data?.aiConversationId ?? '').trim()
    if (!conversationId) throw new Error('카드에 연결된 AI 대화가 없습니다.')
    return apiRequest(`/api/integrations/aionui/conversations/${encodeURIComponent(conversationId)}/transcript`, {
      aiMapId: mapId,
      aiCardId: cardId,
    })
  })

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
