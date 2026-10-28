// 격리 계측 프로세스에만 --import로 주입한다. 운영 API에는 진단 경로를 만들지 않는다.
import fs from 'node:fs/promises'
import { registerHooks, syncBuiltinESMExports } from 'node:module'

if (process.send) {
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (!url.endsWith('/server/index.mjs')) return loaded
    let source = String(loaded.source)
    // listen 뒤 비동기 귀속 보정의 전체 문서 스캔이 cold/warm에 섞이지 않게 한다.
    // fixture에는 복구할 실제 대화가 없으며 양 버전에 같은 조건을 적용한다.
    for (const name of ['recoverLinkedConversationAttributions', 'reconcileAiDelegationWorkspaceLeasesAfterListen']) {
      const start = `async function ${name}() {`
      if (!source.includes(start)) throw new Error(`시작 작업 계측 지점을 찾지 못했습니다: ${name}`)
      source = source.replace(start, `${start}\n  return`)
    }
    const marker = 'async function resolveReferencesForMap(map) {'
    if (!source.includes(marker)) throw new Error('Ref 조회 계측 지점을 찾지 못했습니다.')
    return { ...loaded, source: source.replace(marker, `${marker}\n  globalThis.__mnpReadMetrics?.reference(map)`) }
  } })
  const stringify = JSON.stringify, parse = JSON.parse, clone = globalThis.structuredClone, read = fs.readFile
  const commentTexts = new Set()
  const interval = globalThis.setInterval
  // 양 버전 모두 동일한 background 비활성 조건. fixture의 실제 AI 실행을 금지한다.
  globalThis.setInterval = () => ({ unref() { return this }, ref() { return this } })
  let enabled = false, counts = {}, cpu = process.cpuUsage(), started = performance.now(), peak = 0
  const add = (name, value = 1) => { if (enabled) counts[name] = (counts[name] ?? 0) + value }
  const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : stringify(value) ?? '')
  const sample = () => { if (enabled) peak = Math.max(peak, process.memoryUsage().rss) }
  interval(sample, 10).unref()
  globalThis.__mnpReadMetrics = { reference(map) {
    const nodes = (map.nodes ?? []).filter((node) => node.data?.reference)
    add('refExpansionCalls'); add('refExpandedNodes', nodes.length); add('refInputBytes', bytes(map))
  } }
  fs.readFile = async (...args) => {
    const result = await read(...args)
    if (enabled) {
      const file = String(args[0]).replaceAll('\\', '/')
      const category = /\/_comments\/[^/]+\.json$/.test(file) ? 'commentRead' : /\/map-[^/]+\.json$/.test(file) ? 'documentRead' : null
      if (category) { add(`${category}Count`); add(`${category}Bytes`, typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength) }
      if (category === 'commentRead') {
        commentTexts.add(String(result))
        while (commentTexts.size > 32) commentTexts.delete(commentTexts.values().next().value)
      }
    }
    return result
  }
  JSON.parse = function (text, ...args) {
    const value = parse(text, ...args)
    if (enabled && commentTexts.has(String(text))) {
      add('commentParseCount'); add('commentParseBytes', Buffer.byteLength(text))
    }
    return value
  }
  globalThis.structuredClone = (value, ...args) => {
    if (enabled) {
      const nodes = value?.nodes ?? value?.map?.nodes
      if (nodes?.length >= 20) { add('fullDocumentCloneCount'); add('fullDocumentCloneBytes', bytes(value)) }
      add('cloneCount'); add('cloneBytes', bytes(value))
    }
    return clone(value, ...args)
  }
  process.on('message', (message) => {
    if (message?.action !== 'read-metrics') return
    sample()
    const usage = process.cpuUsage(cpu)
    const value = { counts, cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000,
      rssPeakBytes: peak, elapsedMs: performance.now() - started }
    if (message.reset) { counts = {}; cpu = process.cpuUsage(); started = performance.now(); peak = process.memoryUsage().rss; enabled = true }
    process.send({ id: message.id, phase: 'read-metrics', value })
  })
  syncBuiltinESMExports()
}
