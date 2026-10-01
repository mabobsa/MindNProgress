import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readdir } from 'node:fs/promises'
import test from 'node:test'
import { collectChildOutput } from '../scripts/collect-child-output.mjs'

function fixture() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const result = collectChildOutput(child)
  return { child, result }
}

test('로그 수집은 각 스트림의 한글·다중 바이트 모든 분할 경계를 보존한다', async () => {
  const text = '한글 지침 🙂 café 中文\n'
  const bytes = Buffer.from(text)
  for (const stream of ['stdout', 'stderr']) {
    for (let boundary = 0; boundary <= bytes.length; boundary += 1) {
      const { child, result } = fixture()
      child[stream].emit('data', bytes.subarray(0, boundary))
      child[stream].emit('data', bytes.subarray(boundary))
      child[stream].emit('end')
      child.emit('close', 0, null)
      const output = await result
      assert.equal(output[stream], text, `${stream} boundary=${boundary}`)
      assert.equal(output.text, text)
    }
  }
})

test('로그 수집은 양 스트림의 모든 분할 경계가 교차해도 디코더를 섞지 않는다', async () => {
  const stdout = Buffer.from('한글🙂\n'), stderr = Buffer.from('경고é中\n')
  for (let out = 0; out <= stdout.length; out += 1) {
    for (let err = 0; err <= stderr.length; err += 1) {
      const { child, result } = fixture()
      child.stdout.emit('data', stdout.subarray(0, out))
      child.stderr.emit('data', stderr.subarray(0, err))
      child.stdout.emit('data', stdout.subarray(out))
      child.stderr.emit('data', stderr.subarray(err))
      child.emit('close', 0, null)
      const output = await result
      assert.equal(output.stdout, stdout.toString())
      assert.equal(output.stderr, stderr.toString())
      assert.ok(!output.text.includes('�'))
    }
  }
  // 한 바이트 청크를 번갈아 전달해 한 문자에 여러 경계가 생기는 경우도 검증한다.
  const { child, result } = fixture()
  for (let index = 0; index < Math.max(stdout.length, stderr.length); index += 1) {
    if (index < stdout.length) child.stdout.emit('data', stdout.subarray(index, index + 1))
    if (index < stderr.length) child.stderr.emit('data', stderr.subarray(index, index + 1))
  }
  child.emit('close', 0, null)
  const output = await result
  assert.equal(output.stdout, stdout.toString())
  assert.equal(output.stderr, stderr.toString())
  assert.ok(!output.text.includes('�'))
})

test('로그 수집은 exit 이후 출력과 양 스트림의 end를 close까지 기다린다', async () => {
  const { child, result } = fixture()
  let resolved = false
  void result.then(() => { resolved = true })
  child.stdout.emit('data', Buffer.from('한').subarray(0, 1))
  child.emit('exit', 7, null)
  await Promise.resolve()
  assert.equal(resolved, false)
  child.stderr.emit('data', Buffer.from('경고\n'))
  child.stderr.emit('end')
  child.stdout.emit('data', Buffer.from('한').subarray(1))
  child.stdout.emit('data', Buffer.from('글 지침\n'))
  child.stdout.emit('end')
  await Promise.resolve()
  assert.equal(resolved, false)
  child.emit('close', 7, null)
  const output = await result
  assert.equal(output.stdout, '한글 지침\n')
  assert.equal(output.stderr, '경고\n')
  assert.equal(output.text, '경고\n한글 지침\n')
  assert.equal(output.exitCode, 7)
  assert.equal(output.signal, null)
})

test('로그 수집은 종료 시 잔여 바이트를 한 번만 flush하고 빈 출력·signal을 보존한다', async () => {
  const { child, result } = fixture()
  // 잘못 끝난 UTF-8 입력도 조용히 버리지 않고 StringDecoder의 치환 결과를 남긴다.
  child.stdout.emit('data', Buffer.from('한').subarray(0, 1))
  child.stderr.emit('data', Buffer.from('🙂').subarray(0, 2))
  child.stdout.emit('end')
  child.emit('close', null, 'SIGTERM')
  const output = await result
  assert.equal(output.stdout, '�')
  assert.equal(output.stderr, '�')
  assert.equal(output.text, '��')
  assert.equal(output.signal, 'SIGTERM')
  const empty = fixture()
  empty.child.emit('close', 0, null)
  assert.deepEqual(await empty.result, { text: '', stdout: '', stderr: '', exitCode: 0, signal: null })
})

test('로그 수집은 실제 자식 프로세스의 종료 직전 양 pipe 출력을 모두 수집한다', async () => {
  const text = '한글 지침🙂\n'.repeat(20000)
  const child = spawn(process.execPath, ['-e', "const text = '한글 지침🙂\\n'.repeat(20000); process.stdout.write(text); process.stderr.write(text); process.exitCode = 0"], { stdio: ['ignore', 'pipe', 'pipe'] })
  const output = await collectChildOutput(child)
  assert.equal(output.exitCode, 0)
  assert.equal(output.stdout, text)
  assert.equal(output.stderr, text)
  assert.equal(output.text.length, text.length * 2)
  assert.ok(!output.text.includes('�'))
})

test('로그 수집은 spawn 오류를 성공 종료로 보고하지 않는다', async () => {
  const { child, result } = fixture()
  const error = new Error('의도된 spawn 오류')
  child.emit('error', error)
  child.emit('close', -2, null)
  await assert.rejects(result, (caught) => caught === error)
})

test('검증 runner import는 검사 실행이나 로그 저장 부작용이 없다', async () => {
  const logs = new URL('../docs/ai-guidance-rollback-2026-10-01/supplement-logs/', import.meta.url)
  const before = await readdir(logs).catch((error) => { if (error.code === 'ENOENT') return []; throw error })
  await import('../scripts/verify-guidance-rollback.mjs')
  assert.deepEqual(await readdir(logs).catch((error) => { if (error.code === 'ENOENT') return []; throw error }), before)
})
