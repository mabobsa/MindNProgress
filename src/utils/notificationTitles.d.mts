export type DelegationNotificationStatus = {
  id: string | null
  state: string | null
  status: 'resolved' | 'ended' | 'action-required' | 'report-pending' | 'in-progress' | 'unknown'
  message: string
  updatedAt: string | null
}
export type NotificationTitleSource = {
  type?: string
  actor?: { name?: string } | null
  dedupeKey?: string
  delegationId?: string
  delegationKind?: string
  delegationStatus?: DelegationNotificationStatus
}
export function notificationTitle(notification: NotificationTitleSource | null | undefined): string
export function notificationDelegationReference(notification: NotificationTitleSource | null | undefined): { id: string; kind?: string } | null
export function updateDelegationNotificationStatuses<T extends NotificationTitleSource>(notifications: T[], status: DelegationNotificationStatus | null | undefined): T[]
