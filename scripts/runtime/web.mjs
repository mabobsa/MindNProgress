import { createServer } from 'vite'
import { installRuntimeShutdown } from '../../server/lib/runtimeLifecycle.mjs'

let server
// 시작 도중 들어온 종료 요청도 listen 완료 후 처리한다.
let ready
const initialized = new Promise((resolve) => { ready = resolve })
installRuntimeShutdown(async () => { await initialized; await server?.close() })
try {
  // 기동 지연을 API와 나눠 판단할 수 있도록 웹(Vite) 생성·listen 시간을 남긴다.
  const createStartedAt = performance.now()
  server = await createServer({ server: { port: Number(process.env.MNP_WEB_PORT ?? 4175), strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${Number(process.env.MNP_API_PORT ?? 4176)}`, xfwd: true } } } })
  const listenStartedAt = performance.now()
  await server.listen()
  server.printUrls()
  console.log(`[Web startup timing] ${JSON.stringify({ importMs: Math.round(createStartedAt),
    createServerMs: Math.round(listenStartedAt - createStartedAt), listenMs: Math.round(performance.now() - listenStartedAt),
    processUptimeMs: Math.round(performance.now()) })}`)
} finally { ready() }
