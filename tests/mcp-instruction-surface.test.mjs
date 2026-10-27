import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MNP_MCP_SERVER_INSTRUCTIONS } from '../src/utils/aiContextInstructions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/mcp-tool-input-schema.json'), 'utf8'))
const budget = JSON.parse(await readFile(path.join(root, 'tests/fixtures/ai-instruction-budget.json'), 'utf8'))
const baseline = JSON.parse(await readFile(path.join(root, 'docs/ai-guidance-rollback-2026-10-01/baseline-guide-sources.json'), 'utf8')).sources['mcp/server.mjs']
const baselineDescriptions = new Map([...baseline.matchAll(/^\s*registerTool\(server, '([^']+)', ('(?:\\.|[^'])*'|`[^`]*`), /gm)]
  .map((match) => [match[1], match[2]]))
const safetyTools = new Set(['mindnprogress_restore_history', 'mindnprogress_update_document_info', 'mindnprogress_recover_ai_delegation'])
// send_group_document_instruction(실제 서버 동작에 맞춘 정정)과 get_document(2026-10-21 승인 view 인자)는 재생성 기준선과
// 설명이 같아졌으므로 다른 도구와 같이 기준선 전문 비교 대상이다. 아래 의미 검사는 재생성 이후를 대비한 보조 안전망이다.
function countSchemaDescriptions(value) {
  if (!value || typeof value !== 'object') return 0
  return (typeof value.description === 'string' ? 1 : 0)
    + Object.values(value).reduce((sum, child) => sum + countSchemaDescriptions(child), 0)
}

test('최신 60개 이름·input schema와 복구한 도구 설명 전문을 검증한다', async () => {
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
    assert.equal(tools.length, 60)
    // REQ-MNP-03: 검토 토큰·댓글 기대값·전체 복원 조건의 기존 도구 입력 확장.
    assert.equal(createHash('sha256').update(JSON.stringify(tools.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest('hex'), 'd3961d5e5d33e3c52fe0869dd3f5e02dc09416a67ee651f88863de1b0382985c')
    assert.equal(tools.reduce((sum, tool) => sum + countSchemaDescriptions(tool.inputSchema), 0), 160)
    const metaRecovery = tools.find(tool => tool.name === 'mindnprogress_recover_ai_delegation').inputSchema.properties.untrackedMetaRecovery
    assert.deepEqual(metaRecovery.required, ['path', 'expectedSha256', 'mainCommit'])
    assert.equal(metaRecovery.additionalProperties, false)
    assert.match(metaRecovery.description, /사용자가 승인한.*원본 보존.*같은 GUID.*다른 변경은 정리하지/s)
    // 2026-10-22 작업 트리 기준 재생성 기준선(capture-guidance-evidence.mjs --rebaseline-working-tree)의 registerTool 직접 등록 수
    assert.equal(baselineDescriptions.size, 58)
    for (const tool of tools) {
      if (safetyTools.has(tool.name) || tool.name ==='mindnprogress_search_content' || tool.name === 'mindnprogress_patch_card_text'
        || ['mindnprogress_get_shared_knowledge_review_context', 'mindnprogress_apply_shared_knowledge_review'].includes(tool.name)) continue
      const original = baselineDescriptions.get(tool.name)
      if (!original) continue // 배열로 등록되는 복구 도구는 아래 의미 검사에서 검증한다.
      assert.equal(tool.description, original.slice(1, -1), `${tool.name}의 기준선 상세 설명이 달라졌습니다.`)
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
    assert.equal(getDocument, baselineDescriptions.get('mindnprogress_get_document').slice(1, -1), 'get_document 기준선 설명 전문')
    assert.equal(descriptions.get('mindnprogress_send_group_document_instruction'), baselineDescriptions.get('mindnprogress_send_group_document_instruction').slice(1, -1), 'send_group_document_instruction 기준선 설명 전문')
    assert.deepEqual(getDocumentSchema.required, ['mapId'])
    assert.deepEqual(getDocumentSchema.properties.view.enum, ['full', 'compact', 'outline', 'version'])
    assert.equal(Object.hasOwn(getDocumentSchema.properties.view, 'default'), false, 'view 기본값은 서버에서 full로 처리한다')
    assert.match(descriptions.get('mindnprogress_restore_history'), /복원 직전 view를 생략한 get_document\(full\)로 현재 문서를 백업/)
    assert.match(descriptions.get('mindnprogress_recover_ai_delegation'), /복구.*mindnprogress_list_ai_delegations.*상태.*확인/s)
    assert.match(descriptions.get('mindnprogress_recover_ai_delegation'), /index.lock 또는 main HEAD 변경.*하위 AI 작업은 다시 실행하지 않습니다.*잠금은 자동 삭제하지.*최신 main 기준으로 통합/s)
    assert.match(descriptions.get('mindnprogress_search_content'), /ranked.*catalog.*page.hasMore.*coverage/s)
    const groupInstruction = descriptions.get('mindnprogress_send_group_document_instruction')
    assert.ok(groupInstruction.startsWith(baselineDescriptions.get('mindnprogress_send_group_document_instruction').slice(1, -1).split('완료 보고는 기본적으로')[0]), '정정 전 설명의 앞부분은 기준선과 같다.')
    assert.match(groupInstruction, /첫 응답 턴만 replied 상태와 response로 기록.*자동 재개하거나 이후 턴의 보고를 전달하지 않습니다.*session-message로 회신 대상 대화에 직접.*기본 대상은 현재 총괄 대화.*replyTarget을 explicit/s)
    assert.doesNotMatch(groupInstruction, /완료 보고는 기본적으로 현재 총괄 대화로 돌아오며/)
    assert.match(groupInstruction, /queued·delivered·replied 상태를 업무 완료로 해석하지 마세요/)
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
