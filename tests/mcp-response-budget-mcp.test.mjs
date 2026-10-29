import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { knowledge, storageApi } from './helpers/storage-api-harness.mjs'
import { CONTEXT_RESPONSE_BUDGET_CHARS } from '../mcp/contextBudget.mjs'

// 문서 0: card-13이 card-1~12의 결과를 주요 선행 지식(reuse-first)으로 쓴다.
// 문서 1: card-5는 문서 0의 card-1을 가리키는 Ref이고, 저장본에는 예전 제목·설명 사본이 남아 있다.
async function seed({ data, ids }) {
  const heavyPath = path.join(data, `${ids[0]}.json`)
  const heavy = JSON.parse(await readFile(heavyPath, 'utf8'))
  heavy.edges.push(...Array.from({ length: 12 }, (_, i) => ({
    id: `knowledge-${i}`, source: `card-${i + 1}`, target: 'card-13', data: { relation: 'knowledge', knowledgePolicy: 'reuse-first' },
  })))
  // 선택 카드 자체는 짧게 두어, 선행 지식 원문이 먼저 빠지고 선택 카드 원문은 남는 순서를 확인한다.
  heavy.nodes.find((node) => node.id === 'card-13').data.sharedKnowledge = '선택 카드의 짧은 공유 지식'
  await writeFile(heavyPath, JSON.stringify(heavy))
  const referencePath = path.join(data, `${ids[1]}.json`)
  const withReference = JSON.parse(await readFile(referencePath, 'utf8'))
  const referenceCard = withReference.nodes.find((node) => node.id === 'card-5')
  referenceCard.data = { ...referenceCard.data, label: '예전 제목 (ref)', description: '저장본에 남은 예전 설명', reference: { mapId: ids[0], nodeId: 'card-1' } }
  await writeFile(referencePath, JSON.stringify(withReference))
}

