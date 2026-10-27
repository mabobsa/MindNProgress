// 테스트 프로세스의 IPC로만 주입한다. 운영 HTTP·환경 변수에는 장애 주입 경로가 없다.
import { channel } from 'node:diagnostics_channel'
let crash
process.on('message', (message) => {
  if (message?.action === 'crash-phase') { crash = message; process.send?.({ phase: 'crash-armed' }) }
})
channel('mindnprogress.storage.phase').subscribe((event) => {
  if (!crash || event.name !== crash.name || crash.index !== undefined && event.index !== crash.index
    || crash.requestId && event.requestId !== crash.requestId
    || crash.effect && !event.transactionId?.startsWith('effect-')
    || event.transactionId?.startsWith('effect-') && !crash.effect) return
  process.kill(process.pid, 'SIGKILL')
})
