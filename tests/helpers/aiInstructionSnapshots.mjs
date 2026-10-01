import {
  AI_DELEGATION_FOLLOWUP_INSTRUCTION,
  AI_DELEGATION_REPORT_INSTRUCTION,
  AI_EXECUTION_APPROVAL_INSTRUCTION,
  DOCUMENT_COORDINATOR_INSTRUCTION,
  GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION,
  GROUP_APPROVAL_INSTRUCTION,
  buildGroupCoordinatorRequest,
  buildGroupDocumentProposalRequest,
  buildGroupDocumentRequest,
} from '../../src/utils/aiApprovalInstructions.mjs'
import { MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, MNP_MCP_SERVER_INSTRUCTIONS } from '../../src/utils/aiContextInstructions.mjs'
import { buildAiConversationPrompt, buildSharedKnowledgeCleanupRequest } from '../../src/utils/aiConversationLaunch.mjs'
import { buildWorkspaceInstruction } from '../../server/lib/workspacePool.mjs'
import { buildGroupDocumentInstruction } from '../../server/lib/groupDocumentInstructions.mjs'
import { buildDoorayReviewPrompt } from '../../server/lib/doorayResponses.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The restored production builders live in the server entry point. Evaluate their
// current source with isolated dependencies to snapshot the actual delivered text.
const serverSource = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/index.mjs'), 'utf8')
function extract(first, last) {
  const start = serverSource.indexOf(first)
  const end = serverSource.indexOf(last, start + first.length)
  if (start < 0 || end < 0) throw new Error(`서버 전문 조립 경계를 찾지 못했습니다: ${first}`)
  return serverSource.slice(start, end)
}
const instructionBuilders = vm.runInNewContext(`${extract('function buildDelegatedInstruction(', 'function sendGroupDocumentInstructionResponse(')}
${extract('function delegationRecoveryInstruction(', 'function delegationPublicView(')}
${extract('function aiDelegationResultSection(', 'function aiDelegationRecoveryKey(')}
({ buildDelegatedInstruction, delegationRecoveryInstruction, parentWakeInstruction })`, {
  MNP_CONTEXT_BOOTSTRAP_INSTRUCTION, buildWorkspaceInstruction,
  DOCUMENT_COORDINATOR_INSTRUCTION, AI_EXECUTION_APPROVAL_INSTRUCTION, GROUP_APPROVAL_INSTRUCTION,
  AI_DELEGATION_FOLLOWUP_INSTRUCTION, GROUP_AI_DELEGATION_FOLLOWUP_INSTRUCTION, AI_DELEGATION_REPORT_INSTRUCTION,
  groupProjects: { forDocument: async () => null },
  readMap: async () => null, documentRoot: () => null,
  aiDelegationReportResult: () => ({ availability: 'captured', text: '구현과 검증을 완료했습니다.' }),
  aiDelegationSucceeded: () => true,
  resolveAiConversationDisplay: async () => ({ displayLabel: '하위 대화' }),
  delegationTargetMachineId: () => 'machine-fixture',
})
const { buildDelegatedInstruction, delegationRecoveryInstruction, parentWakeInstruction } = instructionBuilders

const identity = {
  mapId: 'map-fixture',
  cardId: 'card-fixture',
  editorId: 'editor-fixture',
  attributionToken: 'token-fixture',
}

const workspaceLease = {
  workspaceId: 'worker-01',
  jobId: 'job-fixture',
  leaseId: 'lease-fixture',
  projectRoot: 'C:\\Git\\Fixture_Worker01',
  sharedRoot: 'C:\\Git\\Fixture_Shared',
  branch: 'ai/job-fixture',
  baseCommit: 'a'.repeat(40),
  assetsPath: 'C:\\Git\\Fixture_Worker01\\Assets',
  unityInstanceHash: 'fixturehash',
}

const delegation = {
  id: 'delegation-fixture',
  mapId: identity.mapId,
  parentMapId: identity.mapId,
  targetCardId: identity.cardId,
  targetCardLabel: '하위 카드',
  targetConversationId: 'conversation-child',
  childTurnId: 'turn-child',
  decisionReason: '현재 작업 문맥을 이어갑니다.',
  strategy: 'resume',
  workspaceLease,
}

const conversationPrompt = (purpose, request) => buildAiConversationPrompt({ ...identity, purpose, request })
const workerInstruction = '승인된 카드 구현과 검증을 수행하고 결과를 기록하세요.'