test('실제 MCP의 get_context 예산 축소·get_card 회수 인자·update_card affected 정리', { timeout: 90000 }, async (t) => {
  const api = await storageApi(t, { documents: 2, seed })
  const client = new Client({ name: 'response-budget-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: ['mcp/server.mjs'],
    cwd: process.env.MNP_STORAGE_TEST_SOURCE_ROOT || path.resolve(import.meta.dirname, '..'), env: api.env, stderr: 'pipe' })
  t.after(async () => { await client.close() })
  await client.connect(transport)
  const invoke = async (name, args) => {
    const result = await client.callTool({ name: `mindnprogress_${name}`, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.find((part) => part.type === 'text').text
    return { value: JSON.parse(text), chars: text.length }
  }
  const [heavyMapId, referenceMapId] = api.ids
  const attribution = { editorId: 'user-editor', aiType: 'Fixture AI', aiModel: 'fixture' }

  // 선행 지식이 많아 한도를 넘는 문맥은 규칙을 그대로 두고 데이터만 줄이며, 최종 응답 크기를 정확히 알린다.
  const { value: context, chars } = await invoke('get_context', { mapId: heavyMapId, cardId: 'card-13', ...attribution })
  assert.equal(context.contextSchemaVersion, '3.4')
  assert.ok(context.contextBudget, '예산을 넘는 focused 응답에는 contextBudget이 있어야 합니다.')
  assert.equal(context.contextBudget.returnedChars, chars)
  assert.equal(context.contextBudget.exceeded, false)
  assert.ok(chars <= CONTEXT_RESPONSE_BUDGET_CHARS, `응답 ${chars}자`)
  assert.ok(context.contextBudget.focusedChars > CONTEXT_RESPONSE_BUDGET_CHARS)
  assert.deepEqual(Object.keys(context).slice(1, 4), ['detailLevel', 'contextBudget', 'omitted'])
  assert.ok(context.guide.operationRules.length > 0)
  assert.ok(context.selection.taskLinks.startupInspection.instruction)
  assert.ok(context.selection.aiWorkCoordination.childDelegation.instruction)
  assert.ok(context.nextStep)
  const primary = context.selection.knowledgeSources.primary
  assert.equal(primary.length, 12, '모든 선행 지식 원천의 색인은 남는다')
  assert.equal(context.selection.card.data.description, '격리 환경의 시험 본문입니다. '.repeat(100), '선택 카드 원문은 마지막까지 남긴다')
  const omittedSourceIds = context.omitted.cardIds.knowledgeSourceSharedKnowledge
  assert.ok(omittedSourceIds.length > 0)

  // omitted.retrieval의 인자로 생략된 원천을 회수하면 색인의 길이와 같은 원문을 작게 받는다.
  const retrieval = context.omitted.retrieval.knowledgeSource
  assert.equal(retrieval.tool, 'mindnprogress_get_card')
  const { value: sourceCard, chars: sourceChars } = await invoke('get_card', { ...retrieval.arguments, cardId: omittedSourceIds[0] })
  assert.equal(sourceCard.card.data.sharedKnowledge, knowledge)
  assert.deepEqual(Object.keys(sourceCard.card.data).sort(), ['label', 'sharedKnowledge'])
  assert.equal(sourceCard.card.textIntegrity.sharedKnowledge.length,
    primary.find((entry) => entry.card.id === omittedSourceIds[0]).card.textIntegrity.sharedKnowledge.length)
  assert.ok(sourceCard.card.textIntegrity.description.sha256)
  assert.deepEqual(sourceCard.comments, [])
  assert.equal(sourceCard.commentsPage.limit, 0)
  assert.ok(sourceChars < 12000, `회수 응답 ${sourceChars}자`)
  // 인자를 주지 않은 get_card는 기존과 같다.
  const { value: fullCard } = await invoke('get_card', { mapId: heavyMapId, cardId: omittedSourceIds[0] })
  assert.equal(fullCard.card.data.description, '격리 환경의 시험 본문입니다. '.repeat(100))
  assert.equal(fullCard.commentsPage.limit, 20)

  // 예산 안의 문맥은 표기 없이 그대로다.
  const { value: small, chars: smallChars } = await invoke('get_context', { mapId: referenceMapId, cardId: 'card-6', ...attribution })
  assert.ok(smallChars <= CONTEXT_RESPONSE_BUDGET_CHARS, `작은 문맥 ${smallChars}자`)
  assert.equal(small.contextBudget, undefined)
  assert.equal(small.omitted, undefined)
  assert.equal(small.selection.card.data.sharedKnowledge, knowledge)

  // update_card affected: 저장본과 조회본의 Ref 투영 차이를 서버 조정으로 보고하지 않고 요청 카드를 중복하지 않는다.
  const { value: updated } = await invoke('update_card', { mapId: referenceMapId, cardId: 'card-6', responseMode: 'affected', data: { status: 'in-progress' } })
  assert.ok(updated.affectedCards.every((entry) => entry.card.id !== 'card-5'), JSON.stringify(updated.affectedCards))
  assert.ok(updated.affectedCards.every((entry) => entry.card.id !== 'card-6'))
  assert.equal(updated.card.data.status, 'in-progress')
  assert.deepEqual(updated.card.omittedFields, ['description', 'sharedKnowledge'])
  assert.equal(updated.card.textIntegrity.sharedKnowledge.length, knowledge.length)
  assert.equal(updated.omitted.retrieval.tool, 'mindnprogress_get_card')

  // Ref 카드를 직접 바꿔도 응답은 저장본의 예전 사본이 아니라 원본 투영값을 쓴다.
  const { value: referenceUpdated } = await invoke('update_card', { mapId: referenceMapId, cardId: 'card-5', responseMode: 'affected', data: { kind: 'task' } })
  assert.equal(referenceUpdated.card.data.label, '검증 카드 1 (ref)')
  assert.equal(referenceUpdated.card.data.kind, 'task')
  assert.equal(referenceUpdated.card.textIntegrity.description.length, '격리 환경의 시험 본문입니다. '.repeat(100).length)
  assert.ok(referenceUpdated.affectedCards.every((entry) => entry.card.id !== 'card-5'))
})
