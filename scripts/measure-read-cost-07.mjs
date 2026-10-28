import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { storageApi, fixture } from '../tests/helpers/storage-api-harness.mjs'
import { seedReadFixture } from '../tests/helpers/read-cost-fixture.mjs'

const [baselineArg, candidateArg, outputArg] = process.argv.slice(2)
if (!baselineArg || !candidateArg || !outputArg) throw Error('기준 소스·후보 소스·새 출력 경로가 필요합니다.')
const roots = { baseline: path.resolve(baselineArg), candidate: path.resolve(candidateArg) }
const out = path.resolve(outputArg)
await mkdir(out, { recursive: false })
const hash = (data) => createHash('sha256').update(data).digest('hex')
const metricsImport = pathToFileURL(path.resolve(import.meta.dirname, '../tests/helpers/integration-cost-metrics.mjs')).href
const result = { startedAt: new Date().toISOString(), baselineSha: '10afee7555f3ee9810cd7280da72815c5d599a01',
  candidateSha: '258faefbb0d9cc87345ccd8075f490ec20ff361c',
  environment: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model, cores: os.cpus().length,
    memoryBytes: os.totalmem(), node: process.version, nodeExecutable: process.execPath,
    cpuBasis: '프로세스 user/system CPU 밀리초, 코어 하나가 100%인 누적 시간',
    bytesBasis: '응답 본문 UTF-8 bytes; 헤더·TCP 프레이밍 제외',
    background: '양 버전의 반복 타이머와 listen 뒤 귀속·lease 복구 중단, 시작 migration은 유지, 모의 AionUi, 실제 AI·Runner 없음',
    instrumentation: '격리 --import에서 FS read·JSON parse·structuredClone bytes 계수 및 10ms RSS 표본; Ref 함수 진입 계수. 동일 계측의 CPU 비용 포함.',
    samples: { cold: 1, warmup: 5, warm: 60 }, commentPage: { cardId: 'card-1', offset: 1, limit: 2, order: 'desc', includeDetail: false },
  }, sourceFiles: {}, fixtures: {}, cells: [] }
for (const [name, root] of Object.entries(roots)) result.sourceFiles[name] = Object.fromEntries(await Promise.all(
  ['server/index.mjs', 'server/lib/documentReadStore.mjs', 'mcp/server.mjs', 'mcp/documentViews.mjs'].map(async (file) => [file, hash(await readFile(path.join(root, file)))])))
