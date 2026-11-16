import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createDoorayTransport } from '../server/lib/doorayTransport.mjs'
import { fetchDoorayTaskPreview } from '../server/lib/doorayTasks.mjs'
import { createDoorayRequester } from '../server/lib/doorayMentions.mjs'

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('설정 파일이 없으면 원래 fetch를 쓰고, 설정한 외부 모듈은 요청마다 반영되며 파일을 지우면 재시작 없이 되돌아간다', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dooray-transport-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settingsFile = path.join(directory, '_dooray-transport.json')
  const moduleFile = path.join(directory, 'external.mjs')
  await writeFile(moduleFile, `export async function fetch(input, init, { fallbackFetch }) {
    if (String(input).includes('/fallback')) return fallbackFetch(input, init)
    return new Response(JSON.stringify({ via: 'external', input: String(input), auth: init?.headers?.Authorization ?? null }), { status: 200 })
  }`)
  const original = []
  const fetchImpl = async (input) => { original.push(String(input)); return jsonResponse({ via: 'original' }) }
  const warnings = []
  const transport = createDoorayTransport({ settingsFile, fetchImpl, warn: (message) => warnings.push(message) })

  assert.deepEqual(await (await transport('https://api.dooray.example/a')).json(), { via: 'original' })
  await writeFile(settingsFile, JSON.stringify({ module: moduleFile }))
  const routed = await (await transport('https://api.dooray.example/b', { headers: { Authorization: 'dooray-api key' } })).json()
  assert.deepEqual(routed, { via: 'external', input: 'https://api.dooray.example/b', auth: 'dooray-api key' })
  assert.deepEqual(await (await transport('https://api.dooray.example/fallback')).json(), { via: 'original' }, '외부 모듈은 원래 fetch로 넘길 수 있다')
  await rm(settingsFile)
  assert.deepEqual(await (await transport('https://api.dooray.example/c')).json(), { via: 'original' }, '설정을 지우면 바로 원래 연결')
  assert.deepEqual(original, ['https://api.dooray.example/a', 'https://api.dooray.example/fallback', 'https://api.dooray.example/c'])
  assert.deepEqual(warnings, [])
})

test('잘못된 설정·모듈은 경고 한 번과 함께 원래 fetch로 처리하고 요청을 실패시키지 않는다', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mnp-dooray-transport-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settingsFile = path.join(directory, '_dooray-transport.json')
  const warnings = []
  const transport = createDoorayTransport({ settingsFile, fetchImpl: async () => jsonResponse({ via: 'original' }), warn: (message) => warnings.push(message) })
  const cases = [
    ['{ 깨진 JSON', /설정 파일을 읽지 못해/],
    [JSON.stringify({ module: 'relative/module.mjs' }), /절대 경로/],
    [JSON.stringify({ module: path.join(directory, 'missing.mjs') }), /외부 모듈을 불러오지 못해/],
  ]
  for (const [settings, warning] of cases) {
    await writeFile(settingsFile, settings)
    assert.deepEqual(await (await transport('https://api.dooray.example/x')).json(), { via: 'original' })
    assert.match(warnings.at(-1), warning)
    const count = warnings.length
    await transport('https://api.dooray.example/y')
    assert.equal(warnings.length, count, '같은 경고는 반복하지 않는다')
  }
  await writeFile(path.join(directory, 'no-fetch.mjs'), 'export const other = 1')
  await writeFile(settingsFile, JSON.stringify({ module: path.join(directory, 'no-fetch.mjs') }))
  assert.deepEqual(await (await transport('https://api.dooray.example/z')).json(), { via: 'original' })
  assert.match(warnings.at(-1), /fetch 함수를 내보내지 않습니다/)
  await writeFile(settingsFile, JSON.stringify({ module: '' }))
  assert.deepEqual(await (await transport('https://api.dooray.example/empty')).json(), { via: 'original' }, 'module이 비면 연결 지점을 쓰지 않는다')
})

test('Dooray 조회 함수는 fetchImpl을 주지 않으면 설정의 연결 함수를 쓴다', async () => {
  const calls = []
  const config = { apiKey: 'key', baseUrl: 'https://api.dooray.example', fetch: async (input, init) => {
    calls.push({ input: String(input), auth: init.headers.Authorization })
    return jsonResponse({ header: { isSuccessful: true }, result: { subject: '연결 함수로 받은 업무', project: { id: '1' }, taskNumber: 'P/1' } })
  } }
  const preview = await fetchDoorayTaskPreview('https://nhnent.dooray.com/task/1/2', config)
  assert.equal(preview.subject, '연결 함수로 받은 업무')
  assert.deepEqual(calls, [{ input: 'https://api.dooray.example/project/v1/posts/2', auth: 'dooray-api key' }])
  const { request } = createDoorayRequester(config, { acquire: async () => {} })
  assert.equal((await request('/common/v1/members/me')).result.subject, '연결 함수로 받은 업무')
  assert.equal(calls.length, 2)
  // 명시한 fetchImpl은 설정보다 우선한다(기존 시험·호출과 같다).
  const explicit = await fetchDoorayTaskPreview('https://nhnent.dooray.com/task/1/2', config,
    { fetchImpl: async () => jsonResponse({ result: { subject: '명시 fetch', project: { id: '1' } } }) })
  assert.equal(explicit.subject, '명시 fetch')
})
