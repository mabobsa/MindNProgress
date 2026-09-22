import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  DEFAULT_UNIT_TEST_CONCURRENCY,
  UNIT_TEST_CONCURRENCY_ENV,
  runUnitTests,
} from '../scripts/run-unit-tests.mjs'

const execFileAsync = promisify(execFile)
const projectDirectory = path.resolve(import.meta.dirname, '..')
const runnerPath = path.join(projectDirectory, 'scripts', 'run-unit-tests.mjs')

function entry(name, isFile = true) {
  return { name, isFile: () => isFile }
}

function exitingChild(exitCode) {
  const child = new EventEmitter()
  queueMicrotask(() => child.emit('exit', exitCode))
  return child
}

test('unit runner는 보수적 기본 동시성과 정렬된 파일을 Node 호출 인자로 전달한다', async () => {
  const rootDirectory = path.join(projectDirectory, 'runner-contract-fixture')
  const calls = []
  const logs = []

  const exitCode = await runUnitTests({
    environment: {},
    output: { log: (message) => logs.push(message) },
    readDirectory: async (directory, options) => {
      assert.equal(directory, path.join(rootDirectory, 'tests'))
      assert.deepEqual(options, { withFileTypes: true })
      return [entry('zeta.test.mjs'), entry('notes.md'), entry('nested.test.mjs', false), entry('alpha.test.mjs')]
    },
    rootDirectory,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options })
      return exitingChild(0)
    },
  })

  assert.equal(DEFAULT_UNIT_TEST_CONCURRENCY, 4)
  assert.equal(exitCode, 0)
  assert.deepEqual(calls, [{
    command: process.execPath,
    args: [
      '--test',
      '--test-concurrency=4',
      path.join(rootDirectory, 'tests', 'alpha.test.mjs'),
      path.join(rootDirectory, 'tests', 'zeta.test.mjs'),
    ],
    options: { cwd: rootDirectory, stdio: 'inherit' },
  }])
  assert.deepEqual(logs, ['[unit runner] files=2, concurrency=4'])
})

test('unit runner는 명시적 동시성 override와 자식 종료 코드를 보존한다', async () => {
  let receivedArgs
  const exitCode = await runUnitTests({
    environment: { [UNIT_TEST_CONCURRENCY_ENV]: '2' },
    output: { log: () => {} },
    readDirectory: async () => [entry('only.test.mjs')],
    spawnProcess: (_command, args) => {
      receivedArgs = args
      return exitingChild(7)
    },
  })

  assert.equal(receivedArgs[1], '--test-concurrency=2')
  assert.equal(exitCode, 7)
})

test('unit runner는 잘못된 동시성 값을 테스트 실행 전에 거부한다', async () => {
  const invalidOverrides = [
    { value: '', message: /1 이상의 정수/ },
    { value: '0', message: /1 이상의 정수/ },
    { value: '-1', message: /1 이상의 정수/ },
    { value: '1.5', message: /1 이상의 정수/ },
    { value: 'four', message: /1 이상의 정수/ },
    { value: ' 4 ', message: /1 이상의 정수/ },
    { value: '9007199254740992', message: /안전한 정수 범위/ },
  ]

  for (const { value, message } of invalidOverrides) {
    let readAttempted = false
    let spawnAttempted = false
    await assert.rejects(
      runUnitTests({
        environment: { [UNIT_TEST_CONCURRENCY_ENV]: value },
        output: { log: () => {} },
        readDirectory: async () => {
          readAttempted = true
          return [entry('only.test.mjs')]
        },
        spawnProcess: () => {
          spawnAttempted = true
          return exitingChild(0)
        },
      }),
      message,
    )
    assert.equal(readAttempted, false)
    assert.equal(spawnAttempted, false)
  }
})

test('unit runner CLI는 잘못된 override를 명확한 오류와 실패 코드로 반환한다', async () => {
  const invalidOverrides = [
    { value: 'invalid', message: /1 이상의 정수/ },
    { value: '9007199254740992', message: /안전한 정수 범위/ },
  ]

  for (const { value, message } of invalidOverrides) {
    await assert.rejects(
      execFileAsync(process.execPath, [runnerPath], {
        cwd: projectDirectory,
        env: { ...process.env, [UNIT_TEST_CONCURRENCY_ENV]: value },
        windowsHide: true,
      }),
      (error) => {
        assert.equal(error.code, 1)
        assert.match(error.stderr, message)
        assert.match(error.stderr, new RegExp(value))
        return true
      },
    )
  }
})
