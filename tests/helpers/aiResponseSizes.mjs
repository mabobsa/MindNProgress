import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureInitialResponses } from '../../scripts/capture-guidance-evidence.mjs'

// 대표 조회 도구의 응답 문자 수 상한이다. 결정적 fixture(카드 2개, 위임·댓글 없음)로 잰
// 고정 지침 부담이며 실제 운영 문서·위임 결과가 더하는 동적 크기는 포함하지 않는다.
// 상한은 2026-10-21 측정값에 약 15% 여유를 둔 경고선이다. 넘으면 축약하지 말고
// 중복 삽입 여부를 먼저 확인한다(docs/ai-guidance-rollback-2026-10-01/rollback-cause-record.md).
// get_group_context 경고선은 2026-10-29 요약 기본값의 원문 회수 안내(detail)를 더한 8,547자에 같은 여유를 둔 값이다.
// 같은 날 루트 textIntegrity·생략 ID·회수 경로 정정을 더해 9,485자가 됐고, 경고선 안이라 올리지 않았다.
// get_document 응답 형태는 별도 조사 대상이라 여기서 재지 않는다.
export const AI_RESPONSE_SIZE_LIMITS = Object.freeze({
  'read-me-first': 20_000,
  'leaf:get_context': 27_000,
  'document-coordinator:get_context': 27_000,
  'group-coordinator:get_context': 32_500,
  'group:get_group_context': 9_800,
})

export const AI_RESPONSE_SIZE_METHOD = 'scripts/capture-guidance-evidence.mjs의 captureInitialResponses로 실제 MCP 핸들러를 격리 fixture API에 연결해 호출하고 응답 text 문자 수를 잽니다. 토큰 수나 호스트 총주입량이 아닙니다.'

/** Measure representative MCP query responses against the deterministic guidance fixture. */
export async function measureAiResponseSizes(root) {
  const temp = await mkdtemp(path.join(tmpdir(), 'mnp-response-size-'))
  if (path.dirname(path.resolve(temp)) !== path.resolve(tmpdir()) || !path.basename(temp).startsWith('mnp-response-size-')) throw new Error('응답 크기 측정 임시 경로 검증 실패')
  try {
    const { sessions } = await captureInitialResponses(root, temp)
    const items = sessions.map((session) => ({
      name: session.name === 'read-me-first' ? 'read-me-first' : `${session.name}:get_context`,
      tool: session.firstTool,
      chars: session.response.length,
      guideChars: session.guide.length,
    }))
    const group = sessions.find((session) => session.groupResponse)
    if (group) items.push({ name: 'group:get_group_context', tool: 'mindnprogress_get_group_context', chars: group.groupResponse.length, guideChars: group.groupGuide.length })
    return items
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/** Return warnings for responses above their limit or without a configured limit. */
export function aiResponseSizeWarnings(items, limits = AI_RESPONSE_SIZE_LIMITS) {
  return items.flatMap((item) => {
    const limit = limits[item.name]
    if (!Number.isInteger(limit)) return [`${item.name}: 응답 크기 상한이 정의되지 않았습니다.`]
    return item.chars > limit ? [`${item.name}: 응답 ${item.chars}자가 상한 ${limit}자를 넘었습니다.`] : []
  })
}
