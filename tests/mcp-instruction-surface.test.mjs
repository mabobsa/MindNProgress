import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MNP_MCP_SERVER_INSTRUCTIONS } from '../src/utils/aiContextInstructions.mjs'
import { storageWriteTools } from '../mcp/storageRequests.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/mcp-tool-input-schema.json'), 'utf8'))
const budget = JSON.parse(await readFile(path.join(root, 'tests/fixtures/ai-instruction-budget.json'), 'utf8'))
const baseline = JSON.parse(await readFile(path.join(root, 'docs/ai-guidance-rollback-2026-10-01/baseline-guide-sources.json'), 'utf8')).sources['mcp/server.mjs']
const baselineDescriptions = new Map([...baseline.matchAll(/^\s*registerTool\(server, '([^']+)', ('(?:\\.|[^'])*'|`[^`]*`), /gm)]
  .map((match) => [match[1], match[2]]))
const safetyTools = new Set(['mindnprogress_restore_history', 'mindnprogress_update_document_info', 'mindnprogress_recover_ai_delegation'])
// 코드로 필드를 꺼내는 AI가 생략된 경로를 조용히 빈 값으로 읽지 않도록, 덧붙인 안내는 생략될 수 있는 필드와 회수 경로를 이름으로 밝힌다.
const responseBudgetAppendices = new Map([
  ['mindnprogress_get_context', /^ focused 응답이 약 4만 자를 넘으면 guide·groupProject·selection\.taskLinks·selection\.aiWorkCoordination·nextStep 등 규칙은 그대로 두고 덜 중요한 데이터부터 생략하며, 생략 여부와 경로·회수 도구를 응답 앞쪽의 contextBudget과 omitted에 표기합니다\. 생략될 수 있는 것은 선행 지식 원천의 설명·댓글·sharedKnowledge, 문서 지식선·개요, 관계 카드의 대기 상세, 선택 카드의 댓글과 description·sharedKnowledge 등 큰 필드입니다\. 생략된 원문은 추측하지 말고 omitted\.retrieval로 읽으세요\.$/],
  ['mindnprogress_list_ai_delegations', /^ 응답이 약 4만 자를 넘으면 판단이 필요한 위임\(미종료·실패·복구 가능·종료 처리 가능·보고 대기\)과 미해결 접수 실패는 그대로 두고 정리된 이력\(완료·대체·종료된 위임과 재접수 확인·종료된 접수 실패\)만 결과 원문 생략, 요약\(summary=true\), 오래된 이력 개수화 순으로 줄이며, 줄인 범위와 회수 경로를 응답 앞쪽 responseBudget과 omitted에 표기합니다\. 생략된 위임은 delegationId로 한 건씩 조회하세요\.$/],
  ['mindnprogress_get_document', /^ outline 응답이 약 4만 자를 넘으면 구조·상태·계층과 cardIds로 고른 카드 전문은 그대로 두고 큰 비원문 필드, 검증 해시, 갱신 메타데이터, 대기 메모, 대기 항목, 카드 보조 필드, 지식선 순으로 줄이며, 줄인 범위와 회수 경로를 응답 앞쪽 responseBudget과 omitted에 표기합니다\. 대기·완료 판단에 필요한 원문은 omitted\.retrieval로 먼저 읽으세요\.$/],
  ['mindnprogress_get_card', /^ fields로 필요한 data 필드만, includeComments=false로 댓글 없이 받을 수 있으며 get_context의 omitted\.retrieval이 이 인자를 안내합니다\. textIntegrity는 fields와 무관하게 항상 description·sharedKnowledge 전체 기준입니다\. 응답이 약 4만 자를 넘으면 댓글 페이지를 먼저 줄이고\(남은 댓글은 list_comments의 nextOffset으로 조회\), 그래도 넘으면 fields로 고르지 않은 2,000자 초과 보조 필드와 description·sharedKnowledge 원문\(큰 것부터\)을 생략해 card\.omittedFields와 응답 앞쪽 responseBudget·omitted에 표기합니다\. 생략한 필드는 fields로 한 필드씩 조회하세요\.$/],
  ['mindnprogress_list_comments', /^ 응답이 약 4만 자를 넘으면 요청 순서의 앞쪽 댓글부터 예산에 드는 만큼만 반환하고 limit·nextOffset을 반환한 댓글 기준으로 맞추며, 응답 앞쪽 responseBudget과 omitted에 표기합니다\. 반환한 댓글의 상세는 줄이지 않고 건너뛴 댓글도 없으니 hasMore가 true이면 nextOffset으로 이어서 조회하세요\.$/],
  ['mindnprogress_add_card', /^ affected의 affectedCards에는 서버가 함께 조정한 카드\(상위 진행률·Root 집계 등\)의 상태 요약과 changedKeys만 있습니다\.$/],
  ['mindnprogress_move_card', /^ 같은 문서 안 이동의 affected 응답에서 card는 바뀌지 않은 1,000자 초과 필드를 card\.omittedFields와 textIntegrity로만 표시하고, affectedCards에는 서버가 함께 조정한 카드의 상태 요약과 changedKeys만 있습니다\.$/],
  ['mindnprogress_delete_card', /^ affectedCards에는 서버가 함께 조정한 카드의 상태 요약과 changedKeys만 있습니다\.$/],
  ['mindnprogress_list_documents', /^ 응답이 약 4만 자를 넘으면 문서 항목은 모두 두고 maps\[\]와 같은 값인 documentGroups, 작성자 이메일·권한, groupProject의 중복 항목, 빈 필드 순으로 줄이며, 그래도 넘으면 문서별 식별·상태·그룹 필드만 남기고 응답 앞쪽 responseBudget과 omitted에 표기합니다\. 그룹 정보는 documentGroups 대신 각 문서의 maps\[\]\.group·groupMembership·groupProject를 읽으세요\.$/],
  ['mindnprogress_list_group_document_instructions', /^ 응답이 약 4만 자를 넘으면 queued·delivered 지시는 그대로 두고 대상 문서별 최신 지시는 마지막까지 남기며, 정리된 이력만 오래된 지시부터 원문 생략, 요약\(summary=true\), 개수화 순으로 줄여 응답 앞쪽 responseBudget과 omitted에 표기합니다\. 생략된 지시는 instructionId와 includeContent=true로 한 건씩 조회하세요\.$/],
  ['mindnprogress_update_card', /^ affected의 card는 이번에 보낸 필드와 저장 중 바뀐 필드를 원문으로 주고, 그 밖의 1,000자 초과 필드는 card\.omittedFields와 textIntegrity로만 표시합니다\. affectedCards에는 요청 카드를 빼고 서버가 함께 조정한 카드의 상태 요약과 changedKeys만 있습니다\.$/],
  // 2026-11-09: 위임 AI 설정은 서버 위임 규칙이 정한다. 규칙 표 자체는 설명에 옮겨 적지 않는다(규칙 변경 때 AI에 다시 전달하지 않기 위해서).
  ['mindnprogress_delegate_ai_work', /^ 새 대화의 CLI·모델·사고 강도는 서버 위임 규칙이.*하위 카드도 담당 대화를 우선합니다\..*일치 모델의 최신 연결 대화를 선택하고, 없을 때만 새 대화를 생성합니다\..*aiPolicy.primaryResolution.*중단된 동일 위임의 복구.*instruction은 새 대화도 이해하도록 쓰세요\.$/],
  ['mindnprogress_send_group_document_instruction', /^ 기본 수신자는 AI 대화 선택에서 체크한 담당 대화\(primaryConversationId\)입니다\..*규칙 모델과 일치하는 최신 대화를 담당으로 바꾸어 이어갑니다\..*일치하는 대화가 없으면 규칙에 맞는 새 대화를 생성해 담당으로 지정합니다\..*aiPolicy.primaryResolution.*targetConversationRole=auxiliary.*사용합니다\.$/],
])
// send_group_document_instruction(실제 서버 동작에 맞춘 정정)과 get_document(2026-10-21 승인 view 인자)는 재생성 기준선과
// 설명이 같아졌으므로 다른 도구와 같이 기준선 전문 비교 대상이다. 아래 의미 검사는 재생성 이후를 대비한 보조 안전망이다.
function countSchemaDescriptions(value) {
  if (!value || typeof value !== 'object') return 0
  return (typeof value.description === 'string' ? 1 : 0)
    + Object.values(value).reduce((sum, child) => sum + countSchemaDescriptions(child), 0)
}

test('최신 61개 이름·input schema와 복구한 도구 설명 전문을 검증한다', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'mcp/server.mjs')],
    env: { ...process.env, MNP_MCP_USAGE_DISABLED: '1' },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'rollback-surface-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const registeredInstructions = client.getInstructions()
    const tools = [...(await client.listTools()).tools].sort((a, b) => a.name.localeCompare(b.name))
    assert.deepEqual(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })), fixture)
    assert.equal(tools.length, 61)
    // 새 위임·그룹 지시 idempotencyKey에서 콜론을 뺐다(서브 머신 Runner가 실행 ID 경로의 콜론을 거부함).
    // 2026-11-09: tools/list에서 $schema와 정수 표현 한도(MAX_SAFE_INTEGER)만 뺀다(mcp/toolListSurface.mjs). 입력 검증은 그대로다.
    assert.ok(tools.every((tool) => !('$schema' in tool.inputSchema)) && !JSON.stringify(tools).includes(String(Number.MAX_SAFE_INTEGER)))
    // REQ-MNP-04: 기존 변경 도구의 requestId/resultOnly 호환 확장. 도구 개수는 유지한다.
    // 2026-10-29: get_group_context의 detailLevel·mapId와 list_group_document_instructions의 instructionId를 추가했다.
    // 2026-10-29: get_context 응답 예산의 회수 경로로 get_card에 fields·includeComments를 추가했다.
    // 2026-10-29: list_ai_delegations 응답 예산의 회수 경로로 delegationId를 추가했다.
    // 2026-11-01: 사용자 승인으로 자기 카드 후속 대화 도구 하나를 추가한다. 기존 60개 계약은 유지한다.
    // 2026-11-01: 같은 도구의 newConversation에 Claude 계정 선택(claudeAccountId)을 추가한다. 기존 60개 계약은 유지한다.
    // 2026-11-02(130de8d): delegate_ai_work·send_group_document_instruction의 newConversation에 Claude 계정 번호·ID
    //   (claudeAccountNumber·claudeAccountId)를 추가하고 start_card_conversation의 계정 안내를 정리했다. 도구 개수는 유지한다.
    // 2026-11-02(b1b2de6): recover_ai_delegation 설명에 통합 후보의 Git 상태 조회 실패 복구를 추가했다.
    // 2026-11-03(6b032e2): checkpoint_ai_workspace의 commit-changes paths 설명에 폴더 범위와 삭제 포함을 추가했다.
    // 2026-11-09: delegate_ai_work·send_group_document_instruction에 위임 규칙 입력(workType·analysisDepth·aiPolicyOverride)을
    //   추가하고 newConversation의 agentId·modelId를 선택 항목으로 바꿨다. 도구 개수는 유지한다.
    // 2026-11-09: 문맥 손실 없는 표면 축소로 tools/list의 $schema·MAX_SAFE_INTEGER 한도를 빼고(A1),
    //   저장 도구 23개의 설명 꼬리말에서 resultOnly 속성 설명과 같은 문장을 뺐다(B1). 83,542자 → 79,258자.
    // 2026-11-10: 그룹 지시에 담당·보조 역할과 규칙 모델별 담당 자동 선택을 추가한다.
    // 2026-11-11: 중단된 통합 충돌 복구에 원본 해시를 지정하는 선택적 줄바꿈 보존·정리를 추가한다.
    assert.equal(createHash('sha256').update(JSON.stringify(tools.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest('hex'), '95d8ad72e99d6eb4472b96d96f2d0cf5311ab97a127e8ed19d5556c1cfd335f0')
    // 2026-11-11: 자동 루트 인계의 후속 대화가 보내는 acceptHandoff 인수 확인을 추가한다.
    const legacyTools = tools.filter((tool) => tool.name !== 'mindnprogress_start_card_conversation')
    assert.equal(createHash('sha256').update(JSON.stringify(legacyTools.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest('hex'), 'cbbadb1bcdcd52704b0f93110816a129134d4a5b133c34c84fe7cb62601e7d5a')
    assert.equal(tools.reduce((sum, tool) => sum + countSchemaDescriptions(tool.inputSchema), 0), 238)
    const handoff = tools.find((tool) => tool.name === 'mindnprogress_start_card_conversation')
    assert.deepEqual(handoff.inputSchema.required, ['mapId', 'cardId', 'requestId'])
    assert.equal(handoff.inputSchema.properties.resultOnly.type, 'boolean')
    assert.equal(handoff.inputSchema.properties.acceptHandoff.type, 'boolean')
    assert.equal(handoff.inputSchema.properties.newConversation.properties.claudeAccountId.maxLength, 120)
    assert.match(handoff.description, /자기 원본 카드.*첫 메시지.*현재 대화는 중지하지.*같은 requestId/s)
    for (const tool of tools.filter((tool) => storageWriteTools.has(tool.name))) {
      assert.ok(tool.inputSchema.properties.requestId.pattern || tool.inputSchema.properties.proposalRequestId)
      assert.equal(tool.inputSchema.properties.resultOnly.type, 'boolean')
      // 2026-11-09: resultOnly 안내는 같은 뜻의 속성 설명에만 두고, 재전송 안내는 응답 유실 문장에 합쳤다.
      assert.match(tool.description, / 응답 유실은 unknown이며 같은 requestId로 재전송하거나 확인합니다\./)
      assert.match(tool.inputSchema.properties.resultOnly.description, /requestId만으로 기존 결과를 조회하며 저장을 시작하지 않음/)
    }
    const metaRecovery = tools.find(tool => tool.name === 'mindnprogress_recover_ai_delegation').inputSchema.properties.untrackedMetaRecovery
    assert.deepEqual(metaRecovery.required, ['path', 'expectedSha256', 'mainCommit'])
    assert.equal(metaRecovery.additionalProperties, false)
    assert.match(metaRecovery.description, /사용자가 승인한.*원본 보존.*같은 GUID.*다른 변경은 정리하지/s)
    const eolRecovery = tools.find(tool => tool.name === 'mindnprogress_recover_ai_delegation').inputSchema.properties.trackedEolRecovery
    assert.deepEqual(eolRecovery.required, ['expectedHead', 'files'])
    assert.equal(eolRecovery.additionalProperties, false)
    assert.equal(eolRecovery.properties.files.items.additionalProperties, false)
    assert.match(eolRecovery.description, /사용자가 승인한.*원본 백업.*내용 차이.*거부/s)
    // 2026-10-22 작업 트리 기준 재생성 기준선(capture-guidance-evidence.mjs --rebaseline-working-tree)의 registerTool 직접 등록 수
    assert.equal(baselineDescriptions.size, 58)
    for (const tool of tools) {
      if (safetyTools.has(tool.name) || tool.name ==='mindnprogress_search_content' || tool.name === 'mindnprogress_patch_card_text'
        || ['mindnprogress_get_shared_knowledge_review_context', 'mindnprogress_apply_shared_knowledge_review'].includes(tool.name)) continue
      const original = baselineDescriptions.get(tool.name)
      if (!original) continue // 배열로 등록되는 복구 도구는 아래 의미 검사에서 검증한다.
      const currentDescription = storageWriteTools.has(tool.name) ? tool.description.split(' 응답 유실은 unknown이며 같은 requestId로')[0] : tool.description
      // 그룹 문맥 요약 기본값(2026-10-29)은 기준선 설명을 그대로 두고 summary·full 안내만 뒤에 덧붙였다.
      if (tool.name === 'mindnprogress_get_group_context') {
        assert.ok(currentDescription.startsWith(original.slice(1, -1)), `${tool.name}의 기준선 설명 문장을 그대로 유지한다.`)
        assert.match(currentDescription.slice(original.length - 2), /^ 기본 detailLevel=summary는 project·guide 전문.*회수 경로를 detail.*판단하기 전에는 그 경로로 해당 원문을 읽으세요.*full.*도구 출력 한도/s)
        // 코드로 필드를 꺼내는 AI가 summary에 없는 경로를 조용히 빈 값으로 읽지 않도록 생략 필드를 이름으로 밝힌다.
        assert.match(currentDescription, /root\.data에는 description·sharedKnowledge가 없고 길이·SHA-256만 root\.textIntegrity에 있으며, documentInstructions에는 지시·응답 원문이 없습니다/)
        continue
      }
      // 응답 크기 예산(2026-10-29)도 기준선 설명을 그대로 두고 생략·회수 안내만 뒤에 덧붙였다.
      if (responseBudgetAppendices.has(tool.name)) {
        assert.ok(currentDescription.startsWith(original.slice(1, -1)), `${tool.name}의 기준선 설명 문장을 그대로 유지한다.`)
        assert.match(currentDescription.slice(original.length - 2), responseBudgetAppendices.get(tool.name))
        continue
      }
      // 과거 기준선은 보존하고 사용자가 변경한 화면 명칭만 현재 이름으로 대조한다.
      const expectedDescription = tool.name === 'mindnprogress_get_dooray_response_approval'
        ? original.slice(1, -1).replace(/^Dooray 참조에서/, 'Dooray 업무 대응에서')
        : original.slice(1, -1)
      assert.equal(currentDescription, expectedDescription, `${tool.name}의 기준선 상세 설명이 달라졌습니다.`)
    }

    const descriptions = new Map(tools.map(({ name, description }) => [name, description]))
    assert.match(descriptions.get('mindnprogress_get_shared_knowledge_review_context'), /reviewContextToken.*그대로.*기대값을 자동 교체하지/s)
    assert.match(descriptions.get('mindnprogress_apply_shared_knowledge_review'), /설명·종류·관계·댓글·Ref 출처.*무관한 문서 버전.*생략한 기존 요청.*엄격한 문서 버전.*충돌 시 변경 없이 거부/s)
    assert.match(descriptions.get('mindnprogress_restore_history'), /복원 직전.*백업.*전체.*교체.*변경.*새.*이력.*get_document.*list_history/s)
    assert.match(descriptions.get('mindnprogress_update_document_info'), /최신 baseVersion.*force=true.*사용자가 명시적으로 승인.*get_document/s)
    const getDocument = descriptions.get('mindnprogress_get_document')
    const getDocumentSchema = tools.find((tool) => tool.name === 'mindnprogress_get_document').inputSchema
    assert.ok(getDocument.startsWith(baselineDescriptions.get('mindnprogress_get_document').slice(1, -1)), 'get_document 기준선 설명 문장을 그대로 유지한다.')
    assert.match(getDocument, /view를 생략하면 기존과 같은 full.*compact.*outline.*cardIds.*omitted.*version.*같은 view·cardIds로 받은 응답의 documentEtag를 ifNoneMatch.*knownVersion은 version 일치 여부만.*본문을 생략하지 않습니다.*재구성.*restore_history.*전수 감사.*지식선 전역 점검에는 full/s)
    assert.match(getDocumentSchema.properties.ifNoneMatch.description, /같은 view·cardIds로 받은.*다른 view·cardIds 응답의 documentEtag는 일치하지 않음/s)
    assert.match(getDocumentSchema.properties.knownVersion.description, /본문은 생략하지 않음.*full 응답에는 freshness가 없으므로/s)
    // outline 응답 예산(2026-10-29)은 기준선 설명 전문 뒤에 안내만 덧붙였다.
    assert.match(getDocument.slice(baselineDescriptions.get('mindnprogress_get_document').length - 2), responseBudgetAppendices.get('mindnprogress_get_document'), 'get_document 기준선 설명 뒤에 outline 예산 안내만 덧붙인다')
    const groupInstructionBaseline = baselineDescriptions.get('mindnprogress_send_group_document_instruction').slice(1, -1)
    assert.ok(descriptions.get('mindnprogress_send_group_document_instruction').startsWith(groupInstructionBaseline), 'send_group_document_instruction 기준선 설명 전문 뒤에 위임 규칙 안내만 덧붙인다')
    for (const name of ['mindnprogress_delegate_ai_work', 'mindnprogress_send_group_document_instruction']) {
      const schema = tools.find((tool) => tool.name === name).inputSchema
      assert.ok(schema.required.includes('workType'), `${name}은 업무 유형을 반드시 받는다`)
      assert.deepEqual(schema.properties.workType.enum, ['review', 'other'])
      assert.deepEqual(schema.properties.analysisDepth.enum, ['standard', 'deep'])
      assert.deepEqual(schema.properties.newConversation.required ?? [], [], `${name}의 newConversation은 AI 종류·모델을 요구하지 않는다`)
      assert.doesNotMatch(JSON.stringify(schema), /gpt-6\.1-sol|opus|xhigh/, '규칙 값은 도구 정의에 옮겨 적지 않는다')
    }
    assert.deepEqual(getDocumentSchema.required, ['mapId'])
    assert.deepEqual(getDocumentSchema.properties.view.enum, ['full', 'compact', 'outline', 'version'])
    assert.equal(Object.hasOwn(getDocumentSchema.properties.view, 'default'), false, 'view 기본값은 서버에서 full로 처리한다')
    assert.match(descriptions.get('mindnprogress_restore_history'), /복원 직전 view를 생략한 get_document\(full\)로 현재 문서를 백업/)
    assert.match(descriptions.get('mindnprogress_recover_ai_delegation'), /복구.*mindnprogress_list_ai_delegations.*상태.*확인/s)
    assert.match(descriptions.get('mindnprogress_recover_ai_delegation'), /index.lock, main HEAD 변경 또는 통합 후보의 Git 상태 조회 실패.*하위 AI 작업은 다시 실행하지 않습니다.*잠금은 자동 삭제하지.*최신 main 기준으로 통합/s)
    assert.match(descriptions.get('mindnprogress_search_content'), /ranked.*catalog.*page.hasMore.*coverage/s)
    // 2026-11-03: 응답 예산은 동작 설명만 덧붙인다. 사용을 권하는 안내는 넣지 않는다(read_me_first·get_context에도 추가하지 않음).
    assert.match(descriptions.get('mindnprogress_search_content'), / 응답이 약 4만 자를 넘으면 요청한 limit보다 적은 앞쪽 결과만 반환하고 page\.limit·nextCursor를 반환한 결과 기준으로 맞추며 응답 앞쪽 responseBudget에 표기합니다\. 건너뛴 결과는 없으니 page\.hasMore가 true이면 nextCursor로 이어서 조회하세요\.$/)
    const groupInstruction = descriptions.get('mindnprogress_send_group_document_instruction')
    assert.ok(groupInstruction.startsWith(baselineDescriptions.get('mindnprogress_send_group_document_instruction').slice(1, -1).split('완료 보고는 기본적으로')[0]), '정정 전 설명의 앞부분은 기준선과 같다.')
    assert.match(groupInstruction, /첫 응답 턴만 replied 상태와 response로 기록.*자동 재개하거나 이후 턴의 보고를 전달하지 않습니다.*session-message로 회신 대상 대화에 직접.*기본 대상은 현재 총괄 대화.*replyTarget을 explicit/s)
    assert.doesNotMatch(groupInstruction, /완료 보고는 기본적으로 현재 총괄 대화로 돌아오며/)
    assert.match(groupInstruction, /queued·delivered·replied 상태를 업무 완료로 해석하지 마세요/)
    const groupContextSchema = tools.find((tool) => tool.name === 'mindnprogress_get_group_context').inputSchema
    assert.deepEqual(groupContextSchema.required, ['groupId'])
    assert.deepEqual(groupContextSchema.properties.detailLevel.enum, ['summary', 'full'])
    assert.equal(groupContextSchema.properties.detailLevel.default, 'summary')
    assert.match(groupContextSchema.properties.mapId.description, /생략하면 get_context로 연결한 문서/)
    const instructionListSchema = tools.find((tool) => tool.name === 'mindnprogress_list_group_document_instructions').inputSchema
    assert.deepEqual(instructionListSchema.required, ['mapId'])
    assert.match(instructionListSchema.properties.instructionId.description, /한 건만.*GROUP_DOCUMENT_INSTRUCTION_NOT_FOUND/)
    const listSchema = tools.find((tool) => tool.name === 'mindnprogress_list_ai_delegations').inputSchema.properties
    assert.match(listSchema.includeResult.description, /resultHash는 반환된 result 문자열\(절단 표시 포함\) 기준.*resultTruncated=true/s)
    assert.match(listSchema.includeFullResult.description, /resultFull.*수신 확인에는 resultFullHash가 아니라 resultHash/s)
    assert.match(descriptions.get('mindnprogress_refresh_ai_delegation'), /dispatch-delivered.*reportStatus=received인 위임은 다시 확인하지 않아도.*state는 completed가 되며 이는 보고 수신 기록일 뿐/s)
    assert.match(MNP_MCP_SERVER_INSTRUCTIONS, /read_me_first.*get_context.*guide.*nextStep/s)
    assert.equal(MNP_MCP_SERVER_INSTRUCTIONS.length, budget.sourceConstantChars)
    assert.equal(createHash('sha256').update(MNP_MCP_SERVER_INSTRUCTIONS).digest('hex'), budget.sourceConstantSha256)
    assert.ok(registeredInstructions.startsWith(MNP_MCP_SERVER_INSTRUCTIONS))
    assert.match(registeredInstructions, /Dooray 승인 새 대화.*get_dooray_response_approval.*승인 범위/s)
    assert.ok(registeredInstructions.length > MNP_MCP_SERVER_INSTRUCTIONS.length)
    assert.equal(registeredInstructions.length, budget.serverInstructionsChars)
    assert.equal(createHash('sha256').update(registeredInstructions).digest('hex'), budget.serverInstructionsSha256)
    assert.equal(tools.reduce((sum, tool) => sum + tool.description.length, 0), budget.toolDescriptionChars)
    assert.equal(tools.reduce((sum, tool) => sum + tool.name.length, 0), budget.toolNameChars)
    assert.equal(tools.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema).length, 0), budget.inputSchemaJsonChars)
    assert.equal(budget.hostMetadata.measured, false)
    assert.equal(budget.rawRegisteredSurfaceChars, registeredInstructions.length + budget.toolNameChars + budget.toolDescriptionChars + budget.inputSchemaJsonChars)
  } finally {
    await client.close()
  }
})
