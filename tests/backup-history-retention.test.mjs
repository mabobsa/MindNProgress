import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backupScript = path.join(projectDirectory, 'scripts', 'backup-data.ps1')
const windowsPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const powerShell7 = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')
const powershellArguments = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
const testEnvironment = { ...process.env, MNP_DATA_DIR: '', MNP_BACKUP_DIR: '', MNP_IMAGE_GC_MIN_AGE_HOURS: '', MNP_BACKUP_NO_PAUSE: '1', MNP_BACKUP_KEEP_ALL_HISTORY: '' }
const psString = (value) => `'${value.replaceAll("'", "''")}'`
const DAY = 86_400_000
const KST = 9 * 3_600_000

function run(shell, argumentsList, env = testEnvironment) {
  return executeFile(shell, [...powershellArguments, ...argumentsList], { env, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
}
const runCommand = (shell, command, env) => run(shell, ['-Command', `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ${command}`], env)

// 한국 시간으로 오늘에서 daysAgo일 전 hour시의 저장 시각(ms). 보관 기준(한 달 전 00:00)에서 충분히 먼 60·59일 전과 5일 전만 쓴다.
function kstTime(daysAgo, hour) {
  const now = new Date(Date.now() + KST)
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * DAY + hour * 3_600_000 - KST
}
const revisionName = (time) => `${time.toString(36)}-${randomBytes(4).toString('hex')}.json`
const revision = (time, label) => Buffer.from(JSON.stringify({ id: label, archivedAt: new Date(time).toISOString(), map: { id: label, nodes: [{ id: 'root', data: { label } }], edges: [] } }))

async function writeFixtureFile(root, relativePath, bytes) {
  const file = path.join(root, relativePath)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

async function readArchiveText(shell, archivePath, entryName) {
  const { stdout } = await runCommand(shell, `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead(${psString(archivePath)})
    try {
      $entry = @($zip.Entries | Where-Object { $_.FullName.Replace('\\', '/') -eq ${psString(entryName)} })[0]
      $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
      try { $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
  `)
  return stdout
}

const shells = [['Windows PowerShell 5.1', windowsPowerShell], ...(existsSync(powerShell7) ? [['PowerShell 7', powerShell7]] : [])]

for (const [shellName, shell] of shells) {
  test(`${shellName}: 백업은 한 달 지난 문서 이력을 문서·날짜별 마지막 1개만 담고 나머지는 그대로 담는다`, {
    skip: process.platform !== 'win32',
    timeout: 240_000,
  }, async (t) => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'mindnprogress-backup-history-'))
    const fixtureProject = path.join(temporaryRoot, '이력 프로젝트')
    const backupDirectory = path.join(temporaryRoot, 'backups')
    const history = 'server/data/_history'
    // 60일 전: map-a에 이력 ID 3개와 이름 형식이 다른 이력(archivedAt이 가장 늦음), map-b에 2개. 59일 전: map-a 1개. 5일 전: map-a 2개.
    const older = {
      a10: `map-a/${revisionName(kstTime(60, 10))}`, a11: `map-a/${revisionName(kstTime(60, 11))}`, a12: `map-a/${revisionName(kstTime(60, 12))}`,
      aLegacy: 'map-a/legacy-revision-a.json', a59: `map-a/${revisionName(kstTime(59, 9))}`,
      b08: `map-b/${revisionName(kstTime(60, 8))}`, b20: `map-b/${revisionName(kstTime(60, 20))}`,
      // 압축 이력(.json.br)도 이름의 이력 ID로 시각을 읽어 같은 규칙을 적용한다.
      c09: `map-c/${revisionName(kstTime(60, 9))}.br`, c15: `map-c/${revisionName(kstTime(60, 15))}.br`,
    }
    const recent = { a5x: `map-a/${revisionName(kstTime(5, 10))}`, a5y: `map-a/${revisionName(kstTime(5, 11))}` }
    const historyFiles = new Map([
      [older.a10, revision(kstTime(60, 10), 'a10')], [older.a11, revision(kstTime(60, 11), 'a11')], [older.a12, revision(kstTime(60, 12), 'a12')],
      [older.aLegacy, revision(kstTime(60, 13), 'a-legacy')], [older.a59, revision(kstTime(59, 9), 'a59')],
      [older.b08, revision(kstTime(60, 8), 'b08')], [older.b20, revision(kstTime(60, 20), 'b20')],
      [older.c09, randomBytes(300)], [older.c15, randomBytes(300)],
      [recent.a5x, revision(kstTime(5, 10), 'a5x')], [recent.a5y, revision(kstTime(5, 11), 'a5y')],
      ['map-a/unknown-time.json', Buffer.from('{"note":"저장 시각이 없는 파일"}')],
      ['map-a/notes.txt', Buffer.from('이력 형식이 아닌 파일')],
      ['map-b/attachments/x.bin', randomBytes(256)],
      ['index.json', Buffer.from('{"kind":"history-index"}')],
    ])
    const excluded = new Set([older.a10, older.a11, older.a12, older.b08, older.c09])
    const otherFiles = new Map([['map-a.json', Buffer.from('{"id":"map-a"}')], ['_comments/map-a.json', Buffer.from('[]')], ['_daily-backups/map-a/2026-09-01.json', Buffer.from('{}')]])
    try {
      for (const [name, bytes] of historyFiles) await writeFixtureFile(fixtureProject, `${history}/${name}`, bytes)
      for (const [name, bytes] of otherFiles) await writeFixtureFile(fixtureProject, `server/data/${name}`, bytes)
      for (const relativePath of ['scripts/cleanup-image-assets.mjs', 'server/lib/imageAssetCleanup.mjs', 'server/lib/imageAssets.mjs', 'server/lib/revisionFiles.mjs']) {
        await mkdir(path.dirname(path.join(fixtureProject, relativePath)), { recursive: true })
        await copyFile(path.join(projectDirectory, relativePath), path.join(fixtureProject, relativePath))
      }

      // 안내 문구를 확인하려고 출력 인코딩을 UTF-8로 바꾼 뒤 스크립트를 실행한다. -File로 실행하면 콘솔 코드 페이지로 출력된다.
      const backup = async (destination, extra = []) => {
        const { stdout } = await runCommand(shell, `& ${psString(backupScript)} -ProjectPath ${psString(fixtureProject)} -Destination ${psString(destination)} ${extra.join(' ')}`)
        const files = await readdir(destination, { recursive: true, withFileTypes: true })
        const archives = files.filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
        assert.equal(archives.length, 1)
        const archivePath = path.join(archives[0].parentPath, archives[0].name)
        return { stdout, archivePath, manifest: JSON.parse(await readArchiveText(shell, archivePath, 'manifest.json')) }
      }

      const { stdout, archivePath, manifest } = await backup(backupDirectory)
      await t.test('한 달 지난 이력은 문서·날짜별로 가장 늦은 1개만 담고 나머지 파일은 모두 담는다', () => {
        const included = new Set(manifest.files.map((file) => file.path).filter((file) => file.startsWith(`${history}/`)).map((file) => file.slice(history.length + 1)))
        assert.deepEqual([...included].sort(), [...historyFiles.keys()].filter((name) => !excluded.has(name)).sort())
        for (const name of otherFiles.keys()) assert.ok(manifest.files.some((file) => file.path === `server/data/${name}`), name)
        assert.ok(included.has(older.aLegacy), '이름 형식이 다르면 archivedAt으로 시각을 읽는다')
        assert.ok(included.has('map-a/unknown-time.json'), '시각을 알 수 없는 파일은 그대로 담는다')
      })
      await t.test('manifest와 RESTORE.txt에 보관 기준과 개수를 남긴다', async () => {
        const retention = manifest.historyRetention
        assert.equal(retention.mode, 'daily-latest-before-cutoff')
        assert.equal(retention.totalFiles, historyFiles.size)
        assert.equal(retention.olderFiles, 9)
        assert.equal(retention.excludedFiles, excluded.size)
        assert.equal(retention.includedFiles, historyFiles.size - excluded.size)
        assert.equal(retention.excludedBytes, [...excluded].reduce((sum, name) => sum + historyFiles.get(name).length, 0))
        assert.match(retention.cutoff, /T00:00:00(\.0+)?\+09:00$/, '기준 시각은 한국 시간 자정이다')
        assert.match(stdout, /문서 이력 9개 중 5개/)
        const restoreGuide = await readArchiveText(shell, archivePath, 'RESTORE.txt')
        assert.match(restoreGuide, /문서 이력: 기준 시각보다 오래된 문서 이력.*포함 10개, 제외 5개/)
      })
      await t.test('운영 데이터의 이력은 그대로 둔다', async () => {
        for (const [name, bytes] of historyFiles) assert.deepEqual(await readFile(path.join(fixtureProject, history, name)), bytes)
      })
      await t.test('-KeepAllHistory는 전체 이력을 담는다', async () => {
        const all = await backup(path.join(temporaryRoot, 'backups-all'), ['-KeepAllHistory'])
        assert.equal(all.manifest.historyRetention.mode, 'all')
        assert.equal(all.manifest.files.filter((file) => file.path.startsWith(`${history}/`)).length, historyFiles.size)
        assert.match(all.stdout, /문서 이력 15개를 모두 백업에 포함합니다/)
      })
      await t.test('이전 백업이 남긴 6시간 지난 복사본과 미완성 ZIP만 정리한다', async () => {
        const destination = path.join(temporaryRoot, 'backups-stale')
        const folder = path.join(destination, '2026-01-05')
        const oldStaging = path.join(folder, `.staging-${'a'.repeat(32)}`)
        const freshStaging = path.join(folder, `.staging-${'b'.repeat(32)}`)
        const oldPartial = path.join(folder, 'MindNProgress_2026-01-05_060000.zip.partial.zip')
        const unrelated = path.join(folder, 'keep.txt')
        for (const file of [path.join(oldStaging, 'server', 'data', 'x.json'), path.join(freshStaging, 'y.json'), oldPartial, unrelated]) {
          await writeFixtureFile(path.dirname(file), path.basename(file), Buffer.from('x'))
        }
        const old = new Date(Date.now() - 7 * 3_600_000)
        for (const item of [oldStaging, oldPartial, unrelated]) await utimes(item, old, old)
        const result = await backup(destination)
        assert.match(result.stdout, /이전 백업이 남긴 미완성 산출물을 정리했습니다/)
        await assert.rejects(stat(oldStaging), { code: 'ENOENT' })
        await assert.rejects(stat(oldPartial), { code: 'ENOENT' })
        await stat(freshStaging)
        await stat(unrelated)
      })
    } finally {
      assert.equal(path.dirname(temporaryRoot), path.resolve(tmpdir()))
      assert.ok(path.basename(temporaryRoot).startsWith('mindnprogress-backup-history-'))
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
}

// 백업 스크립트에서 지정한 함수만 꺼내 현재 범위에 정의한다. 백업 본문은 실행하지 않는다.
const defineBackupFunctions = (names) => String.raw`
  $tokens = $null
  $parseErrors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile(${psString(backupScript)}, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -gt 0) { throw 'Backup script parse failed' }
  foreach ($name in @(${names.map(psString).join(', ')})) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false)
    if (-not $definition) { throw "Missing function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
  }
`

test('백업 뒤 서버 시작은 작업 스케줄러 등록 작업이 있을 때만 mnp-runtime.ps1 -Action start로 하고 실패를 전달한다', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'mindnprogress-backup-start-'))
  const workspace = path.join(temporaryRoot, '작업 폴더')
  const project = path.join(workspace, 'MindNProgress')
  const projectWithoutRuntime = path.join(temporaryRoot, '제어 스크립트 없는 설치', 'MindNProgress')
  const runtimeScript = path.join(project, 'scripts', 'mnp-runtime.ps1')
  const runtimeMarker = path.join(temporaryRoot, 'runtime.txt')
  const launcherMarker = path.join(temporaryRoot, 'launcher.txt')
  try {
    await mkdir(path.join(project, 'scripts'), { recursive: true })
    await mkdir(path.join(projectWithoutRuntime, 'scripts'), { recursive: true })
    // 가짜 공통 제어 스크립트: 받은 Action을 기록하고 지정한 종료 코드로 끝낸다.
    await writeFile(runtimeScript,
      `param([string]$Action)\nSet-Content -LiteralPath ${psString(runtimeMarker)} -Value ('action=' + $Action) -Encoding UTF8\nexit [int]$env:FAKE_RUNTIME_EXIT\n`)
    // 런처가 직접 실행되면 표시를 남긴다.
    await writeFile(path.join(workspace, 'MindNProgress_Launcher.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(launcherMarker)}, 'launched')\n`)

    await t.test('등록 작업과 공통 제어 스크립트가 모두 있을 때만 제어 스크립트를 쓴다', async () => {
      // 실제 작업 스케줄러 대신 등록 여부를 환경 변수로 정한다. 없을 때는 실제 cmdlet처럼 오류를 낸다.
      const { stdout } = await runCommand(windowsPowerShell, String.raw`
        $global:taskQueries = @()
        function Get-ScheduledTask {
          [CmdletBinding()] param([string]$TaskName, [string]$TaskPath)
          $global:taskQueries += ($TaskPath + $TaskName)
          if ($env:FAKE_TASK_REGISTERED -eq '1') { return [pscustomobject]@{ TaskName = $TaskName; TaskPath = $TaskPath } }
          Write-Error 'No MSFT_ScheduledTask objects found.'
        }
        ${defineBackupFunctions(['Get-MindNProgressRuntimeScript'])}
        $env:FAKE_TASK_REGISTERED = '1'
        'registered=' + (Get-MindNProgressRuntimeScript ${psString(project)})
        'withoutScript=' + (Get-MindNProgressRuntimeScript ${psString(projectWithoutRuntime)})
        $env:FAKE_TASK_REGISTERED = '0'
        'unregistered=' + (Get-MindNProgressRuntimeScript ${psString(project)})
        'queries=' + ($global:taskQueries -join ',')
      `)
      const lines = stdout.split(/\r?\n/)
      assert.ok(lines.includes(`registered=${runtimeScript}`), stdout)
      assert.ok(lines.includes('withoutScript='), stdout)
      assert.ok(lines.includes('unregistered='), stdout)
      assert.ok(lines.includes('queries=\\MindNProgress,\\MindNProgress'), '루트 경로의 MindNProgress 작업만 조회한다')
    })

    await t.test('제어 스크립트는 -Action start로 별도 프로세스에서 실행하고 실패하면 런처로 대신 띄우지 않는다', async () => {
      const { stdout } = await runCommand(windowsPowerShell, String.raw`
        ${defineBackupFunctions(['Start-MindNProgress'])}
        $env:FAKE_RUNTIME_EXIT = '0'
        Start-MindNProgress ${psString(workspace)} ${psString(runtimeScript)}
        'started'
        $env:FAKE_RUNTIME_EXIT = '3'
        try { Start-MindNProgress ${psString(workspace)} ${psString(runtimeScript)}; 'not thrown' } catch { 'thrown: ' + $_.Exception.Message }
      `)
      assert.match(stdout, /started/)
      assert.match(stdout, /thrown: .*종료 코드 3.*런처를 직접 실행하지 않았습니다/)
      assert.match(await readFile(runtimeMarker, 'utf8'), /action=start/)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      assert.equal(existsSync(launcherMarker), false)
    })

    await t.test('등록 작업이 없는 설치는 기존 런처로 시작한다', async () => {
      await rm(runtimeMarker, { force: true })
      await runCommand(windowsPowerShell, `${defineBackupFunctions(['Start-MindNProgress'])}\nStart-MindNProgress ${psString(workspace)} ''`)
      for (let attempt = 0; attempt < 50 && !existsSync(launcherMarker); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(existsSync(launcherMarker), true)
      assert.equal(existsSync(runtimeMarker), false)
    })
  } finally {
    assert.equal(path.dirname(temporaryRoot), path.resolve(tmpdir()))
    // 가짜 런처(node)는 작업 폴더를 현재 폴더로 잡고 따로 끝난다. 부하가 크면 늦게 끝나 EBUSY가 나므로 잠시 기다려 다시 지운다.
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
})
