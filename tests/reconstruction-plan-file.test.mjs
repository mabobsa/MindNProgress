import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readReconstructionPlanFile, reconstructionPlanSchema, requireReconstructionPlan, resolveReconstructionPlanInput } from '../mcp/reconstructionPlanFile.mjs'

// 2026-11-17: 정리안을 도구 호출 하나에 다시 생성하다 AI 출력 한도에 걸려 설계를 줄여 제출한 사례가 있어,
// 미리보기·제출·적용이 로컬 JSON 파일(planFile)을 받는다. 파일 내용은 인자로 받은 plan과 같은 형식 검사를 거친다.
const plan = {
  id: 'plan-file-test', mode: 'compact', baseline: 'v0.4', reason: '한국어 본문 보존 확인 · 漢字 · 이모지 🙂',
  sources: [{ mapId: 'map-1', version: 3, sha256: 'a', commentsSha256: 'b', lifecycleVersion: 1, extra: '유지' }],
  targets: [{ key: 'next', title: '후속 기준', nodes: [{ id: 'root', data: { label: '루트', description: '긴 설명' } }], edges: [] }],
  decisions: [{ mapId: 'map-1', cardId: 'root', disposition: 'carry', reason: '기준 유지', targets: [{ key: 'next', cardId: 'root' }] }],
}

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-plan-file-'))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('planFile은 인자 plan과 같은 형식 검사 결과를 내고 원본 바이트 해시와 글자 수를 돌려준다', () => withDirectory(async (directory) => {
  const file = path.join(directory, 'plan.json')
  const text = `${JSON.stringify({ ...plan, unknownTopLevel: '버림' }, null, 2)}\n`
  await writeFile(file, `﻿${text}`, 'utf8')
  const loaded = await readReconstructionPlanFile(file)
  assert.deepEqual(loaded.plan, reconstructionPlanSchema.parse({ ...plan, unknownTopLevel: '버림' }), '인자 plan과 같은 파싱 결과')
  assert.equal(Object.hasOwn(loaded.plan, 'unknownTopLevel'), false)
  assert.equal(loaded.plan.reason, plan.reason, '한국어·이모지를 그대로 읽는다')
  assert.equal(loaded.plan.sources[0].extra, '유지', 'passthrough 필드도 인자 plan과 같이 유지한다')
  const bytes = Buffer.from(`﻿${text}`, 'utf8')
  assert.deepEqual(loaded.planFile, { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, chars: [...text].length })
}))

test('잘못된 planFile은 서버로 보내지 않고 이유와 함께 거절한다', () => withDirectory(async (directory) => {
  const reject = (value, pattern, options) => assert.rejects(readReconstructionPlanFile(value, options), (error) => {
    assert.equal(error.reasonCode, 'RECONSTRUCTION_PLAN_FILE_INVALID')
    assert.match(error.message, pattern)
    return true
  })
  await reject('plan.json', /절대 경로/)
  await reject(path.join(directory, 'plan.txt'), /\.json 파일/)
  await reject(path.join(directory, 'none.json'), /찾을 수 없습니다/)
  await reject(directory + path.sep + '.', /\.json 파일/)
  const big = path.join(directory, 'big.json')
  await writeFile(big, JSON.stringify(plan))
  await reject(big, /서버 요청 한도 10바이트/, { maxBytes: 10 })
  const broken = path.join(directory, 'broken.json')
  await writeFile(broken, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]))
  await reject(broken, /UTF-8 텍스트가 아닙니다/)
  const notJson = path.join(directory, 'not.json')
  await writeFile(notJson, '{ "id": ')
  await reject(notJson, /JSON을 해석하지 못했습니다/)
  const wrong = path.join(directory, 'wrong.json')
  await writeFile(wrong, JSON.stringify({ ...plan, mode: 'merge', targets: [] }))
  await reject(wrong, /plan 형식과 맞지 않습니다.*mode.*targets/s)
}))

test('도구 입력 변환은 planFile을 plan으로 바꾸고, 함께 보내거나 둘 다 없으면 거절한다', () => withDirectory(async (directory) => {
  const file = path.join(directory, 'plan.json')
  await writeFile(file, JSON.stringify(plan), 'utf8')
  const prepared = await resolveReconstructionPlanInput({ requestId: 'reorg-request-1', baseRevision: 0, planFile: file })
  assert.deepEqual(Object.keys(prepared.input).sort(), ['baseRevision', 'plan', 'requestId'], '저장 재전송 기록은 파일 경로가 아니라 내용을 비교한다')
  assert.equal(prepared.input.plan.id, plan.id)
  assert.equal(prepared.planFile.path, file)
  const inline = await resolveReconstructionPlanInput({ plan })
  assert.deepEqual(inline, { input: { plan } }, '인자 plan은 그대로 둔다')
  await assert.rejects(resolveReconstructionPlanInput({ plan, planFile: file }), /하나만 보내세요/)
  assert.deepEqual(await resolveReconstructionPlanInput({ requestId: 'mnpw:1', resultOnly: true, planFile: path.join(directory, 'gone.json') }),
    { input: { requestId: 'mnpw:1', resultOnly: true } }, '기존 결과 조회는 파일을 읽지 않는다')
  assert.throws(() => requireReconstructionPlan(undefined), (error) => error.reasonCode === 'RECONSTRUCTION_PLAN_REQUIRED')
}))
