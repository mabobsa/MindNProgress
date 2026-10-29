// list_documents 응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 줄인다. 문서 항목은 하나도 빼지 않는다.
// 같은 값을 두 번 담은 documentGroups → 작성자 세부 → groupProject의 중복 항목 → 빈 수명주기 필드 → 문서별 최소 필드 순으로 줄이고,
// 예산 안에 들어오면 멈춘다. 예산 안의 응답은 그대로 반환한다. 예산 값은 get_context·outline·list_ai_delegations와 같다.

export const DOCUMENT_LIST_RESPONSE_BUDGET_CHARS = 40_000
const GROUP_FIELDS = ['group', 'groupMembership', 'groupProject']
const MINIMAL_DOCUMENT_FIELDS = new Set(['id', 'title', 'version', 'updatedAt', 'rootStatus', 'rootProgress', 'nodeCount', 'waitingCount', ...GROUP_FIELDS])
const size = (value) => JSON.stringify(value).length
const isEmpty = (value) => value === null || value === '' || (Array.isArray(value) && value.length === 0)

const DOCUMENT_LIST_STEPS = [
  {
    id: 'documentGroups',
    apply(working, state) {
      if (!Array.isArray(working.documentGroups)) return false
      // 문서 항목의 그룹 필드와 값이 모두 같을 때만 뺀다. 다르면 정보를 잃으므로 남긴다.
      const byMap = new Map(working.maps.map((map) => [map.id, map]))
      const same = working.documentGroups.every((entry) => {
        const map = byMap.get(entry.mapId)
        return map && GROUP_FIELDS.every((key) => JSON.stringify(entry[key] ?? null) === JSON.stringify(map[key] ?? null))
      })
      if (!same) return false
      state.counts.documentGroups = working.documentGroups.length
      delete working.documentGroups
      state.fields.documentGroups = '문서별 그룹 정보와 같은 값이라 생략했습니다. 각 문서의 maps[].group·groupMembership·groupProject를 읽으세요.'
      return true
    },
  },
  {
    id: 'authors',
    apply(working, state) {
      let changed = 0
      for (const map of working.maps) for (const key of ['createdBy', 'updatedBy']) {
        const author = map[key]
        if (!author || typeof author !== 'object' || Object.keys(author).every((field) => field === 'id' || field === 'name')) continue
        map[key] = { id: author.id, name: author.name }
        changed++
      }
      if (changed) state.fields['maps[].createdBy·updatedBy'] = '작성자는 id·name만 남겼습니다. 이메일·권한 등은 mindnprogress_list_users로 조회하세요.'
      return changed > 0
    },
  },
  {
    id: 'groupProject',
    apply(working, state) {
      let changed = 0
      const contextTools = new Set()
      for (const map of working.maps) {
        const project = map.groupProject
        if (!project || typeof project !== 'object') continue
        // groupId·name은 group.id·group.name과 같고 contextTool은 모든 문서에서 같으므로 한 번만 남긴다.
        if (project.groupId !== map.group?.id || project.name !== map.group?.name) continue
        if (project.contextTool) contextTools.add(project.contextTool)
        map.groupProject = { coordinatorMapId: project.coordinatorMapId, role: project.role }
        changed++
      }
      if (!changed) return false
      state.fields['maps[].groupProject'] = `coordinatorMapId·role만 남겼습니다. groupId·name은 maps[].group.id·name과 같고, 그룹 문맥은 ${[...contextTools].join('·') || 'mindnprogress_get_group_context'}(groupId)로 조회하세요.`
      return true
    },
  },
  {
    id: 'emptyFields',
    apply(working, state) {
      let changed = 0
      for (const map of working.maps) for (const key of Object.keys(map)) if (isEmpty(map[key])) { delete map[key]; changed++ }
      if (changed) state.fields['maps[](빈 필드)'] = '값이 없거나 비어 있는 필드(보관·휴지통·재구성·선후 문서 등)는 생략했습니다. 없는 필드는 값이 없다는 뜻입니다.'
      return changed > 0
    },
  },
  {
    id: 'minimalDocuments',
    apply(working, state) {
      let changed = 0
      for (const map of working.maps) for (const key of Object.keys(map)) if (!MINIMAL_DOCUMENT_FIELDS.has(key)) { delete map[key]; changed++ }
      if (changed) state.fields['maps[]'] = `문서마다 ${[...MINIMAL_DOCUMENT_FIELDS].join('·')}만 남겼습니다. 다른 문서 정보는 retrieval.document로 조회하세요.`
      return changed > 0
    },
  },
]

export const DOCUMENT_LIST_BUDGET_STEP_IDS = Object.freeze(DOCUMENT_LIST_STEPS.map((step) => step.id))

function assemble(working, state, context) {
  const retrieval = {
    ...(state.applied.includes('minimalDocuments') ? { document: { tool: 'mindnprogress_get_document', arguments: { mapId: '<mapId>', view: 'outline' } } } : {}),
    ...(state.applied.includes('authors') ? { users: { tool: 'mindnprogress_list_users', arguments: {} } } : {}),
    ...(state.applied.includes('groupProject') ? { group: { tool: 'mindnprogress_get_group_context', arguments: { groupId: '<groupId>' } } } : {}),
  }
  const omitted = {
    scope: '응답이 AI 클라이언트의 도구 출력 한도를 넘지 않도록 문서 항목은 모두 두고 중복·세부 필드만 줄였습니다.',
    fields: state.fields,
    ...(Object.keys(state.counts).length > 0 ? { counts: state.counts } : {}),
    rule: '생략된 필드를 추측하지 말고, 필요하면 retrieval의 도구로 조회하세요.',
    retrieval,
  }
  const responseBudget = { limitChars: context.limitChars, originalChars: context.originalChars, returnedChars: context.limitChars,
    documents: working.maps.length, appliedSteps: [...state.applied], exceeded: false }
  // 코드로 일부만 출력하거나 긴 출력의 중간이 잘려도 보이도록 맨 앞에 둔다.
  return { responseBudget, omitted, ...working }
}

/** list_documents 응답이 limitChars를 넘을 때만 문서 항목은 두고 중복·세부 필드를 줄인 새 응답을 만든다. 넘지 않으면 원래 객체를 그대로 반환한다. */
export function applyDocumentListBudget(response, { limitChars = DOCUMENT_LIST_RESPONSE_BUDGET_CHARS } = {}) {
  if (!Array.isArray(response?.maps)) return response
  const originalChars = size(response)
  if (originalChars <= limitChars) return response
  const working = structuredClone(response)
  const state = { fields: {}, counts: {}, applied: [] }
  const context = { limitChars, originalChars }
  const fits = () => size(assemble(working, state, context)) <= limitChars
  for (const step of DOCUMENT_LIST_STEPS) {
    // 단계 안에서 크기를 잴 때도 appliedSteps에 이 단계가 들어 있어야 최종 크기와 같다. 줄인 것이 없으면 뺀다.
    state.applied.push(step.id)
    if (!step.apply(working, state)) state.applied.pop()
    if (fits()) break
  }
  const result = assemble(working, state, context)
  for (let attempt = 0; attempt < 3; attempt++) {
    const returnedChars = size(result)
    if (result.responseBudget.returnedChars === returnedChars) break
    result.responseBudget.returnedChars = returnedChars
    result.responseBudget.exceeded = returnedChars > limitChars
  }
  return result
}
