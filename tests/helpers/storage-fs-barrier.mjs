// 격리 시험 프로세스의 FS 어댑터. 운영 서버에는 API·환경 변수 hook을 추가하지 않는다.
import fs from 'node:fs/promises'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const barriers = new Map()
const intervals = new Map()
const setIntervalOriginal = globalThis.setInterval
globalThis.setInterval = (callback, delay, ...args) => {
  const callbacks = intervals.get(delay) ?? []
  callbacks.push(() => callback(...args)); intervals.set(delay, callbacks)
  return setIntervalOriginal(callback, delay, ...args)
}
process.on('message', (value) => {
  if (value?.action === 'arm') {
    barriers.set(value.id, { ...value, remaining: value.skip ?? 0 })
    process.send?.({ id: value.id, phase: 'armed' })
  } else if (value?.action === 'release') barriers.get(value.id)?.release?.()
  else if (value?.action === 'tick') {
    const callbacks = intervals.get(value.delay) ?? []
    for (const callback of callbacks) callback()
    process.send?.({ id: value.id, phase: 'ticked', count: callbacks.length })
  }
})
for (const method of ['readFile', 'writeFile', 'rename', 'rm']) {
  const original = fs[method]
  fs[method] = async (...args) => {
    const file = path.resolve(String(method === 'rename' ? args[1] : args[0]))
    for (const [id, barrier] of barriers) {
      if (barrier.method !== method || !(barrier.prefix ? file.startsWith(barrier.file) : barrier.file === file) || barrier.entered) continue
      if (barrier.remaining-- > 0) continue
      barrier.entered = true
      process.send?.({ id, phase: 'reached' })
      await new Promise((resolve) => { barrier.release = resolve })
      barriers.delete(id)
      if (barrier.fail) {
        if (barrier.failAfter) await original(...args)
        throw Object.assign(new Error('주입된 저장 실패'), { code: 'EIO' })
      }
    }
    return original(...args)
  }
}
syncBuiltinESMExports()
