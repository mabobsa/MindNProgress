import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// 실제 MnP 서버·데이터에 접근하지 않고 지식 정리 팝업 컴포넌트만 고정 응답으로 실행한다.
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '/src/index.css';
import { SharedKnowledgeReviewDialog } from '/src/components/SharedKnowledgeReviewDialog.tsx';
import '/src/dark.css';
const root = createRoot(document.getElementById('root'));
const originalFetch = window.fetch.bind(window);
const reviewer = { id: 'editor', name: '검토자' };
const card = (overrides) => ({
  mapId: 'map-a', documentTitle: '통합 관리', documentVersion: 7, cardId: 'card', label: '카드', kind: 'branch',
  reviewLevel: 'priority', lengthLevel: 'priority', reasons: ['length-priority'], length: 12000, utf8Bytes: 36000, sha256: 'a'.repeat(64),
  reviewState: 'current', consumerCount: 0, exactDuplicateStatementGroupCount: 0, exactDuplicateStatementCount: 0,
  limitUsagePercent: 80, remainingCharacters: 3000, lastKnownUpdatedAt: '2026-11-23T01:00:00.000Z', lastKnownUpdatedAtSource: 'sharedKnowledge',
  isReference: false, actionable: false, needsReview: false, review: null, ...overrides,
});
const pending = card({ cardId: 'pending', label: '검토 대기 카드', length: 12551, reviewState: 'unreviewed', actionable: true, needsReview: true });
const cleanedLong = card({ mapId: 'map-b', documentTitle: '게임룸 통합 관리', cardId: 'cleaned-long', label: '기획·서버·아트 확인 목록', length: 14795, limitUsagePercent: 99, consumerCount: 3,
  review: { reviewedAt: '2026-11-23T02:00:00.000Z', reviewedBy: reviewer, reviewResult: 'cleaned' } });
const acceptedLong = card({ cardId: 'accepted-long', label: '장문 유지 카드', length: 8100, reviewLevel: 'recommended', lengthLevel: 'recommended', reasons: ['length-recommended'], limitUsagePercent: 54,
  lastKnownUpdatedAtSource: 'document', review: { reviewedAt: '2026-11-20T02:00:00.000Z', reviewedBy: reviewer, reviewResult: 'accepted-long' } });
