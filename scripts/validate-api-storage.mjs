import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

// 승인된 격리 소스에서만 시험한다. 결과 디렉터리는 기존 원본을 덮지 않는다.
const [rootArg, outputArg, ...files] = process.argv.slice(2)
if (!rootArg || !outputArg || !files.length) throw Error('격리 소스·새 출력 디렉터리·시험 파일을 지정하세요.')
const root = path.resolve(rootArg), out = path.resolve(outputArg)
if (root === process.cwd() || !root.includes(`${path.sep}.tmp${path.sep}`)) throw Error('격리 소스 경로가 필요합니다.')
await mkdir(out, { recursive: false })
const command = [process.execPath, '--test', '--test-reporter=tap', '--test-concurrency=1', ...(process.env.MNP_TEST_NAME_PATTERN ? ['--test-name-pattern', process.env.MNP_TEST_NAME_PATTERN] : []), ...files]
const startedAt = new Date().toISOString()
const child = spawn(command[0], command.slice(1), { cwd: root, windowsHide: true,
  env: { ...process.env, MNP_STORAGE_TEST_SOURCE_ROOT: process.env.MNP_STORAGE_TEST_TARGET_ROOT ?? root }, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; process.stdout.write(chunk) })
const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })) })
await writeFile(path.join(out, 'tests.log'), output)
const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])))
const summary = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)/gm)].map((m) => [m[1], Number(m[2])]))
await writeFile(path.join(out, 'result.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), root, command,
  environment: { node: process.version, executable: process.execPath, platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model, cores: os.cpus().length },
  exit, summary, sources, log: { path: path.join(out, 'tests.log'), sha256: createHash('sha256').update(output).digest('hex'), bytes: Buffer.byteLength(output) } }, null, 2))
process.exitCode = exit.code ?? 1
