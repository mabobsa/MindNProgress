import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { collectChildOutput } from './collect-child-output.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logs = path.join(root, 'docs/ai-guidance-rollback-2026-10-01/supplement-logs')
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
async function main() {
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  await mkdir(logs, { recursive: true })
  const commands = [
    ['supplement', process.execPath, ['--test', 'tests/collect-child-output.test.mjs', 'tests/initial-guidance-restoration.test.mjs']],
    ['related', process.execPath, ['--test', 'tests/initial-guidance-restoration.test.mjs', 'tests/ai-context-instructions.test.mjs', 'tests/ai-approval-instructions.test.mjs', 'tests/ai-conversation-launch.test.mjs', 'tests/group-document-instructions.test.mjs', 'tests/group-project-coordinator-guard.test.mjs', 'tests/ai-instruction-snapshots.test.mjs', 'tests/mcp-instruction-surface.test.mjs', 'tests/ai-conversation-context-health.test.mjs', 'tests/ai-delegations.test.mjs', 'tests/group-project-api.test.mjs', 'tests/dooray-responses.test.mjs']],
    ...['test:mcp', 'test:unit', 'lint', 'build'].map((name) => [name.replace(':', '-'), process.execPath, [npmCli, 'run', name]]),
    ['git-diff-check', 'git', ['diff', '--check']],
  ]
  const results = []
  for (const [name, command, args] of commands) {
    const startedAt = new Date().toISOString()
    process.stdout.write(`START ${name} ${startedAt}\n`)
    const child = spawn(command, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const { text, exitCode, signal } = await collectChildOutput(child)
    const file = `${runId}-${name}.log`
    await writeFile(path.join(logs, file), text, { flag: 'wx' })
    const phases = []
    let phase = null
    for (const line of text.split(/\r?\n/)) {
      const marker = line.match(/\[unit runner\] phase=(\d+)\/(\d+), files=(\d+), concurrency=(\d+)/)
      if (marker) { phase = { phase: Number(marker[1]), files: Number(marker[3]), concurrency: Number(marker[4]) }; phases.push(phase) }
      const count = line.match(/^(?:#|ℹ) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/)
      if (count) {
        if (!phase) { phase = {}; phases.push(phase) }
        phase[count[1]] = Number(count[2])
      }
    }
    const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [key, phases.reduce((sum, item) => sum + (item[key] ?? 0), 0)]))
    const result = { name, command: [command, ...args], startedAt, finishedAt: new Date().toISOString(), exitCode, signal, file, sha256: createHash('sha256').update(text).digest('hex'), phases, totals }
    results.push(result)
    await writeFile(path.join(logs, `${runId}-results.json`), `${JSON.stringify({ runId, validationHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), results }, null, 2)}\n`)
    process.stdout.write(`END ${name} exit=${exitCode} ${JSON.stringify(totals)}\n`)
  }
  process.exitCode = results.some((result) => result.exitCode !== 0) ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
