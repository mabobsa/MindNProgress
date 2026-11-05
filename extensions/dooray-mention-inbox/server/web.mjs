import { createServer } from 'node:http'
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

// 브라우저 화면용 로컬 웹 서버. Claude 앱이 확장 서버를 실행하는 동안 이 PC 안에서만 열린다.
// 북마크가 계속 동작하도록 포트와 접근 키를 상태 폴더에 저장해 다시 쓴다.

const PORT_RANGE = [38100, 38999]
const MAX_BODY_BYTES = 64 * 1024

export async function loadWebSettings(stateDirectory, { pickPort = () => randomInt(PORT_RANGE[0], PORT_RANGE[1] + 1) } = {}) {
  const file = path.join(stateDirectory, 'web.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (Number.isInteger(parsed?.port) && /^[a-f0-9]{48}$/.test(parsed?.key ?? '')) return { port: parsed.port, key: parsed.key, file }
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  return saveWebSettings(file, { port: pickPort(), key: randomBytes(24).toString('hex') })
}

export async function saveWebSettings(file, { port, key }) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({ port, key })}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
  return { port, key, file }
}

const sameSecret = (supplied, expected) => {
  const left = Buffer.from(String(supplied ?? ''))
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  // 주소의 접근 키가 Dooray 등 다른 사이트로 전달되지 않게 한다.
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

function send(response, status, body, contentType = 'application/json; charset=utf-8', extra = {}) {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': contentType, ...extra })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('요청 본문이 너무 큽니다.'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('JSON 형식이 올바르지 않습니다.'), { status: 400 })
  }
}

export function createWebServer({ getInbox, html, key, port }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const url = `http://127.0.0.1:${port}/?key=${key}`
  const page = html.replace('<meta name="dooray-mention-inbox-mode" content="app">', '<meta name="dooray-mention-inbox-mode" content="web">')
  const contentSecurityPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

  const server = createServer(async (request, response) => {
    try {
      // 다른 이름으로 이 포트에 접근하는 DNS 재바인딩과, 다른 사이트에서 보낸 요청을 막는다.
      if (!allowedHosts.has(String(request.headers.host ?? ''))) return send(response, 403, { error: '허용하지 않은 주소입니다.' })
      const origin = request.headers.origin
      if (origin !== undefined && !allowedOrigins.has(origin)) return send(response, 403, { error: '허용하지 않은 출처입니다.' })
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (request.method === 'GET' && requestUrl.pathname === '/') {
        if (!sameSecret(requestUrl.searchParams.get('key'), key)) {
          return send(response, 403, '<!doctype html><meta charset="utf-8"><p>주소가 올바르지 않습니다. Claude의 Dooray 멘션 확인함 화면에서 「브라우저에서 열기」를 다시 눌러 주세요.</p>', 'text/html; charset=utf-8')
        }
        return send(response, 200, page, 'text/html; charset=utf-8', { 'Content-Security-Policy': contentSecurityPolicy })
      }
      if (!requestUrl.pathname.startsWith('/api/')) return send(response, 404, { error: '찾을 수 없습니다.' })
      // API는 사용자 지정 헤더로 키를 받는다. 다른 출처의 페이지는 이 헤더를 붙여 보낼 수 없다.
      if (!sameSecret(request.headers['x-inbox-key'], key)) return send(response, 403, { error: '접근 키가 올바르지 않습니다.' })
      if (request.method === 'GET' && requestUrl.pathname === '/api/ping') return send(response, 200, { name: 'dooray-mention-inbox' })
      if (request.method === 'GET' && requestUrl.pathname === '/api/state') {
        const days = Number(requestUrl.searchParams.get('days')) || undefined
        const state = await getInbox().uiState({ refresh: requestUrl.searchParams.get('refresh') === '1', days })
        return send(response, 200, state)
      }
      if (request.method === 'POST' && requestUrl.pathname === '/api/check') {
        if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) return send(response, 415, { error: 'JSON으로 보내야 합니다.' })
        const body = await readJsonBody(request)
        const keys = Array.isArray(body.keys) ? body.keys.filter((item) => typeof item === 'string').slice(0, 200) : []
        if (!keys.length) return send(response, 400, { error: '확인 처리할 항목이 없습니다.' })
        return send(response, 200, await getInbox().setChecked({ keys, checked: body.checked !== false }))
      }
      return send(response, 404, { error: '찾을 수 없습니다.' })
    } catch (error) {
      return send(response, error?.status ?? 500, { error: error?.message ?? String(error) })
    }
  })

  return {
    server,
    url,
    listen: () => new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error) }
      const onListening = () => { server.off('error', onError); resolve(url) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

// 저장된 포트로 띄우고, 다른 프로그램이 쓰고 있으면 새 포트를 한 번 골라 저장한다.
// 같은 확장 서버가 이미 그 포트를 쓰는 경우(앱이 서버를 두 번 띄운 경우)에는 새 포트를 고르지 않는다.
export async function startWebServer({ getInbox, html, stateDirectory, isOwnServer = defaultIsOwnServer, log = () => {} }) {
  let settings = await loadWebSettings(stateDirectory)
  for (let attempt = 0; attempt < 2; attempt++) {
    const web = createWebServer({ getInbox, html, key: settings.key, port: settings.port })
    try {
      await web.listen()
      return web
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
      if (await isOwnServer(settings)) { log(`브라우저 화면은 이미 실행 중인 다른 확장 서버가 제공합니다: 포트 ${settings.port}`); return { url: `http://127.0.0.1:${settings.port}/?key=${settings.key}`, shared: true, close: async () => {} } }
      settings = await saveWebSettings(settings.file, { port: randomInt(PORT_RANGE[0], PORT_RANGE[1] + 1), key: settings.key })
    }
  }
  log('브라우저 화면용 포트를 열지 못했습니다.')
  return null
}

async function defaultIsOwnServer({ port, key }) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { headers: { 'X-Inbox-Key': key }, signal: AbortSignal.timeout(3_000) })
    return response.ok && (await response.json())?.name === 'dooray-mention-inbox'
  } catch {
    return false
  }
}
