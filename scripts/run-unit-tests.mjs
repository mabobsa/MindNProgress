import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = fileURLToPath(import.meta.url)

export const UNIT_TEST_CONCURRENCY_ENV = 'MNP_UNIT_TEST_CONCURRENCY'
export const DEFAULT_UNIT_TEST_CONCURRENCY = 4

export function resolveUnitTestConcurrency(environment = process.env) {
  const rawValue = environment[UNIT_TEST_CONCURRENCY_ENV]
  if (rawValue === undefined) return DEFAULT_UNIT_TEST_CONCURRENCY
  if (!/^[1-9]\d*$/.test(rawValue)) {
    throw new Error(`${UNIT_TEST_CONCURRENCY_ENV}는 1 이상의 정수여야 합니다. 입력값: ${JSON.stringify(rawValue)}`)
  }

  const concurrency = Number(rawValue)
  if (!Number.isSafeInteger(concurrency)) {
    throw new Error(`${UNIT_TEST_CONCURRENCY_ENV}는 안전한 정수 범위여야 합니다. 입력값: ${JSON.stringify(rawValue)}`)
  }
  return concurrency
}

export async function runUnitTests({
  environment = process.env,
  nodeExecutable = process.execPath,
  output = console,
  readDirectory = readdir,
  rootDirectory = projectDirectory,
  spawnProcess = spawn,
} = {}) {
  const concurrency = resolveUnitTestConcurrency(environment)
  const testsDirectory = path.join(rootDirectory, 'tests')
  const testFiles = (await readDirectory(testsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map((entry) => path.join(testsDirectory, entry.name))
    .sort()

  if (testFiles.length === 0) throw new Error('실행할 단위 테스트를 찾지 못했습니다.')

  const args = ['--test', `--test-concurrency=${concurrency}`, ...testFiles]
  output.log(`[unit runner] files=${testFiles.length}, concurrency=${concurrency}`)
  const child = spawnProcess(nodeExecutable, args, {
    cwd: rootDirectory,
    stdio: 'inherit',
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })
  return exitCode ?? 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = await runUnitTests()
  } catch (error) {
    console.error(`[unit runner] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
