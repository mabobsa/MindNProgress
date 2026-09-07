// Runner의 실행 주기다. 전송 수단을 주입받아 네트워크 없이 검증할 수 있다.
//
// 서버는 가져간 오퍼레이션을 재전달하지 않으므로, 로컬 AionUi 호출이 실패해도
// 결과를 비워 두면 안 된다. 실패도 반드시 결과로 올려 요청자가 상한을 기다리지 않게 한다.

export function createRunnerLoop({
  claimOperations,
  callAionUi,
  reportResult,
  onEvent = () => {},
  concurrency = 4,
  retryDelayMs = 3_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let running = false
  let stopped = false

  async function settleOperation(operation) {
    let result
    try {
      result = await callAionUi(operation.request)
    } catch (error) {
      // 로컬 AionUi에 닿지 못한 것도 결과다. 올리지 않으면 요청자가 상한까지 기다린다.
      result = {
        ok: false,
        status: null,
        code: 'RUNNER_LOCAL_CALL_FAILED',
        message: error instanceof Error ? error.message : String(error),
      }
    }

    try {
      await reportResult(operation.operationId, result)
      onEvent({
        type: result.ok ? 'operation-succeeded' : 'operation-failed',
        operationId: operation.operationId,
        pathname: operation.request?.pathname,
        status: result.status ?? null,
      })
    } catch (error) {
      // 결과 전달에 실패하면 서버가 상한으로 정리한다. 같은 오퍼레이션을 다시 실행하지 않는다.
      onEvent({ type: 'report-failed', operationId: operation.operationId, error })
    }
  }

  // 동시 실행 수를 제한해 로컬 AionUi에 몰아치지 않게 한다.
  async function settleAll(operations) {
    const queue = [...operations]
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) {
        const operation = queue.shift()
        if (operation) await settleOperation(operation)
      }
    })
    await Promise.all(workers)
  }

  async function runOnce() {
    const operations = await claimOperations()
    if (!Array.isArray(operations) || operations.length === 0) return 0
    onEvent({ type: 'claimed', count: operations.length })
    await settleAll(operations)
    return operations.length
  }

  async function start() {
    if (running) throw new Error('Runner 주기가 이미 실행 중입니다.')
    running = true
    stopped = false
    onEvent({ type: 'started' })

    while (!stopped) {
      try {
        await runOnce()
      } catch (error) {
        // MnP에 닿지 못하는 상황이다. 대기 후 다시 시도한다.
        onEvent({ type: 'claim-failed', error })
        if (stopped) break
        await sleep(retryDelayMs)
      }
    }

    running = false
    onEvent({ type: 'stopped' })
  }

  function stop() {
    stopped = true
  }

  return { runOnce, start, stop, get running() { return running } }
}
