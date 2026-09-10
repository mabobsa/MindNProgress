import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createReconstructionRequests } from '../server/lib/documentReconstructionRequests.mjs'
import { buildReconstructionRequestPrompt } from '../src/utils/documentReconstructionRequest.mjs'
import { AI_EDITOR_REQUEST_MAX_LENGTH, aiConversationTitle, isAiConversationPurpose } from '../src/utils/aiConversationLaunch.mjs'

test('정리 요청은 범위를 고정하고 제안만 저장하며 재시작·동시 제출을 안전하게 처리한다', async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'mnp-reconstruction-requests-'))
  t.after(async () => { assert.equal(path.dirname(dataDirectory), path.resolve(tmpdir())); assert.match(path.basename(dataDirectory), /^mnp-reconstruction-requests-/); await rm(dataDirectory, { recursive: true, force: true }) })
  let inspected = 0
  const options = { dataDirectory, writeJson: (file, data) => writeFile(file, JSON.stringify(data)),
    readMap: async () => ({ id: 'map-a', title: '현재 업무', nodes: [{ id: 'root', data: { kind: 'root', label: '현재 기준' } }] }),
    lifecycle: { context: async (ids) => ({ groupBaselines: [], sources: ids.map((mapId) => ({ mapId, title: '원본' })) }),
      choices: async () => ({ documents: [{ id: 'map-a' }, { id: 'map-coordinator', excluded: true }] }),
      preview: async () => { inspected++ },
    },
  }
  let requests = await createReconstructionRequests(options)
  const user = { id: 'editor', name: '편집자' }
  const body = { analysisOnly: true, mapIds: ['map-a'], mode: 'compact', baseline: 'v0.4', notes: '현재 지식 보존' }
  await assert.rejects(requests.create({ ...body, analysisOnly: false }, user), /확인/)
  await assert.rejects(requests.create({ ...body, mapIds: ['map-coordinator'] }, user), /총괄/)
  await assert.rejects(requests.create({ ...body, mode: 'spec-update' }, user), /새 기획서/)
  const request = await requests.create(body, user)
  assert.match(request.analysisAuthorization.statement, /실제 문서 변경.*승인하지/)
  const plan = { id: 'plan-1', mode: 'compact', baseline: 'v0.4', sources: [{ mapId: 'map-a' }] }
  const proposal = { baseRevision: 0, plan }
  await assert.rejects(requests.submit(request.id, proposal, { id: 'other' }), /편집자 계정/)
  for (const changed of [{ mode: 'spec-update' }, { baseline: 'v0.5' }, { sources: [{ mapId: 'map-other' }] }, { approval: {} }]) await assert.rejects(requests.submit(request.id, { ...proposal, plan: { ...plan, ...changed } }, user))
  assert.equal(inspected, 0)
  const results = await Promise.allSettled([requests.submit(request.id, proposal, user), requests.submit(request.id, proposal, user)])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(inspected, 1)
  assert.equal(requests.get(request.id).revision, 1)
  assert.equal(requests.list()[0].plan, undefined)
  await requests.linkConversation(request.id, { id: 'test-conversation' })
  requests = await createReconstructionRequests(options)
  assert.deepEqual(requests.get(request.id).plan, plan)
  assert.equal(requests.get(request.id).conversation.id, 'test-conversation')
  const copied = requests.get(request.id); copied.plan.baseline = '임의 변경'
  assert.equal(requests.get(request.id).plan.baseline, 'v0.4')
  assert.throws(() => requests.get('__proto__'), /찾을 수/)
})

test('문서 정리 전문은 별도 제안함과 제한된 분석 승인만 전달한다', () => {
  const prompt = buildReconstructionRequestPrompt({ id: 'reorg-request-test' })
  assert.ok(prompt.length < AI_EDITOR_REQUEST_MAX_LENGTH)
  for (const text of ['mindnprogress_get_reconstruction_request', 'groupBaselines', 'mindnprogress_submit_reconstruction_proposal', '추가 AI 위임', 'plan.approval은 넣지 마세요', '별도로 검토하고 승인']) assert.ok(prompt.includes(text))
  assert.equal(isAiConversationPurpose('document-reconstruction'), true)
  assert.match(aiConversationTitle({ purpose: 'document-reconstruction', documentTitle: '문서', cardTitle: '카드' }), /^\[문서 정리\]/)
  assert.throws(() => buildReconstructionRequestPrompt({ id: '잘못된 ID' }))
})
