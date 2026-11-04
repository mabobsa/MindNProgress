import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { localLoopbackRedirectLocation } from './server/lib/localLoopbackRedirect.mjs'

function localLoopbackRedirectPlugin(): Plugin {
  return {
    name: 'mindnprogress-local-loopback-redirect',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const location = localLoopbackRedirectLocation(request)
        if (!location) return next()
        response.statusCode = 307
        response.setHeader('Location', location)
        response.setHeader('Cache-Control', 'no-store')
        response.end()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [localLoopbackRedirectPlugin(), react()],
  server: {
    host: '0.0.0.0',
    port: 4175,
    strictPort: true,
    watch: {
      // 실행 데이터·이력 파일과 .tmp의 작업 사본·빌드 사본은 프런트엔드 변경 감시에서 제외한다.
      // .tmp에 MnP 사본이 쌓이면 감시 핸들이 수만 개로 늘어 웹 기동·종료가 느려진다.
      ignored: ['**/server/data/**', '**/.tmp/**'],
    },
    proxy: {
      // xfwd로 실제 접속 주소를 전달해야 서버가 같은 PC 요청인지 판별할 수 있다.
      '/api': { target: 'http://127.0.0.1:4176', xfwd: true },
    },
  },
  optimizeDeps: {
    // 기본값은 루트 아래 모든 HTML을 의존성 스캔 진입점으로 써서 .tmp 작업 사본의 index.html까지 스캔한다.
    entries: ['index.html'],
  },
})
