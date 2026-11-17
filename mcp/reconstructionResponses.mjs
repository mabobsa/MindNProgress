import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { rename, rm, stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'

// 문서 정리 도구 응답은 생성될 문서 전체·정리안 본문·그룹 스냅샷을 그대로 담아 AI 도구 출력 한도를 넘었다
// (2026-11-17 미리보기 183,071자, 요청 조회 51,120자, 전환 이력 643,401자). 기본은 판단에 필요한 해시·검사 결과·경고를 두고
// 큰 본문만 요약한다. 서버 API와 화면 응답은 바꾸지 않는다.
export const RECONSTRUCTION_RESPONSE_BUDGET_CHARS = 40_000
// 요약 판단 때 생략 안내(omitted)·파일 정보가 붙을 자리를 남긴다.
const WRAPPER_RESERVE_CHARS = 2_000

export const reconstructionDetailSchema = z.enum(['summary', 'full']).optional()
  .describe('기본 summary는 큰 본문을 요약하고 omitted에 생략 내용과 회수 방법을 적습니다. full은 서버 응답 전체를 반환하며 AI 도구 출력 한도를 넘을 수 있습니다.')
export const reconstructionOutputFileSchema = z.string().min(1).max(1000).optional()
  .describe('서버 응답 전체를 저장할 이 PC의 .json 파일 절대 경로. 응답에는 요약과 저장 파일의 SHA-256만 담습니다. 전체를 스크립트로 대조할 때 씁니다.')

const size = (value) => JSON.stringify(value ?? null).length
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const count = (value) => (Array.isArray(value) ? value.length : 0)
const invalid = (message) => Object.assign(new Error(message), { reasonCode: 'RECONSTRUCTION_OUTPUT_FILE_INVALID' })

function mapSummary(map) {
  const nodes = Array.isArray(map?.nodes) ? map.nodes : []
  const work = nodes.filter((node) => node?.data?.isWork === true)
  return {
    cards: nodes.length,
    edges: count(map?.edges),
    workCards: work.length,
    incompleteWorkCards: work.filter((node) => node.data.status !== 'done').length,
    waitingCards: nodes.filter((node) => count(node?.data?.waitingItems) > 0).length,
    waitingItems: nodes.reduce((sum, node) => sum + count(node?.data?.waitingItems), 0),
    referenceCards: nodes.filter((node) => node?.data?.reference).length,
  }
}

// 그룹 스냅샷(currentGroups)은 제출한 groupBaselines와 같은 크기의 사본이다. 경고·허용 전환·참조 영향은 그대로 둔다.
// 참조 영향 그래프(references)는 문서 간 Ref가 많으면 수만 자가 된다. 예산을 넘을 때만 개수로 줄이고 경고는 그대로 둔다.
function impactSummary(impact, fields, { compactReferences = false } = {}) {
  if (!impact || typeof impact !== 'object' || Array.isArray(impact)) return impact
  const { currentGroups, references, ...rest } = impact
  const result = { ...rest }
  if (currentGroups !== undefined) {
    result.currentGroupsCount = count(currentGroups)
    fields['impactValidation.currentGroups'] = '영향 검사 시점의 그룹 설정·소속 스냅샷. 개수는 currentGroupsCount에 있습니다.'
  }
  if (references !== undefined) {
    if (compactReferences && references && typeof references === 'object') {
      result.referencesCount = { documents: count(references.documents), links: count(references.links) }
      fields['impactValidation.references'] = '문서 간 Ref 영향 그래프. 개수는 referencesCount에 있고 문제는 warnings에 있습니다.'
    } else result.references = references
  }
  return result
}

export function summarizePreview(preview, { limitChars = RECONSTRUCTION_RESPONSE_BUDGET_CHARS } = {}) {
  const fields = {}
  if (!preview || typeof preview !== 'object' || !Array.isArray(preview.targets)) return { result: preview, fields }
  const targets = preview.targets.map((target) => {
    if (!target || typeof target !== 'object') return target
    const { map, renderMap, ...rest } = target
    if (map !== undefined) fields['targets[].map'] = '생성될 문서 전체(카드·관계). 구성 수는 targets[].mapSummary에 있습니다.'
    if (renderMap !== undefined) fields['targets[].renderMap'] = '화면 실측 배치용 렌더 투영. 렌더 검증은 MnP 화면이 합니다.'
    return { ...rest, ...(map !== undefined ? { mapSummary: mapSummary(map) } : {}) }
  })
  const result = { ...preview, targets }
  if (preview.impactValidation) {
    result.impactValidation = impactSummary(preview.impactValidation, fields)
    if (size(result) > limitChars - WRAPPER_RESERVE_CHARS) result.impactValidation = impactSummary(preview.impactValidation, fields, { compactReferences: true })
  }
  return { result, fields }
}

export function summarizeRequest(record) {
  const fields = {}
  if (!record || typeof record !== 'object' || !record.plan || typeof record.plan !== 'object') return { result: record, fields }
  const { plan, ...rest } = record
  const compact = JSON.stringify(plan)
  fields.plan = '제안함에 저장된 정리안 본문. 구성과 해시는 planSummary에 있습니다.'
  return {
    result: {
      ...rest,
      planSummary: {
        id: plan.id, mode: plan.mode, baseline: plan.baseline,
        targets: (Array.isArray(plan.targets) ? plan.targets : []).map((target) => ({ key: target?.key, title: target?.title, cards: count(target?.nodes), edges: count(target?.edges) })),
        decisions: count(plan.decisions),
        // 저장본을 공백 없이 JSON.stringify한 문자열 기준이다. 로컬 파일 원본 바이트 해시와는 다를 수 있다.
        chars: [...compact].length,
        sha256: sha256(compact),
      },
    },
    fields,
  }
}

const OPERATION_LIST_KEYS = ['id', 'state', 'mode', 'baseline', 'createdAt', 'appliedAt', 'rolledBackAt', 'targetMapIds', 'before', 'after']

export function summarizeOperation(operation, { keepDecisions = true, compactReferences = false } = {}) {
  const fields = {}
  if (!operation || typeof operation !== 'object') return { result: operation, fields }
  const { impactValidation, groupBaselines, targetLayouts, decisions, ...rest } = operation
  const result = { ...rest }
  if (impactValidation !== undefined) result.impactValidation = impactSummary(impactValidation, fields, { compactReferences })
  if (groupBaselines !== undefined) {
    result.groupBaselinesCount = count(groupBaselines)
    fields.groupBaselines = '전환 당시 그룹 기준 스냅샷. 개수는 groupBaselinesCount에 있습니다.'
  }
  if (targetLayouts !== undefined) {
    result.targetLayoutsCount = count(targetLayouts)
    fields.targetLayouts = '저장된 새 문서의 검증 배치. 개수는 targetLayoutsCount에 있습니다.'
  }
  if (decisions !== undefined) {
    if (keepDecisions) result.decisions = decisions
    else {
      result.decisionsCount = count(decisions)
      fields.decisions = '원본 카드 대응표. 개수는 decisionsCount에 있습니다.'
    }
  }
  return { result, fields }
}

function summarizeOperationListItem(operation) {
  if (!operation || typeof operation !== 'object') return operation
  const item = Object.fromEntries(OPERATION_LIST_KEYS.filter((key) => operation[key] !== undefined).map((key) => [key, operation[key]]))
  if (operation.createdBy && typeof operation.createdBy === 'object') item.createdBy = operation.createdBy.name
  if (Array.isArray(operation.sources)) item.sourceMapIds = operation.sources.map((source) => source?.mapId)
  return { ...item, decisionsCount: count(operation.decisions) }
}

export function summarizeReconstructions(response, { limitChars = RECONSTRUCTION_RESPONSE_BUDGET_CHARS } = {}) {
  if (Array.isArray(response?.operations)) {
    const items = response.operations.map(summarizeOperationListItem)
    const fields = { 'operations[]': '각 전환의 영향 검사·그룹 기준·검증 배치·카드 대응표·승인 근거·변경 요약. id로 한 건을 조회하면 대응표까지 받습니다.' }
    const result = { ...response, operations: items }
    // 서버 목록은 최신순이다. 예산을 넘으면 오래된 것부터 빼고 전체 수를 밝힌다.
    if (size(result) > limitChars - WRAPPER_RESERVE_CHARS) {
      let returned = items.length
      while (returned > 1 && size({ ...response, operations: items.slice(0, returned) }) > limitChars - WRAPPER_RESERVE_CHARS) returned -= 1
      result.operations = items.slice(0, returned)
      result.operationsTotal = items.length
      result.operationsReturned = returned
      fields['operations[] 이후 항목'] = `오래된 전환 ${items.length - returned}건. 전체 목록은 outputFile로 받으세요.`
    }
    return { result, fields }
  }
  for (const options of [{ keepDecisions: true }, { keepDecisions: true, compactReferences: true }]) {
    const single = summarizeOperation(response, options)
    if (size(single.result) <= limitChars - WRAPPER_RESERVE_CHARS) return single
  }
  return summarizeOperation(response, { keepDecisions: false, compactReferences: true })
}

// 적용·되돌리기는 전환 기록과 전체 문서 목록·배치를 함께 돌려준다. AI는 문서·이력을 다시 조회하므로 목록은 개수만 둔다.
export function summarizeLifecycleResult(response) {
  if (!response || typeof response !== 'object' || !response.operation || typeof response.operation !== 'object') return response
  const { operation, maps, documentLayout, documentGroups, ...rest } = response
  const summary = summarizeOperation(operation, { keepDecisions: false, compactReferences: true })
  const fields = { ...summary.fields }
  const result = { ...rest, operation: summary.result }
  if (maps !== undefined) {
    result.mapsCount = count(maps)
    fields.maps = '적용 후 전체 활성 문서 목록. 개수는 mapsCount에 있습니다.'
  }
  if (documentLayout !== undefined) fields.documentLayout = '적용 후 전체 문서 목록 배치.'
  // 그룹 메타데이터는 이 전환의 원본·새 문서 것만 남긴다.
  const keep = new Set([...(Array.isArray(operation.sources) ? operation.sources.map((source) => source?.mapId) : []), ...(Array.isArray(operation.targetMapIds) ? operation.targetMapIds : [])])
  if (Array.isArray(documentGroups)) result.documentGroups = documentGroups.filter((entry) => keep.has(entry?.mapId))
  return {
    omitted: {
      scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 큰 목록·스냅샷만 요약했습니다. 전환 상태와 문서 ID는 그대로입니다.',
      fields,
      rule: '생략된 내용을 추측하지 말고 필요하면 retrieval대로 조회하세요.',
      retrieval: {
        operation: { tool: 'mindnprogress_get_reconstructions', arguments: { id: operation.id, outputFile: '<이 PC의 .json 절대 경로>' } },
        documents: { tool: 'mindnprogress_list_documents', arguments: {} },
      },
    },
    ...result,
  }
}

// 미리보기 결과로 정리안 파일을 덮어쓰지 않도록 입력 단계에서 막는다(planFile은 이후 plan으로 바뀌어 경로가 사라진다).
export function assertOutputFileDiffersFromPlanFile(input) {
  if (input?.outputFile === undefined || input?.planFile === undefined) return
  const same = (a, b) => path.resolve(String(a).trim()).toLowerCase() === path.resolve(String(b).trim()).toLowerCase()
  if (same(input.outputFile, input.planFile)) throw invalid('outputFile을 정리안 파일(planFile)과 같은 경로로 지정할 수 없습니다.')
}

export async function writeResponseFile(outputFile, value, { forbiddenPaths = [] } = {}) {
  const filePath = String(outputFile ?? '').trim()
  if (!path.isAbsolute(filePath)) throw invalid('outputFile은 이 PC의 절대 경로여야 합니다.')
  if (path.extname(filePath).toLowerCase() !== '.json') throw invalid('outputFile은 .json 파일이어야 합니다.')
  const resolved = path.resolve(filePath)
  if (forbiddenPaths.some((forbidden) => forbidden && path.resolve(forbidden).toLowerCase() === resolved.toLowerCase())) {
    throw invalid('outputFile을 정리안 파일(planFile)과 같은 경로로 지정할 수 없습니다.')
  }
  let directory
  try { directory = await stat(path.dirname(resolved)) } catch { throw invalid(`outputFile의 폴더가 없습니다: ${path.dirname(resolved)}`) }
  if (!directory.isDirectory()) throw invalid(`outputFile의 폴더가 없습니다: ${path.dirname(resolved)}`)
  try { if ((await stat(resolved)).isDirectory()) throw invalid(`outputFile이 폴더입니다: ${resolved}`) } catch (error) { if (error.reasonCode) throw error }
  const text = `${JSON.stringify(value, null, 2)}\n`
  const bytes = Buffer.from(text, 'utf8')
  const temporary = `${resolved}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, resolved)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw invalid(`outputFile을 저장하지 못했습니다: ${error.message}`)
  }
  return { path: resolved, sha256: sha256(bytes), bytes: bytes.length, chars: [...text].length }
}

/**
 * 읽기 도구(미리보기·요청 조회·전환 이력)의 응답을 만든다. outputFile이 있으면 전체를 먼저 파일로 저장한다.
 * detail=full이면 전체를, 아니면 summarize 결과와 생략 안내를 반환한다. 생략한 것이 없으면 원래 응답 그대로다.
 */
export async function shapeReconstructionResponse(full, { detail = 'summary', outputFile, summarize, retrieval, forbiddenPaths = [] }) {
  const written = outputFile !== undefined ? await writeResponseFile(outputFile, full, { forbiddenPaths }) : null
  const withFile = (value) => (written && value && typeof value === 'object' && !Array.isArray(value) ? { outputFile: written, ...value } : value)
  if (detail === 'full') return withFile(full)
  const { result, fields } = summarize(full)
  if (!Object.keys(fields).length) return withFile(result)
  return {
    omitted: {
      scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 큰 본문만 요약했습니다. 판단에 필요한 해시·검사 결과·경고는 그대로입니다.',
      fields,
      rule: '생략된 내용을 추측하지 말고 필요하면 retrieval대로 다시 조회하세요. 전체를 스크립트로 대조할 때는 outputFile이 출력 한도에 걸리지 않습니다.',
      retrieval,
    },
    ...withFile(result),
  }
}
