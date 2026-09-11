export function completedReplacementDelegations(delegation, delegations) {
  const parentMapId = delegation?.parentMapId ?? delegation?.mapId
  const failedCleanLimit = ['waiting-usage-limit', 'waiting-rate-limit'].includes(delegation?.state)
    && (!delegation?.workspaceLease?.leaseId
      || ['failed-clean', 'cancelled'].includes(delegation?.workspaceResult?.status))
  const completedReportFailure = !delegation?.groupId
    && delegation?.state === 'parent-wake-failed'
    && delegation?.workCompleted === true
  if (!failedCleanLimit && !completedReportFailure) return []
  return (Array.isArray(delegations) ? delegations : [])
    .filter((candidate) => candidate?.id !== delegation?.id
      && candidate?.state === 'completed'
      && candidate?.workCompleted === true
      && (candidate?.groupId ?? null) === (delegation?.groupId ?? null)
      && candidate?.mapId === delegation?.mapId
      && (candidate?.parentMapId ?? candidate?.mapId) === parentMapId
      && candidate?.parentCardId === delegation?.parentCardId
      && candidate?.targetCardId === delegation?.targetCardId
      && String(candidate?.createdAt ?? '') > String(delegation?.createdAt ?? ''))
    .sort((first, second) => String(first.createdAt ?? '').localeCompare(String(second.createdAt ?? '')))
}