const context = {
  document: { id: 'map-a', title: '통합 관리', version: 7, updatedAt: '2026-11-23T01:00:00.000Z' },
  card: { id: 'pending', label: '검토 대기 카드', kind: 'branch', description: '', sharedKnowledge: '원문 공유 지식', sharedKnowledgeUpdatedAt: null, sharedKnowledgeUpdatedBy: null,
    textIntegrity: { length: 7, utf8Bytes: 19, sha256: 'b'.repeat(64) }, reviewState: 'unreviewed' },
  candidate: { reviewLevel: 'priority', reasons: ['length-priority'], paragraphCount: 1, nonEmptyLineCount: 1, listItemCount: 0, exactDuplicateStatementGroupCount: 0,
    exactDuplicateStatementCount: 0, limitUsagePercent: 80, remainingCharacters: 3000 },
  relations: { parents: [], children: [], knowledgeSources: [], knowledgeConsumers: [], totals: { parents: 0, children: 0, knowledgeSources: 0, knowledgeConsumers: 0 }, truncatedTypes: [] },
  guidance: { keep: '유지 기준', remove: '제외 기준', preserveMeaning: '보호 기준', resultChoice: '결과 선택' },
  accessUrl: '/mindmap/map-a/pending', comments: [], commentsPage: { total: 0, returned: 0 },
};
window.audit = { calls: [] };
window.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('/api/')) return originalFetch(url, init);
  window.audit.calls.push(String(url));
  if (String(url).startsWith('/api/shared-knowledge/audit')) {
    const reviewedLongCards = window.audit.reviewedLongCards;
    const body = { audit: { generatedAt: '2026-11-23T03:00:00.000Z', candidates: [pending],
      summary: { documentCount: 2, cardsWithSharedKnowledge: 3, actionableCandidateCount: 1, totalCharacters: 35446,
        ...(reviewedLongCards ? { reviewedLongCount: reviewedLongCards.length } : {}) },
      ...(reviewedLongCards ? { reviewedLongCards } : {}) } };
    return new Response(JSON.stringify(body), { status: 200 });
  }
  if (String(url).includes('/shared-knowledge-review-context')) return new Response(JSON.stringify({ context }), { status: 200 });
  return new Response(JSON.stringify({ error: '고정 응답 없음' }), { status: 404 });
};
let sequence = 0;
window.renderDialog = (reviewedLongCards) => {
  window.audit = { calls: [], reviewedLongCards };
  flushSync(() => root.render(React.createElement(SharedKnowledgeReviewDialog, {
    key: ++sequence, activeMapId: null, clientId: 'fixture', onApplied: () => {}, onClose: () => {},
  })));
};
window.fixtureCards = { cleanedLong, acceptedLong };
window.fixtureReady = true;
`

test('검토 대기와 검토 완료 장문을 전환하고 검토 완료 장문은 읽기 전용으로 보여준다', { skip: process.env.MNP_BROWSER_TEST !== '1', timeout: 120_000 }, async (t) => {
  const { createServer } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-shared-knowledge-browser-'))
  const server = await createServer({ configFile: false, root: path.resolve(import.meta.dirname, '..'), cacheDir: path.join(directory, 'vite-cache'), logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, plugins: [react(), {
      name: 'shared-knowledge-fixture', resolveId: (id) => id === '/shared-knowledge-fixture.js' ? '\0shared-knowledge-fixture' : null,
      load: (id) => id === '\0shared-knowledge-fixture' ? fixture : null,
      configureServer(vite) { vite.middlewares.use('/shared-knowledge-check', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await vite.transformIndexHtml('/shared-knowledge-check', '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module" src="/shared-knowledge-fixture.js"></script></body></html>'))
      }) },
    }],
  })
  let browser, socket, send
  const pending = new Map()
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (fn) => {
    let lastError
    for (let i = 0; i < 100; i++) { try { const value = await fn(); if (value) return value } catch (error) { lastError = error }; await delay(100) }
    throw lastError ?? Error('화면 검증 대기 시간 초과')
  }
  try {
    await server.listen()
    browser = spawn(process.env.MNP_TEST_BROWSER_EXE ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, '--window-size=1440,1000', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true })
    let spawnError
    browser.on('error', (error) => { spawnError = error })
    const port = await waitFor(async () => { if (spawnError) throw spawnError; return (await readFile(path.join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0] })
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let sequence = 0
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data), item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id); clearTimeout(item.timer)
      if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result)
    }
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method)) }, 10000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/shared-knowledge-check` })
    await waitFor(() => evaluate('window.fixtureReady'))

    const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`)
    const clickMode = (label) => evaluate(`[...document.querySelectorAll('.shared-knowledge-review-mode button')].find((button) => button.textContent === ${JSON.stringify(label)}).click()`)
    const listItems = () => evaluate('[...document.querySelectorAll(".shared-knowledge-review-list > button")].map((item) => ({ text: item.textContent, reviewed: item.classList.contains("reviewed"), selected: item.classList.contains("selected") }))')

    await evaluate('window.renderDialog([window.fixtureCards.cleanedLong, window.fixtureCards.acceptedLong])')
    await waitFor(async () => (await evaluate('document.querySelector(".shared-knowledge-review-compare textarea")?.value')) === '원문 공유 지식')

    // 기본은 검토 대기 목록이다.
    assert.equal(await text('.shared-knowledge-review-summary span'), '검토 대기')
    assert.equal(await text('.shared-knowledge-review-summary strong'), '1')
    assert.deepEqual((await listItems()).map((item) => item.reviewed), [false])
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".shared-knowledge-review-mode button")].map((button) => [button.textContent, button.getAttribute("aria-pressed")])'),
      [['검토 대기', 'true'], ['검토 완료 장문', 'false']])

    // 작성 중인 정리안은 목록을 전환해도 유지되어야 한다.
    await evaluate(`(() => { const area = document.querySelector('textarea[aria-label="공유 지식 정리안"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(area, '작성 중인 정리안'); area.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await waitFor(async () => (await evaluate('document.querySelector(\'textarea[aria-label="공유 지식 정리안"]\').value')) === '작성 중인 정리안')

    await clickMode('검토 완료 장문')
    await waitFor(async () => (await text('.shared-knowledge-review-summary span')) === '검토 완료 장문')
    assert.equal(await text('.shared-knowledge-review-summary strong'), '2')
    assert.equal(await evaluate('document.querySelector(".shared-knowledge-review-list").getAttribute("aria-label")'), '검토 완료 장문')
    const reviewedItems = await listItems()
    assert.equal(reviewedItems.length, 2)
    assert.ok(reviewedItems.every((item) => item.reviewed))
    assert.match(reviewedItems[0].text, /^정리 완료14,795자기획·서버·아트 확인 목록게임룸 통합 관리12,000자 이상 · 검토 /)
    assert.match(reviewedItems[1].text, /^장문 유지8,100자장문 유지 카드통합 관리8,000자 이상 · 검토 /)
    assert.equal(reviewedItems[0].selected, true, '첫 카드를 기본 선택한다')
    // 검토 대기 화면(정리안·승인 버튼)은 보이지 않고 읽기 전용 상세만 보인다.
    assert.equal(await evaluate('Boolean(document.querySelector(".shared-knowledge-review-compare, .shared-knowledge-review-actions"))'), false)
    assert.equal(await text('.shared-knowledge-review-card-header strong'), '기획·서버·아트 확인 목록')
    assert.equal(await evaluate('document.querySelector(".shared-knowledge-review-card-actions a").getAttribute("href")'), '/mindmap/map-b/cleaned-long')
    assert.equal(await evaluate('document.querySelector(".shared-knowledge-review-card-actions a").target'), '_blank')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".shared-knowledge-review-stats span")].map((item) => item.textContent)'),
      ['길이14,795자', '제한 사용99%', '검토 결과정리 완료', '검토자검토자', '지식 소비 카드3'])
    assert.match(await text('.shared-knowledge-review-card-header small'), /^공유 지식 수정 /)
    assert.match(await text('.shared-knowledge-review-reviewed-note'), /정리 완료로 검토를 마쳤고, 그 뒤 본문이 바뀌지 않아 정리 후보에서 제외되었습니다\.\s*본문이 바뀌면 다시 검토 대기로 돌아갑니다\./)

    await evaluate('document.querySelectorAll(".shared-knowledge-review-list > button")[1].click()')
    await waitFor(async () => (await text('.shared-knowledge-review-card-header strong')) === '장문 유지 카드')
    assert.match(await text('.shared-knowledge-review-card-header small'), /^문서 수정 /)
    assert.match(await text('.shared-knowledge-review-reviewed-note'), /장문 유지로 검토를 마쳤고/)
    assert.equal(await evaluate('window.audit.calls.filter((url) => url.includes("/shared-knowledge-review-context") && !url.includes("/cards/pending/")).length'), 0, '검토 완료 장문은 검토 문맥을 요청하지 않는다')

    if (process.env.MNP_TEST_SCREENSHOTS === '1') {
      const artifacts = await mkdtemp(path.join(tmpdir(), 'mnp-shared-knowledge-screenshots-'))
      for (const theme of ['light', 'dark']) {
        await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.colorScheme=${JSON.stringify(theme)}`)
        const shot = await send('Page.captureScreenshot', { format: 'png' })
        await writeFile(path.join(artifacts, `${theme}-reviewed.png`), Buffer.from(shot.data, 'base64'))
      }
      await evaluate('document.documentElement.dataset.theme="light";document.documentElement.style.colorScheme="light"')
      t.diagnostic(`검토 완료 장문 화면 캡처: ${artifacts}`)
    }

    await clickMode('검토 대기')
    await waitFor(async () => (await text('.shared-knowledge-review-summary span')) === '검토 대기')
    assert.equal(await evaluate('document.querySelector(\'textarea[aria-label="공유 지식 정리안"]\').value'), '작성 중인 정리안', '전환 전 정리안을 유지한다')
    assert.equal(await evaluate('Boolean(document.querySelector(".shared-knowledge-review-reviewed-note"))'), false)

    // 검토 완료 장문이 없거나, 목록을 주지 않는 이전 서버 응답이면 빈 상태를 보여준다.
    for (const reviewedLongCards of [[], undefined]) {
      await evaluate(`window.renderDialog(${JSON.stringify(reviewedLongCards) ?? 'undefined'})`)
      await waitFor(() => evaluate('Boolean(document.querySelector(".shared-knowledge-review-candidate"))'))
      await clickMode('검토 완료 장문')
      await waitFor(async () => (await text('.shared-knowledge-review-summary span')) === '검토 완료 장문')
      assert.equal(await text('.shared-knowledge-review-summary strong'), '0')
      assert.equal(await evaluate('document.querySelectorAll(".shared-knowledge-review-list > button").length'), 0)
      assert.match(await text('.shared-knowledge-review-list .shared-knowledge-review-empty'), /검토 완료 장문이 없습니다\.검토를 마쳤고 본문이 그대로인 5,000자 이상 공유 지식이 여기에 표시됩니다\./)
    }
  } finally {
    if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
    for (const item of pending.values()) clearTimeout(item.timer)
    socket?.close()
    if (browser?.pid && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited }
    await server.close()
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()), '테스트 임시 경로의 상위 폴더 확인')
    assert.ok(path.basename(directory).startsWith('mnp-shared-knowledge-browser-'), '테스트 전용 임시 폴더 확인')
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  }
})