try { result.environment.disk = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_DiskDrive | Select-Object Model,MediaType,Size | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true })) } catch { result.environment.disk = '조회 불가' }
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replaceAll(/http:\/\/127\.0\.0\.1:\d+/g, '<격리 주소>') : value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['documentEtag', 'freshness', 'createdAt', 'readAt', 'id', 'updatedAt'].includes(key) || !value.dedupeKey)
    .filter(([key]) => !['documentEtag', 'freshness', 'reviewContextToken'].includes(key)).map(([key, item]) => [key, normalize(item)]))
}
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
}
const stats = (times) => { const sorted = [...times].sort((a, b) => a - b); return { n: times.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) } }
const fingerprints = new Map()
const allScenarios = ['card', 'ref-card', 'outline', 'review', 'delegations', 'notifications-empty', 'notifications-schedule']
const scenarios = process.env.MNP_MEASURE_SCENARIOS?.split(',') ?? allScenarios
assert.ok(scenarios.length && scenarios.every((name) => allScenarios.includes(name)), '측정 시나리오 확인')
result.instrumentationFiles = Object.fromEntries(await Promise.all([
  ['scripts/measure-read-cost-07.mjs', new URL(import.meta.url)],
  ['tests/helpers/integration-cost-metrics.mjs', new URL('../tests/helpers/integration-cost-metrics.mjs', import.meta.url)],
].map(async ([name, file]) => [name, hash(await readFile(file))])))
for (const scenario of scenarios) for (const concurrency of (process.env.MNP_MEASURE_CONCURRENCY?.split(',').map(Number) ?? [1, 10, 20])) {
  const order = (allScenarios.indexOf(scenario) * 3 + [1, 10, 20].indexOf(concurrency)) % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']
  for (const variant of order) {
    process.env.MNP_STORAGE_TEST_SOURCE_ROOT = roots[variant]
    const after = []
    let api
    try { api = await storageApi({ after: (fn) => after.push(fn) }, { documents: 96, readyTimeoutMs: 60000, env: { NODE_OPTIONS: `--import=${metricsImport}` },
      seed: async (args) => { await seedReadFixture(args)
        if (scenario === 'notifications-empty') await writeFile(path.join(args.data, `${args.ids[7]}.json`), JSON.stringify(fixture(args.ids[7])))
      } }) } catch (error) { for (const cleanup of after.reverse()) await cleanup(); throw error }
    try {
      const mapId = api.ids[scenario === 'ref-card' || scenario === 'outline' ? 1 : scenario === 'delegations' ? 7 : 0]
      const views = await import(pathToFileURL(path.join(roots[variant], 'mcp/documentViews.mjs')).href)
      let calls = 0, wireBytes = 0, outputBytes = 0, etag, held, responses = [], sample
      const get = async (route, conditional = false) => {
        calls++
        const response = await fetch(api.base + route, { headers: { ...api.headers, ...(conditional && etag ? { 'If-None-Match': etag } : {}) } })
        const body = await response.text(); wireBytes += Buffer.byteLength(body); responses.push({route,status:response.status,requestUtf8Bytes:0,responseUtf8Bytes:Buffer.byteLength(body)})
        if (response.status === 304) { assert.ok(held); return held }
        assert.equal(response.status, 200, `${variant} ${route}: ${body}`)
        const value = JSON.parse(body)
        if (conditional) { etag = response.headers.get('etag'); held = value }
        return value
      }
      const operation = async () => {
        let value
        if (scenario === 'card' || scenario === 'ref-card') {
          let doc, comments
          if (variant === 'baseline') {
            const [d, c] = await Promise.all([get(`/api/maps/${mapId}`), get(`/api/maps/${mapId}/comments?nodeId=card-1&includeDetail=false`), get('/api/health')])
            doc = d; comments = [...c.comments].reverse().slice(1, 3)
          } else {
            doc = await get(`/api/maps/${mapId}?readCard=card-1&commentOffset=1&commentLimit=2&commentOrder=desc&includeCommentDetail=false`)
            comments = doc.comments
          }
          value = { card: doc.map.nodes.find((node) => node.id === 'card-1'), comments, documentGroups: doc.documentGroups }
        } else if (scenario === 'outline') {
          if (variant === 'baseline') {
            const [doc, health] = await Promise.all([get(`/api/maps/${mapId}`), get('/api/health')])
            value = views.buildDocumentView(doc, { view: 'outline', cardIds: ['card-1'], publicBaseUrl: health.publicBaseUrl, imageAccessOf: () => null })
          } else value = await get(`/api/maps/${mapId}?mcpView=outline&cardId=card-1`)
        } else if (scenario === 'review') {
          value = (await get(`/api/maps/${mapId}/cards/card-1/shared-knowledge-review-context?commentLimit=2&includeCommentDetail=false`)).context
          if (!value.documentGroups) value.documentGroups = (await get(`/api/document-groups?mapId=${mapId}`)).documentGroups
          // 이 fixture에는 선행 지식·Ref 출처가 없다. 03에서 추가한 빈 출처 목록을 명시적으로 맞춘다.
          value.sources ??= []
          assert.deepEqual(value.sources, [])
          if (variant === 'candidate') assert.ok(value.reviewContextToken)
        } else if (scenario === 'delegations') {
          value = await get(`/api/maps/${mapId}/ai-delegations?includeResult=true`, true)
          assert.equal(value.delegations.length, 200); assert.equal(value.delegations[0].result.length, 1000)
        } else value = await get('/api/notifications')
        sample ??= value
        outputBytes += Buffer.byteLength(JSON.stringify(value))
        const fingerprint = hash(JSON.stringify(canonical(normalize(value))))
        const key = scenario
        if (fingerprints.has(key)) assert.equal(fingerprint, fingerprints.get(key), `${scenario} 필수 내용 비교`)
        else fingerprints.set(key, fingerprint)
      }
      const fixtureHashes = {}, fixtureBytes = {}
      for (const file of (await readdir(api.data)).filter((name) => name.startsWith('map-') || name === '_ai-delegations.json').sort()) {
        const value = await readFile(path.join(api.data, file)); fixtureHashes[file] = hash(value); fixtureBytes[file] = value.byteLength
      }
      for (const file of (await readdir(path.join(api.data, '_comments'))).sort()) {
        const value = await readFile(path.join(api.data, '_comments', file)); fixtureHashes[`_comments/${file}`] = hash(value); fixtureBytes[`_comments/${file}`] = value.byteLength
      }
      const fixtureHash = hash(JSON.stringify(fixtureHashes))
      result.fixtures[fixtureHash] ??= { files: fixtureHashes, fileBytes: fixtureBytes, totalBytes: Object.values(fixtureBytes).reduce((sum, bytes) => sum + bytes, 0) }
      const phase = async (count, parallel) => {
        calls = wireBytes = outputBytes = 0; responses = []
        await api.readMetrics(true)
        const times = []
        for (let offset = 0; offset < count; offset += parallel) await Promise.all(Array.from({ length: Math.min(parallel, count - offset) }, async () => {
          const started = performance.now(); await operation(); times.push(performance.now() - started)
        }))
        return { attempts:calls, logicalRequests:count, successResponses:responses.filter(x=>[200,304].includes(x.status)).length, committedIds:[], expectedEffects:[], actualEffects:[], retries:0, httpSamples:responses, requestUtf8Bytes:0, httpCalls: calls, responseUtf8Bytes: wireBytes, logicalOutputUtf8Bytes: outputBytes, latencyMs: stats(times), ...await api.readMetrics() }
      }
      const notificationFile = '_notifications/user-editor.json'
      const readNotifications = async () => { try { return await api.read(notificationFile) } catch (error) { if (error.code !== 'ENOENT') throw error; return [] } }
      const beforeNotifications = scenario.startsWith('notifications-') ? await readNotifications() : null
      const cold = await phase(1, 1)
      const coldNotifications = beforeNotifications ? await readNotifications() : null
      for (let i = 0; i < 5; i++) await operation()
      const warm = await phase(60, concurrency)
      const cell = { sequence: result.cells.length, scenario, concurrency, variant, fixtureHash, semanticHash: fingerprints.get(scenario), cold, warm }
      if (beforeNotifications) {
        const finalNotifications = await readNotifications(), schedules = finalNotifications.filter(n => n.type === 'schedule')
        const expected = scenario === 'notifications-schedule' ? Array.from({length:20}, (_,i)=>`${api.ids[7]}/card-${i}`).sort() : []
        const actual = schedules.map(n=>`${n.mapId}/${n.nodeId}`).sort()
        assert.deepEqual(actual, expected)
        assert.deepEqual(finalNotifications, coldNotifications, 'warm 조회는 일정 알림을 중복 생성하지 않는다')
        cold.expectedEffects = expected; cold.actualEffects = coldNotifications.filter(n=>n.type==='schedule').map(n=>`${n.mapId}/${n.nodeId}`).sort()
        cell.notificationAuthority = { file: notificationFile, beforeCount: beforeNotifications.length, coldCount: coldNotifications.length,
          finalCount: finalNotifications.length, sha256: hash(JSON.stringify(finalNotifications)), uniqueDedupeKeys: new Set(schedules.map(n=>n.dedupeKey)).size }
        await writeFile(path.join(out, `${String(cell.sequence).padStart(2,'0')}.notifications.json`), JSON.stringify(finalNotifications))
      }
      result.cells.push(cell)
      await writeFile(path.join(out, `${String(cell.sequence).padStart(2, '0')}-${scenario}-${concurrency}-${variant}.sample.json`), JSON.stringify(sample, null, 2))
      await writeFile(path.join(out, `${String(cell.sequence).padStart(2, '0')}-${scenario}-${concurrency}-${variant}.log`), api.output())
      await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
      console.log(JSON.stringify({ scenario, concurrency, variant, calls: warm.httpCalls, bytes: warm.responseUtf8Bytes, p95: warm.latencyMs.p95 }))
    } finally { for (const cleanup of after.reverse()) await cleanup() }
  }
}
result.finishedAt = new Date().toISOString()
await writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2))
