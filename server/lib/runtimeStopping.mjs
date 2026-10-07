export class RuntimeStoppingError extends Error {
  constructor(details = {}) {
    super('서버를 종료하고 있습니다. 요청의 실행 결과를 확인하지 못했을 수 있습니다.')
    this.name = 'RuntimeStoppingError'
    this.code = 'RUNTIME_STOPPING'
    this.reasonCode = 'RUNTIME_STOPPING'
    Object.assign(this, details)
  }
}

export function isRuntimeStoppingError(error) {
  return error?.code === 'RUNTIME_STOPPING' || error?.reasonCode === 'RUNTIME_STOPPING'
}

export function throwIfRuntimeStopping(error, signal) {
  if (isRuntimeStoppingError(error)) throw error
  signal?.throwIfAborted()
}

// 종료 중에는 원격 실행 확인을 재시도하지 않는다. 기존의 일반 장애 재시도는 유지한다.
export async function retryDispatchStatus(read, signal, { attempts = 10, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    signal.throwIfAborted()
    if (attempt > 0) {
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, delayMs)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    try {
      const result = await read()
      if (result) return result
    } catch (error) { throwIfRuntimeStopping(error, signal) }
  }
}
