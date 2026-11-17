import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'

// 정리안(plan) 입력 형식. 미리보기·제출·적용이 같은 형식을 쓴다.
export const reconstructionPlanSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), mode: z.enum(['compact', 'spec-update']), baseline: z.string().min(1), reason: z.string().min(1),
  newSource: z.string().optional(), changeSummary: z.string().optional(),
  groupBaselines: z.array(z.record(z.unknown())).optional().describe('get_reconstruction_context의 groupBaselines를 그대로 전달합니다. 그룹 기준·소속 변경 시 재검토합니다.'),
  sources: z.array(z.object({ mapId: z.string(), version: z.number().int(), sha256: z.string(), commentsSha256: z.string(), lifecycleVersion: z.number().int() }).passthrough()).min(1).max(30),
  targets: z.array(z.object({ key: z.string(), title: z.string(), color: z.string().optional(), nodes: z.array(z.record(z.unknown())), edges: z.array(z.record(z.unknown())) })).min(1).max(30),
  decisions: z.array(z.object({ mapId: z.string(), cardId: z.string(), disposition: z.enum(['carry', 'merge', 'knowledge', 'history', 'drop']), reason: z.string().min(1), evidence: z.string().optional(), targets: z.array(z.object({ key: z.string(), cardId: z.string() })).optional() })),
  approval: z.object({ statement: z.string().min(1), source: z.string().min(1) }).optional(),
})

// 정리안 전체를 도구 호출 하나에 다시 생성하면 AI 출력 한도에 걸린다(2026-11-17 9만 자 정리안을 줄여 제출한 사례).
// 그래서 AI가 여러 단계로 만든 로컬 파일을 MCP가 읽어 보낸다. MCP는 AI와 같은 PC에서 실행되므로 새 접근 권한은 생기지 않는다.
export const reconstructionPlanFileSchema = z.string().min(1).max(1000).optional()
  .describe('plan 대신 보낼 이 PC의 UTF-8 JSON 파일 절대 경로(2MB 이하). 도구 호출 크기 때문에 카드를 합치거나 내용을 줄이지 말고 큰 정리안은 파일로 보냅니다. plan과 함께 보내지 않습니다.')

// 서버 요청 본문 한도(server/lib/runtimeLifecycle.mjs readJsonBody)와 같다.
export const RECONSTRUCTION_PLAN_FILE_MAX_BYTES = 2_000_000

const invalid = (message) => Object.assign(new Error(message), { reasonCode: 'RECONSTRUCTION_PLAN_FILE_INVALID' })

export async function readReconstructionPlanFile(planFile, { maxBytes = RECONSTRUCTION_PLAN_FILE_MAX_BYTES } = {}) {
  const filePath = String(planFile ?? '').trim()
  if (!path.isAbsolute(filePath)) throw invalid('planFile은 이 PC에 있는 파일의 절대 경로여야 합니다.')
  if (path.extname(filePath).toLowerCase() !== '.json') throw invalid('planFile은 .json 파일이어야 합니다.')
  let info
  try { info = await stat(filePath) } catch { throw invalid(`planFile을 찾을 수 없습니다: ${filePath}`) }
  if (!info.isFile()) throw invalid(`planFile이 파일이 아닙니다: ${filePath}`)
  if (info.size > maxBytes) throw invalid(`planFile이 서버 요청 한도 ${maxBytes}바이트를 넘습니다(${info.size}바이트).`)
  const bytes = await readFile(filePath)
  let text
  // 깨진 UTF-8을 대체 문자로 바꿔 보내지 않도록 엄격하게 읽는다. 앞의 BOM은 TextDecoder가 뺀다.
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw invalid('planFile이 UTF-8 텍스트가 아닙니다.') }
  let json
  try { json = JSON.parse(text) } catch (error) { throw invalid(`planFile의 JSON을 해석하지 못했습니다: ${error.message}`) }
  const parsed = reconstructionPlanSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || '(최상위)'}: ${issue.message}`)
    throw invalid(`planFile 내용이 plan 형식과 맞지 않습니다. ${issues.join('; ')}`)
  }
  return {
    plan: parsed.data,
    // AI가 자기 파일과 대조할 수 있도록 원본 바이트 기준 해시와 글자 수(코드 포인트)를 돌려준다.
    planFile: { path: filePath, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, chars: [...text].length },
  }
}

// 도구 입력의 planFile을 plan으로 바꾼다. 저장 재전송 기록이 파일 경로가 아니라 실제 내용을 비교하도록 기록 전에 부른다.
export async function resolveReconstructionPlanInput(input) {
  if (input?.planFile === undefined) return { input }
  const { planFile, ...rest } = input
  if (input.plan !== undefined) throw invalid('plan과 planFile 중 하나만 보내세요.')
  // 기존 결과 조회는 저장을 시작하지 않으므로 파일을 읽지 않는다.
  if (input.resultOnly === true) return { input: rest }
  const loaded = await readReconstructionPlanFile(planFile)
  return { input: { ...rest, plan: loaded.plan }, planFile: loaded.planFile }
}

export function requireReconstructionPlan(plan) {
  if (plan === undefined) throw Object.assign(new Error('plan 또는 planFile 중 하나가 필요합니다.'), { reasonCode: 'RECONSTRUCTION_PLAN_REQUIRED' })
  return plan
}
