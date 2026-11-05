// Dooray 멘션 확인함 확장 프로그램(.mcpb)을 만든다.
// 사용법: (처음 한 번) npm install --prefix extensions/dooray-mention-inbox
//         node extensions/dooray-mention-inbox/scripts/build.mjs [--skip-pack]
// 서버 코드와 의존성(MCP SDK, MCP Apps SDK, zod, MnP의 doorayMentions.mjs)을 파일 하나로 묶고,
// 확인함 화면은 스크립트를 넣은 HTML 한 장으로 만든다. 설치 PC에는 node_modules가 필요 없다.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'

import { SERVER_NAME, SERVER_VERSION } from '../server/version.mjs'

const extensionDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2'

export async function bundleServer(outputFile) {
  const bundle = await rolldown({
    input: path.join(extensionDirectory, 'server', 'main.mjs'),
    platform: 'node',
    external: [/^node:/],
    logLevel: 'warn',
  })
  try {
    await bundle.write({ file: outputFile, format: 'esm', codeSplitting: false, sourcemap: false })
  } finally {
    await bundle.close()
  }
  return outputFile
}

// 확인함 화면 HTML 한 장을 만든다. 대화창 안 화면은 외부 파일을 불러올 수 없어 스크립트를 HTML 안에 넣는다.
export async function buildUiHtml() {
  const bundle = await rolldown({ input: path.join(extensionDirectory, 'ui', 'app.mjs'), platform: 'browser', logLevel: 'warn' })
  let code
  try {
    const { output } = await bundle.generate({ format: 'iife', codeSplitting: false, sourcemap: false, minify: true })
    code = output[0].code
  } finally {
    await bundle.close()
  }
  const template = await readFile(path.join(extensionDirectory, 'ui', 'inbox.html'), 'utf8')
  if (!template.includes('<!--APP_SCRIPT-->')) throw new Error('ui/inbox.html에 <!--APP_SCRIPT--> 자리가 없습니다.')
  // 스크립트 안의 </script 문자열이 HTML 태그로 해석되지 않게 한다.
  return template.replace('<!--APP_SCRIPT-->', () => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`)
}

export async function stageExtension(stageDirectory) {
  const manifest = JSON.parse(await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'))
  // Windows에서 manifest 이름과 서버 이름이 다르면 채팅에 도구가 보이지 않았다는 보고가 있어 둘을 맞춘다.
  if (manifest.name !== SERVER_NAME) throw new Error(`manifest name(${manifest.name})과 서버 이름(${SERVER_NAME})이 다릅니다.`)
  if (manifest.version !== SERVER_VERSION) throw new Error(`manifest version(${manifest.version})과 서버 버전(${SERVER_VERSION})이 다릅니다.`)
  await rm(stageDirectory, { recursive: true, force: true })
  await mkdir(path.join(stageDirectory, 'server'), { recursive: true })
  await mkdir(path.join(stageDirectory, 'ui'), { recursive: true })
  await bundleServer(path.join(stageDirectory, 'server', 'main.mjs'))
  await writeFile(path.join(stageDirectory, 'ui', 'inbox.html'), await buildUiHtml(), 'utf8')
  await copyFile(path.join(extensionDirectory, 'manifest.json'), path.join(stageDirectory, 'manifest.json'))
  return manifest
}

function runMcpb(args) {
  // Windows의 npx는 셸로 실행해야 하므로 인자를 따옴표로 감싼 한 줄 명령으로 넘긴다.
  const command = ['npx', '-y', MCPB_CLI, ...args].map((value) => (/^[\w@./:\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`)).join(' ')
  const result = spawnSync(command, { stdio: 'inherit', shell: true })
  if (result.status !== 0) throw new Error(`mcpb ${args[0]} 실패 (종료 코드 ${result.status})`)
}

async function build({ skipPack = false } = {}) {
  const distDirectory = path.join(extensionDirectory, 'dist')
  const stageDirectory = path.join(distDirectory, 'stage')
  const manifest = await stageExtension(stageDirectory)
  console.log(`[build] 서버 번들 ${(await stat(path.join(stageDirectory, 'server', 'main.mjs'))).size} bytes, 화면 ${(await stat(path.join(stageDirectory, 'ui', 'inbox.html'))).size} bytes`)
  if (skipPack) return
  runMcpb(['validate', path.join(stageDirectory, 'manifest.json')])
  const output = path.join(distDirectory, `${manifest.name}-${manifest.version}.mcpb`)
  await rm(output, { force: true })
  runMcpb(['pack', stageDirectory, output])
  const bytes = await readFile(output)
  console.log(`[build] ${output}`)
  console.log(`[build] 크기 ${bytes.length} bytes, SHA-256 ${createHash('sha256').update(bytes).digest('hex')}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build({ skipPack: process.argv.includes('--skip-pack') }).catch((error) => {
    console.error('[build]', error.message)
    process.exit(1)
  })
}