export async function buildAiInstructionSnapshots() {
  const groupRequest = buildGroupCoordinatorRequest({ groupId: 'group-fixture' })
  const groupProposalRequest = buildGroupCoordinatorRequest({
    groupId: 'group-fixture',
    instruction: buildGroupDocumentProposalRequest({ mapId: 'map-child', cardId: 'root-child', title: '하위 문서' }),
  })
  const recovery = delegationRecoveryInstruction(
    delegation,
    workerInstruction,
    { failureCategory: 'user-stop' },
    '하위 대화 (conversation-child)',
  )
  const result = { availability: 'captured', text: '구현과 검증을 완료했습니다.' }
  const doorayJob = {
    route: { mapId: identity.mapId, cardId: identity.cardId, documentTitle: '문서', cardTitle: '카드' },
    source: { subject: 'Dooray 요청', item: { url: 'https://dooray.example/task/1' } },
    userId: identity.editorId,
  }
  return [
    { name: 'unselected', text: '', router: MNP_MCP_SERVER_INSTRUCTIONS },
    { name: 'leaf-new', text: conversationPrompt('card', '현재 카드의 승인된 작업을 수행하세요.') },
    { name: 'group-coordinator-new', text: conversationPrompt('group-coordination', groupRequest) },
    { name: 'group-proposal-only', text: conversationPrompt('group-coordination', groupProposalRequest) },
    { name: 'document-coordinator-new', text: conversationPrompt('card', buildGroupDocumentRequest({ groupId: 'group-fixture', groupName: '기획 그룹' })) },
    { name: 'document-delivery', text: buildGroupDocumentInstruction({
      groupId: 'group-fixture', parentMapId: 'map-parent', targetMapId: identity.mapId,
      targetCardId: identity.cardId, targetRevision: 3, groupProjectVersion: 5,
      instructionId: 'instruction-fixture', parentConversationId: 'conversation-parent',
      instructionType: 'execution', approvalScope: 'implementation',
      approvalEvidence: '사용자가 이 문서의 구현 범위를 승인했습니다.', instruction: workerInstruction,
      editorId: identity.editorId, attributionToken: identity.attributionToken,
      documentCoordinatorInstruction: DOCUMENT_COORDINATOR_INSTRUCTION,
    }) },
    { name: 'worker-new-no-lease', text: buildDelegatedInstruction({ ...identity, instruction: workerInstruction }) },
    { name: 'worker-new-lease', text: buildDelegatedInstruction({ ...identity, instruction: workerInstruction, workspaceLease }) },
    { name: 'worker-resume', text: buildDelegatedInstruction({ ...identity, instruction: workerInstruction }) },
    { name: 'shared-knowledge-proposal', text: conversationPrompt('shared-knowledge-review', buildSharedKnowledgeCleanupRequest({})) },
    { name: 'parent-wake', text: await parentWakeInstruction(delegation, result) },
    { name: 'group-parent-wake', text: await parentWakeInstruction({ ...delegation, groupId: 'group-fixture' }, result) },
    { name: 'user-stop-recovery', text: buildDelegatedInstruction({ ...identity, instruction: recovery, workspaceLease }) },
    { name: 'reconstruction', text: conversationPrompt('document-reconstruction', '최신 문서를 읽고 재구성 제안만 작성하세요.') },
    { name: 'layout', text: conversationPrompt('card-layout', '현재 계층을 보존한 배치 제안만 작성하세요.') },
    { name: 'dooray-proposal', text: buildDoorayReviewPrompt(doorayJob, 'dooray-operation-fixture', { document: { id: identity.mapId }, card: { id: identity.cardId } }) },
    { name: 'dooray-approval', text: buildAiConversationPrompt({
      purpose: 'dooray-response', editorId: identity.editorId, attributionToken: identity.attributionToken,
      request: '승인된 제안 범위만 실행하세요.',
      doorayApproval: { responseId: 'dooray-fixture', proposalRevision: 'b'.repeat(64) },
    }) },
  ]
}

export function buildOrdinaryRecoverySnapshot() {
  const recovery = delegationRecoveryInstruction(delegation, workerInstruction, { failureCategory: 'restart' }, '하위 대화')
  return buildDelegatedInstruction({ ...identity, instruction: recovery, workspaceLease })
}
