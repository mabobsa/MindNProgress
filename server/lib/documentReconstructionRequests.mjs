import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { reconstructionError } from './documentReconstruction.mjs'

// 제안함은 업무 문서·보관 상태·진행률과 별개다. 제출은 적용 승인이 아니다.
export async function createReconstructionRequests({ dataDirectory, writeJson, lifecycle, readMap }) {
  const file = path.join(dataDirectory, '_document-reconstruction-requests.json')
  let records
  try { records = JSON.parse(await readFile(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; records = {} }
  let queue = Promise.resolve()
  const exclusive = (action) => { const result = queue.then(action); queue = result.catch(() => {}); return result }
  const required = (id) => {
    if (!Object.hasOwn(records, id)) throw reconstructionError('정리 요청을 찾을 수 없습니다.', 404)
    return records[id]
  }
  const save = async (record) => { const next = { ...records, [record.id]: record }; await writeJson(file, next); records = next; return structuredClone(record) }
  const field = (value, label, max, optional = false) => {
    if (optional && value === undefined) return ''
    if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw reconstructionError(`${label} 입력을 확인하세요. (최대 ${max}자)`)
    return value.trim()
  }
  const summary = ({ plan, ...record }) => ({ ...record, hasProposal: Boolean(plan), planId: plan?.id })
  return {
    get: (id) => structuredClone(required(id)),
    list: () => Object.values(records).map(summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    create: (body, user) => exclusive(async () => {
      if (body?.analysisOnly !== true) throw reconstructionError('분석·정리안 제출만 요청한다는 확인이 필요합니다.')
      if (!['compact', 'spec-update'].includes(body.mode)) throw reconstructionError('정리 목적을 선택하세요.')
      const baseline = field(body.baseline, '현재 기준', 1000)
      const notes = field(body.notes, '요청사항', 4000, true)
      const newSource = body.mode === 'spec-update' ? field(body.newSource, '새 기획서 출처', 2000) : ''
      const context = await lifecycle.context(body.mapIds)
      const choices = await lifecycle.choices({})
      if (body.mapIds.some((id) => !choices.documents.some((doc) => doc.id === id && !doc.excluded))) throw reconstructionError('총괄·보관·삭제 문서는 정리 대상에 포함할 수 없습니다.', 409)
      if (context.groupBaselines.length > 1 || (context.groupBaselines.length === 1 && body.mapIds.some((id) => !context.groupBaselines[0].mapIds.includes(id)))) throw reconstructionError('같은 그룹의 문서끼리 정리해 주세요.', 409)
      const map = await readMap(body.mapIds[0])
      const root = map?.nodes.find((node) => node.data.kind === 'root' && !node.data.reference)
      if (!root) throw reconstructionError('AI 요청의 기준이 될 원본 루트 카드를 찾을 수 없습니다.')
      const now = new Date().toISOString()
      return save({ id: `reorg-request-${randomUUID()}`, mode: body.mode, baseline, newSource, notes,
        mapIds: [...body.mapIds], documents: context.sources.map(({ mapId, title }) => ({ id: mapId, title })),
        createdAt: now, createdBy: user, revision: 0,
        analysisAuthorization: { statement: '선택한 문서를 읽고 정리안을 제안함에 제출하는 것만 요청합니다. 실제 문서 변경·보관·개발·추가 AI 위임은 승인하지 않습니다.', source: `MindNProgress 문서 정리 요청 화면 · ${now}` },
        launchTarget: { mapId: map.id, cardId: root.id, cardTitle: root.data.label, documentTitle: map.title },
      })
    }),
    submit: (id, body, user) => exclusive(async () => {
      const request = required(id)
      if (request.createdBy.id !== user.id) throw reconstructionError('이 요청을 시작한 편집자 계정으로 정리안을 제출하세요.', 403)
      if (body?.baseRevision !== request.revision) throw reconstructionError('제안함이 변경되었습니다. 요청을 다시 조회하세요.', 409)
      const plan = body?.plan
      if (!plan || plan.approval !== undefined) throw reconstructionError('제안함에는 적용 승인 없이 정리안만 제출하세요.')
      if (plan.mode !== request.mode || plan.baseline !== request.baseline || (request.mode === 'spec-update' && plan.newSource !== request.newSource)
        || !Array.isArray(plan.sources) || plan.sources.length !== request.mapIds.length || request.mapIds.some((id) => !plan.sources.some((source) => source?.mapId === id))) throw reconstructionError('정리안의 목적·기준·기획 출처·대상이 사용자 요청 범위와 다릅니다.')
      await lifecycle.preview(plan)
      const record = await save({ ...request, plan, revision: request.revision + 1, submittedAt: new Date().toISOString(), submittedBy: user })
      return summary(record)
    }),
    linkConversation: (id, conversation) => exclusive(async () => save({ ...required(id), conversation })),
  }
}
