import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backupScript = path.join(projectDirectory, 'scripts', 'backup-data.ps1')
const restoreScript = path.join(projectDirectory, 'scripts', 'restore-data.ps1')
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const powershellArguments = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
const testEnvironment = { ...process.env, MNP_DATA_DIR: '', MNP_BACKUP_DIR: '', MNP_IMAGE_GC_MIN_AGE_HOURS: '' }

function psString(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function runPowerShell(argumentsList) {
  return executeFile(powershell, [...powershellArguments, ...argumentsList], {
    env: testEnvironment,
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  })
}

function runCommand(command) {
  return runPowerShell(['-Command', `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ${command}`])
}

async function writeFixtureFile(root, relativePath, bytes) {
  const file = path.join(root, relativePath)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, bytes)
}

test('Windows 백업은 모든 파일을 보존하고 기존 복원 및 손상 검증과 호환된다', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'mindnprogress-backup-test-'))
  const fixtureProject = path.join(temporaryRoot, '한글 프로젝트')
  const backupDirectory = path.join(temporaryRoot, 'backups')
  const dataFiles = new Map([
    ['map-backup.json', Buffer.from(JSON.stringify({ id: 'map-backup', title: '백업 확인', nodes: [], edges: [] }))],
    ['이력 폴더/문서.json', Buffer.from('{"본문":"이력도 그대로 복원합니다."}')],
    ['nested/manifest.json', Buffer.from('{"kind":"application-data"}')],
    ['hidden.json', Buffer.from('{"hidden":true}')],
    ['.gitkeep', Buffer.alloc(0)],
    ['binary.bin', randomBytes(4096)],
  ])
  const configFiles = new Map([
    ['.env', Buffer.from('MNP_TEST_SETTING=fixture-only\n')],
    ['settings.local', Buffer.from('로컬 설정\n')],
  ])

  try {
    for (const [name, bytes] of dataFiles) await writeFixtureFile(fixtureProject, `server/data/${name}`, bytes)
    for (const [name, bytes] of configFiles) await writeFixtureFile(fixtureProject, name, bytes)
    await mkdir(path.join(fixtureProject, 'server/data/empty-directory'), { recursive: true })
    for (const relativePath of ['scripts/cleanup-image-assets.mjs', 'server/lib/imageAssetCleanup.mjs', 'server/lib/imageAssets.mjs']) {
      const target = path.join(fixtureProject, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(projectDirectory, relativePath), target)
    }
    await runCommand(`[IO.File]::SetAttributes(${psString(path.join(fixtureProject, 'server/data/hidden.json'))}, [IO.FileAttributes]::Hidden)`)

    await runPowerShell(['-File', backupScript, '-ProjectPath', fixtureProject, '-Destination', backupDirectory])
    const backupFiles = await readdir(backupDirectory, { recursive: true, withFileTypes: true })
    const archives = backupFiles.filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
    assert.equal(archives.length, 1)
    assert.equal(backupFiles.some((entry) => /^(\.staging-|\.verify-)|\.partial\.zip$/.test(entry.name)), false)
    const archivePath = path.join(archives[0].parentPath, archives[0].name)
    const { stdout } = await runCommand(`
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip = [IO.Compression.ZipFile]::OpenRead(${psString(archivePath)})
      try {
        $reader = New-Object IO.StreamReader($zip.GetEntry('manifest.json').Open())
        try { $reader.ReadToEnd() } finally { $reader.Dispose() }
      } finally { $zip.Dispose() }
    `)
    const manifest = JSON.parse(stdout)

    await t.test('manifest는 중첩 manifest와 숨김 파일, 빈 파일을 포함해 모든 바이트를 기록한다', () => {
      assert.equal(manifest.formatVersion, 1)
      assert.equal(manifest.product, 'MindNProgress')
      assert.equal(manifest.fileCount, dataFiles.size + configFiles.size + 1)
      assert.equal(manifest.totalBytes, manifest.files.reduce((sum, entry) => sum + entry.size, 0))
      for (const [prefix, files] of [['server/data', dataFiles], ['local-config', configFiles]]) {
        for (const [name, bytes] of files) {
          const entry = manifest.files.find((file) => file.path === `${prefix}/${name}`)
          assert.ok(entry, `Missing manifest entry: ${prefix}/${name}`)
          assert.equal(entry.size, bytes.length)
          assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
        }
      }
    })

    await t.test('기존 복원 스크립트로 한글 경로와 로컬 설정을 바이트 단위로 복원한다', async () => {
      const restoreProject = path.join(temporaryRoot, '복원 프로젝트')
      await mkdir(restoreProject)
      await runPowerShell(['-File', restoreScript, '-ProjectPath', restoreProject, '-ArchivePath', archivePath])
      for (const [name, bytes] of dataFiles) {
        assert.deepEqual(await readFile(path.join(restoreProject, 'server/data', name)), bytes)
      }
      for (const [name, bytes] of configFiles) {
        assert.deepEqual(await readFile(path.join(restoreProject, name)), bytes)
      }
      assert.ok((await readdir(path.join(restoreProject, 'server/data'), { withFileTypes: true }))
        .some((entry) => entry.name === 'empty-directory' && entry.isDirectory()))
    })

    await t.test('ZIP 검증은 구형 구분자를 지원하고 누락·크기·해시·중복 오류를 거부한다', async () => {
      const { stdout: validationOutput } = await runCommand(String.raw`
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $tokens = $null
        $parseErrors = $null
        $ast = [Management.Automation.Language.Parser]::ParseFile(${psString(backupScript)}, [ref]$tokens, [ref]$parseErrors)
        if ($parseErrors.Count -gt 0) { throw 'Backup script parse failed' }
        $definition = $ast.Find({ param($node)
          $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-BackupArchive'
        }, $false)
        . ([scriptblock]::Create($definition.Extent.Text))
        Test-BackupArchive ${psString(archivePath)}

        foreach ($mode in @('legacy', 'manifest', 'missing', 'size', 'hash', 'duplicate')) {
          $testArchive = Join-Path ${psString(temporaryRoot)} ($mode + '.zip')
          Copy-Item -LiteralPath ${psString(archivePath)} -Destination $testArchive
          $zip = [IO.Compression.ZipFile]::Open($testArchive, [IO.Compression.ZipArchiveMode]::Update)
          try {
            $entry = @($zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'server/data/map-backup.json' })[0]
            if ($mode -eq 'legacy') {
              foreach ($original in @($zip.Entries)) {
                if (-not $original.FullName.Contains('/')) { continue }
                $replacement = $zip.CreateEntry($original.FullName.Replace('/', '\'))
                $inputStream = $original.Open()
                $outputStream = $replacement.Open()
                try { $inputStream.CopyTo($outputStream) } finally { $inputStream.Dispose(); $outputStream.Dispose() }
                $original.Delete()
              }
            } elseif ($mode -eq 'manifest') {
              $zip.GetEntry('manifest.json').Delete()
            } elseif ($mode -eq 'missing') {
              $entry.Delete()
            } elseif ($mode -eq 'duplicate') {
              $null = $zip.CreateEntry($entry.FullName.Replace('/', '\'))
            } else {
              $stream = $entry.Open()
              try {
                if ($mode -eq 'size') {
                  $stream.SetLength(0)
                } else {
                  $value = $stream.ReadByte()
                  $stream.Position = 0
                  $stream.WriteByte($value -bxor 1)
                }
              } finally { $stream.Dispose() }
            }
          } finally { $zip.Dispose() }
          $rejected = $false
          try { Test-BackupArchive $testArchive } catch { $rejected = $true }
          if ($mode -eq 'legacy' -and $rejected) { throw 'Legacy ZIP separators rejected' }
          if ($mode -ne 'legacy' -and -not $rejected) { throw ('Invalid ZIP accepted: ' + $mode) }
          $handle = [IO.File]::Open($testArchive, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
          $handle.Dispose()
        }
        'Archive validation cases passed'
      `)
      assert.match(validationOutput, /Archive validation cases passed/)
    })
  } finally {
    assert.equal(path.dirname(temporaryRoot), path.resolve(tmpdir()))
    assert.ok(path.basename(temporaryRoot).startsWith('mindnprogress-backup-test-'))
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
