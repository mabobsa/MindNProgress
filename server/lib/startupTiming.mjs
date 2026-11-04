import { performance } from 'node:perf_hooks'

// 기동 단계별 소요 시간을 한 줄로 남긴다. 단계 사이에 mark만 넣으므로 기존 기동 순서와 오류 처리는 바뀌지 않는다.
// performance.now()는 프로세스 시작 기준이라 생성 시점 값이 모듈 import·평가에 걸린 시간이다.
export function createStartupTiming({ now = () => performance.now() } = {}) {
  const startedAt = now()
  let lastAt = startedAt
  const phases = []
  return {
    mark(name) {
      const at = now()
      phases.push({ name, ms: Math.round(at - lastAt) })
      lastAt = at
    },
    summary() {
      const at = now()
      const slowest = [...phases].sort((first, second) => second.ms - first.ms).slice(0, 5).map((phase) => phase.name)
      return {
        importMs: Math.round(startedAt),
        totalMs: Math.round(at - startedAt),
        processUptimeMs: Math.round(at),
        slowest,
        phases,
      }
    },
  }
}
