import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { digest } from './capture-guidance-evidence.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'docs/ai-guidance-rollback-2026-10-01')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const baseline = '11a5079d62a9493e55548fe5b1ccbe0ffa3eb94c'
const initialHead = 'eaa7eeda712c76e59c19ed771cbba077b72ada1e'
const preservedMainHead = git('rev-parse', 'main').trim()
const candidateHead = git('rev-parse', 'HEAD').trim()
const evidence = JSON.parse(await readFile(path.join(output, 'initial-response-evidence.json'), 'utf8'))
const baselineSessions = evidence.runs.find((run) => run.name === 'baseline').sessions
const candidateSessions = evidence.runs.find((run) => run.name === 'candidate').sessions
const initialResponsePathChecks = candidateSessions.map((session, index) => {
  const original = JSON.parse(baselineSessions[index].response.text)
  const current = JSON.parse(session.response.text)
  assert.equal(session.guide.text, baselineSessions[index].guide.text)
  if (!current.selection) return { name: session.name, fullGuide: true }
  assert.deepEqual(current.selection.taskLinks.startupInspection, original.selection.taskLinks.startupInspection)
  assert.equal(current.nextStep, original.nextStep)
  assert.equal(current.groupProject.instruction, original.groupProject.instruction)
  assert.deepEqual(current.selection.aiWorkCoordination.childDelegation, original.selection.aiWorkCoordination.childDelegation)
  return { name: session.name, fullGuide: true, startupInspection: true, nextStep: true, groupInstruction: true, childDelegation: true }
})
assert.equal(git('diff', evidence.runs.find((run) => run.name === 'candidate').head, candidateHead, '--', 'mcp', 'server', 'src'), '')
const originalBeforeSha256 = digest(await readFile(path.join(output, 'before-surface-and-prompts.json'), 'utf8'))
assert.equal(originalBeforeSha256, evidence.originalBeforeSha256)
const commits = git('log', '--reverse', '--format=%H%x09%s', `${baseline}..${preservedMainHead}`).trim().split('\n').map((line) => {
  const [hash, subject] = line.split('\t')
  return { hash, subject, changes: git('diff-tree', '--no-commit-id', '--name-status', '-r', hash).trim().split('\n').filter(Boolean).map((entry) => { const [status, file] = entry.split('\t'); return { status, file } }) }
})
const merge = '378dc5eaa100c84435c316009545280f1e633f72'
const mainChange = 'c541fd7c85cc29caef0619d713945fd6018cafc8'
const changedLines = (patch) => patch.split('\n').filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+)/.test(line)).join('\n')
const mainFiles = git('diff-tree', '--no-commit-id', '--name-only', '-r', mainChange).trim().split('\n')
const mainPreservation = mainFiles.map((file) => {
  const sourcePatch = git('diff', `${mainChange}^`, mainChange, '--', file)
  const mergePatch = git('diff', `${merge}^1`, merge, '--', file)
  const exactChangeLinesPreserved = changedLines(sourcePatch) === changedLines(mergePatch)
  assert.ok(exactChangeLinesPreserved, `${file}의 main 변경 단위가 다릅니다.`)
  return { file, classification: 'P', exactChangeLinesPreserved, sourcePatch, mergePatch }
})
execFileSync('git', ['merge-base', '--is-ancestor', mainChange, candidateHead], { cwd: root })
execFileSync('git', ['merge-base', '--is-ancestor', preservedMainHead, candidateHead], { cwd: root })
const pureGuidanceRestoration = ['src/utils/aiContextInstructions.mjs', 'src/utils/aiApprovalInstructions.mjs', 'src/utils/aiConversationLaunch.mjs', 'src/utils/aiConversationLaunch.d.mts'].map((file) => {
  const original = git('show', `${baseline}:${file}`), current = git('show', `${candidateHead}:${file}`)
  assert.equal(current, original)
  return { file, classification: 'R', fullBaselineMatch: true, sha256: digest(current) }
})
const mcpFile = 'scripts/test-mcp.mjs'
const currentMcp = git('show', `${candidateHead}:${mcpFile}`)
function block(ref, first, last) {
  const source = git('show', `${ref}:${mcpFile}`)
  const start = source.indexOf(first), end = source.indexOf(last, start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end)
}
function relevantHunks(commit, token) {
  const patch = git('show', '--format=', commit, '--', mcpFile)
  return patch.split(/(?=^@@ )/m).slice(1).filter((hunk) => hunk.includes(token)).join('')
}
const rb07 = [
  { id: 'latest-updatedAt', sourceCommit: '7aae8f066d3b74f4b01871ada98df7a0ec83a07a', first: '    const recoveredList =', last: '\n    const coordinations =', token: 'recoveredList' },
  { id: 'partial-waiting', sourceCommit: '60f4e51', first: '    const partiallyReleasedCard =', last: '    assert.equal(waitingCardResult.document.rootProgress', token: 'partiallyReleasedCard' },
].map(({ id, sourceCommit, first, last, token }) => {
  // 최신 updatedAt 블록의 끝은 버전마다 달라질 수 있어 동일 API 흐름 마지막 assertion으로 고정한다.
  if (id === 'latest-updatedAt') last = '\n\n'
  const original = block(sourceCommit, first, last)
  const initial = block(initialHead, first, last)
  const final = block(candidateHead, first, last)
  assert.ok(currentMcp.includes(final))
  return { id, sourceCommit: git('rev-parse', sourceCommit).trim(), file: mcpFile,
    sourceUnit: original, originalPatchHunks: relevantHunks(sourceCommit, token),
    initialUnit: initial, finalUnit: final,
    initialUnitSha256: digest(initial), finalUnitSha256: digest(final),
    initialUnitUnchanged: initial === final,
    currentFollowupNoOp: final === block('08b22533', first, last),
    additionalAssertionCommit: id === 'latest-updatedAt' ? '08b22533640e13e1bd2f461c253f238c3723f9d9' : null,
    additionalAssertionPatch: id === 'latest-updatedAt' ? relevantHunks('08b22533', 'recoveredCurrent') : '',
    dependency: id === 'latest-updatedAt' ? '복구 후 목록의 최신 updatedAt을 후속 변경의 expectedUpdatedAt에 전달하는 계약' : 'waitingItems 부분 갱신과 미해결 항목이 남는 카드의 미완료 상태',
    verification: 'npm run test:mcp',
  }
})
assert.ok(rb07.every((item) => item.currentFollowupNoOp))
assert.ok(rb07.find((item) => item.id === 'partial-waiting').initialUnitUnchanged)
assert.match(rb07[0].finalUnit, /recoveredList.*recoveredCurrent.*updatedAt.*expectedUpdatedAt/s)
assert.match(rb07[1].finalUnit, /waitingItems\[1\]\.id.*status, 'done'/s)
await writeFile(path.join(output, 'followup-commit-inventory.json'), `${JSON.stringify({
  baseline, initialHead, preservedMainHead, candidateHead, capturedAt: new Date().toISOString(),
  initialResponsePathChecks, originalBeforeSha256,
  mainCommitCount: commits.length, commits,
  candidateOnlyCommits: git('log', '--reverse', '--format=%H%x09%s', `${preservedMainHead}..${candidateHead}`).trim().split('\n'),
  mainPreservation, pureGuidanceRestoration,
  mixedFileDiffs: Object.fromEntries(['mcp/server.mjs', 'server/index.mjs', 'server/lib/groupProjects.mjs', 'server/lib/groupDocumentInstructions.mjs', 'server/lib/doorayResponses.mjs', 'scripts/test-mcp.mjs'].map((file) => [file, git('diff', preservedMainHead, candidateHead, '--', file)])),
  rb07, rb07CandidateFollowupDiff: git('diff', '08b22533', candidateHead, '--', mcpFile),
  preservedProductTestDiffs: Object.fromEntries(['tests/global-search-api.test.mjs', 'tests/global-search.test.mjs', 'tests/workspace-pool.test.mjs', 'tests/runtime-entrypoints.test.mjs', 'tests/ai-delegations.test.mjs', 'tests/ai-conversation-context-health.test.mjs'].map((file) => { const diff = git('diff', preservedMainHead, candidateHead, '--', file); assert.equal(diff, ''); return [file, diff] })),
}, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ mainCommitCount: commits.length, preservedMainHead, candidateHead, rb07: rb07.map(({ id, initialUnitUnchanged, currentFollowupNoOp }) => ({ id, initialUnitUnchanged, currentFollowupNoOp })), mainPreservation: true })}\n`)
