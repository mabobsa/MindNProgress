export const AI_USAGE_GUIDE = Object.freeze({
  tool: 'mindnprogress_get_ai_usage',
  input: 'provider는 all(기본값), claude, codex 중 하나입니다. 문서·카드 ID는 필요하지 않습니다.',
  source: 'MnP 서버가 읽은 AionUi 구독 사용량 스냅샷입니다. 서브 머신에서 호출해도 서브 머신의 계정 사용량으로 바뀌지 않으며, 현재 대화의 로그인 계정과 일치하는지는 확인되지 않았습니다.',
  interpretation: 'usedPercent는 사용률, remainingPercent는 100에서 사용률을 뺀 참고 잔여율입니다. 초기화 시각은 UTC입니다. 컨텍스트 토큰 사용량이나 남은 요청 횟수를 의미하지 않습니다.',
  freshness: '제공자별 updatedAt과 stale, usable을 확인하세요. available은 스냅샷 존재 여부이며 최신성을 보장하지 않습니다. usable=false인 값은 현재 한도 판단에 사용하지 말고, null은 미확인으로 보고하세요.',
  workflow: '사용자가 사용량을 묻거나 작업·위임 계획에 한도 확인이 필요할 때 조회합니다. 기존 스냅샷만 읽으며 강제 갱신이나 반복 대기를 하지 않습니다. 사용량만으로 승인된 작업을 중단하거나 모델·위임 대상을 자동 변경하지 않습니다.',
})

function usageWindow(value) {
  if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)
    || value.usedPercent < 0 || value.usedPercent > 100) return null
  return {
    usedPercent: value.usedPercent,
    remainingPercent: Math.round((100 - value.usedPercent) * 100) / 100,
    resetsAt: value.resetsAt ?? null,
    ...(Object.hasOwn(value, 'windowDurationMins') ? { windowDurationMins: value.windowDurationMins } : {}),
  }
}

function providerUsage(value, name, now) {
  const state = ['loading', 'ready', 'unavailable'].includes(value?.state) ? value.state : 'unavailable'
  const updatedAt = typeof value?.updatedAt === 'string' ? value.updatedAt : null
  const timestamp = updatedAt ? Date.parse(updatedAt) : NaN
  const ageSeconds = Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / 1000)) : null
  const stale = state === 'ready' && (value?.stale !== false || ageSeconds === null)
  const weekly = usageWindow(value?.weekly)
  // Codex 5시간 창은 요금제에 따라 없으며 그때는 null이다. 한도 도달 여부는 AionUi가 두 창을 함께 판정한 limitReached를 쓴다.
  const session = usageWindow(value?.session)
  return {
    state,
    usable: state === 'ready' && !stale && Boolean(session || weekly),
    stale,
    updatedAt,
    ageSeconds,
    session,
    weekly,
    ...(name === 'codex' ? { limitReached: state === 'ready' && typeof value?.limitReached === 'boolean' ? value.limitReached : null } : {}),
  }
}

export function buildAiUsageResult(usage, { provider = 'all', now = Date.now() } = {}) {
  const names = provider === 'all' ? ['claude', 'codex'] : [provider]
  return {
    source: {
      kind: 'aionui-subscription-snapshot',
      machineScope: 'mnp-server',
      conversationAccountMatch: 'unverified',
    },
    queriedAt: new Date(now).toISOString(),
    snapshot: {
      available: usage?.available === true,
      state: usage?.state ?? 'unavailable',
      generatedAt: usage?.generatedAt ?? null,
      updatedAt: usage?.updatedAt ?? null,
    },
    providers: Object.fromEntries(names.map((name) => [name, providerUsage(usage?.[name], name, now)])),
    // Claude 멀티 계정: 계정이 2개 이상일 때만 공유 번호 순서의 계정별 값을 더한다. providers.claude는 AionUi 기본 계정이다.
    ...(names.includes('claude') && Array.isArray(usage?.claudeAccounts) && usage.claudeAccounts.length >= 2
      ? { claudeAccounts: usage.claudeAccounts.map((account) => ({
          id: account.id, number: account.number, label: account.label, ...providerUsage(account, 'claude', now),
        })) }
      : {}),
  }
}
