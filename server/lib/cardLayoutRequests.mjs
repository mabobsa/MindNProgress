import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { cardLayoutGraph, createCardLayoutCandidates, validateCardLayoutTarget, validateCardLayoutPlan, verifyCardLayout } from '../../src/utils/cardLayout.mjs'
import { validateLayoutMeasurements } from '../../src/utils/mindMapLayout.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status, code: 'CARD_LAYOUT_INVALID', reconstructionError: true }) }
export async function createCardLayoutRequests({ dataDirectory, writeJson, readSnapshot, savePositions, assertWritable, now = Date.now }) {
  const file = path.join(dataDirectory, '_card-layout-requests.json')
  let records
  try { records = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error; records = {} }
  let queue = Promise.resolve()
  const exclusive = (action) => { const result = queue.then(action); queue = result.catch(() => {}); return result }
  const cache = new Map()
  const recordFor = (id, user) => {
    const record = Object.hasOwn(records, id) ? records[id] : null
    if (!record) fail('배치 요청을 찾을 수 없습니다.', 404)
    if (record.createdBy.id !== user.id) fail('요청을 시작한 편집자만 이 배치 요청을 사용할 수 있습니다.', 403)
    return record
  }
  const persist = async (record) => { const next = { ...records, [record.id]: record }; await writeJson(file, next); records = next; return structuredClone(record) }
  const signature = (snapshot) => hash({ map: snapshot.map, renderMap: snapshot.renderMap })
  const current = async (record) => {
    if (record.state !== 'open') fail('종료된 배치 요청입니다. 새 요청을 시작하세요.')
    assertWritable(record.mapId)
    const snapshot = await readSnapshot(record.mapId)
    if (signature(snapshot) !== record.sourceHash) fail('원본 또는 카드 표시 내용이 변경되었습니다. 최신 문서로 새 배치 요청을 시작하세요.')
    return snapshot
  }
  const previewFor = async (id, token, user) => {
    const record = recordFor(id, user); await current(record)
    const entry = cache.get(token)
    if (!entry || entry.requestId !== id || entry.revision !== record.revision || entry.userId !== user.id || entry.expiresAt < now()) fail('미리보기 검증이 만료되었습니다. 다시 미리보기를 열어 주세요.')
    return { record, entry }
  }
  const publish = (record, placed, phase, user) => {
    for (const [token, entry] of cache) if (entry.expiresAt < now() || entry.requestId === record.id) cache.delete(token)
    while (cache.size >= 20) cache.delete(cache.keys().next().value)
    const previewHash = randomUUID()
    const preview = { requestId: record.id, revision: record.revision, previewHash, phase, ...placed }
    cache.set(previewHash, { ...preview, userId: user.id, expiresAt: now() + 30 * 60_000 })
    return preview
  }
  const placement = (record, measurements, options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !['target', 'variant'].includes(key))) fail('배치 미리보기에는 목표 화면과 후보만 지정하세요.', 400)
    const target = validateCardLayoutTarget(options.target === undefined ? record.target : options.target)
    const candidates = createCardLayoutCandidates(record.snapshot.renderMap, measurements, record.plan, target)
    const variant = options.variant ?? 'balanced'
    const selected = candidates.find((item) => item.id === variant)
    if (!selected) fail('선택한 배치 후보를 사용할 수 없습니다. 다른 후보를 선택하세요.', 400)
    return { map: selected.map, layout: selected.layout, metrics: selected.metrics, target, variant,
      candidates: candidates.map(({ id, label, metrics }) => ({ id, label, metrics })) }
  }
  return {
    list: (mapId, user) => Object.values(records).filter((r) => r.mapId === mapId && r.createdBy.id === user.id).map(({ snapshot: _s, measurements: _m, plan: _p, ...r }) => ({ ...r, hasProposal: Boolean(_p) })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: async (id, user) => {
      const record = recordFor(id, user)
      let stale = false
      if (record.state === 'open') { try { await current(record) } catch { stale = true } }
      return { ...structuredClone(record), stale }
    },
    create: (body, user) => exclusive(async () => {
      if (body?.proposalOnly !== true) fail('배치 제안만 요청한다는 확인이 필요합니다.', 400)
      assertWritable(body.mapId)
      const snapshot = await readSnapshot(body.mapId); cardLayoutGraph(snapshot.map)
      const target = validateCardLayoutTarget(body.target)
      const anchor = snapshot.map.nodes.find((node) => node.data.kind === 'root' && !node.data.reference) ?? snapshot.map.nodes[0]
      return persist({ id: `layout-request-${randomUUID()}`, mapId: snapshot.map.id, documentTitle: snapshot.map.title, baseVersion: snapshot.map.version,
        sourceHash: signature(snapshot), snapshot, target, revision: 0, state: 'open', createdAt: new Date(now()).toISOString(), createdBy: user,
        launchTarget: { mapId: snapshot.map.id, cardId: anchor.id, cardTitle: anchor.data.label },
        authorization: { statement: '현재 문서의 배치안을 분석해 이 요청에 제출합니다. 원본 변경과 추가 AI 위임은 승인하지 않습니다.', source: 'MindNProgress AI 배치 제안 요청 화면' } })
    }),
    capture: (id, body, user) => exclusive(async () => {
      const record = recordFor(id, user); await current(record)
      if (record.plan || record.conversation) fail('AI 요청 후 측정값을 바꿀 수 없습니다. 새 요청을 시작하세요.')
      const measurements = validateLayoutMeasurements(record.snapshot.renderMap.nodes, body.measurements)
      return persist({ ...record, measurements })
    }),
    submit: (id, body, user) => exclusive(async () => {
      const record = recordFor(id, user); await current(record)
      if (!record.measurements) fail('화면에서 모든 카드의 실제 크기를 먼저 측정하세요.')
      if (body.baseRevision !== record.revision) fail('다른 제안이 먼저 저장되었습니다. 요청을 다시 조회하세요.')
      const plan = validateCardLayoutPlan(record.snapshot.renderMap, body.plan)
      createCardLayoutCandidates(record.snapshot.renderMap, record.measurements, plan, record.target)
      await persist({ ...record, plan, revision: record.revision + 1, submittedAt: new Date(now()).toISOString() })
      return { requestId: id, revision: record.revision + 1, submitted: true }
    }),
    preview: (id, user, options = {}) => exclusive(async () => {
      const record = recordFor(id, user); await current(record)
      if (!record.plan || !record.measurements) fail('AI 배치안이 아직 제출되지 않았습니다.')
      return publish(record, placement(record, record.measurements, options), 'draft', user)
    }),
    inspect: (id, body, verify, user) => exclusive(async () => {
      const { record, entry } = await previewFor(id, body.previewHash, user)
      if (verify) {
        if (entry.phase !== 'measured') fail('실제 크기로 다시 배치한 화면을 먼저 확인하세요.')
        verifyCardLayout(entry.map, entry.layout, body.measurements)
        const { map, layout, metrics, target, variant, candidates } = entry
        return publish(record, { map, layout, metrics, target, variant, candidates }, 'verified', user)
      }
      return publish(record, placement(record, body.measurements, { target: entry.target, variant: entry.variant }), 'measured', user)
    }),
    apply: (id, body, user) => exclusive(async () => {
      const { record, entry } = await previewFor(id, body.previewHash, user)
      if (body.approved !== true || entry.phase !== 'verified') fail('실제 미리보기를 검증하고 적용을 승인해 주세요.')
      // 마지막 화면 크기도 확인하여 클라이언트에서 확인한 이후의 표시 변경을 차단한다.
      verifyCardLayout(entry.map, entry.layout, body.measurements)
      const snapshot = await current(record)
      const positions = new Map(entry.map.nodes.map((node) => [node.id, node.position]))
      const map = await savePositions(snapshot.map, positions, user)
      cache.delete(body.previewHash)
      await persist({ ...record, state: 'applied', appliedAt: new Date(now()).toISOString(), appliedVersion: map.version, appliedLayout: { version: entry.layout.version, target: entry.target, variant: entry.variant } })
      return { mapId: map.id, version: map.version, applied: true }
    }),
    cancel: (id, user) => exclusive(async () => {
      const record = recordFor(id, user)
      if (record.state === 'applied') fail('이미 적용한 요청입니다.')
      for (const [token, entry] of cache) if (entry.requestId === id) cache.delete(token)
      return persist({ ...record, state: 'cancelled' })
    }),
    linkConversation: (id, conversation, user) => exclusive(async () => {
      const record = recordFor(id, user); await current(record)
      if (!record.measurements) fail('실제 카드 크기를 먼저 측정하세요.')
      if (record.conversation && record.conversation.id !== conversation.id) fail('이미 AI 대화가 연결된 요청입니다.')
      return persist({ ...record, conversation })
    }),
  }
}
