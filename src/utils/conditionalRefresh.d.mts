export function createConditionalRefresh<T>(
  load: (etag: string | null) => Promise<Response>,
  onValue: (value: T) => void,
  delayMs?: number,
): { request(): Promise<void>; dispose(): void }
