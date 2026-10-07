import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'

export function runtimePipe(projectDirectory, stateDirectory) {
  const key = createHash('sha256').update(`${path.resolve(projectDirectory).toLowerCase()}\n${path.resolve(stateDirectory).toLowerCase()}`).digest('hex').slice(0, 24)
  return process.platform === 'win32' ? `\\\\.\\pipe\\mnp-runtime-${key}` : path.join(stateDirectory, `runtime-${key}.sock`)
}

export async function supervise({ projectDirectory, stateDirectory, entries }) {
  await mkdir(stateDirectory, { recursive: true })
  const descriptorFile = path.join(stateDirectory, 'runtime.json')
  const instanceId = randomUUID()
  const pipe = runtimePipe(projectDirectory, stateDirectory)
  const children = []
  let stopping = false
  let stopPromise = null
  const descriptor = { version: 1, instanceId, pid: process.pid, parentPid: process.ppid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    projectDirectory, pipe, children: [] }
  const control = createServer((socket) => {
    socket.setTimeout(1000, () => socket.destroy())
    socket.on('error', () => {})
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString()
      if (input.length > 4096) return socket.destroy()
      if (!input.includes('\n')) return
      try {
        const message = JSON.parse(input.slice(0, input.indexOf('\n')))
        if (message.instanceId !== instanceId || message.type !== 'mnp:shutdown') return socket.end('rejected\n')
        socket.end('accepted\n')
        void stop(0)
      } catch { socket.end('rejected\n') }
    })
  })
  // 파이프 점유가 중복 실행을 차단한다. PID 파일만으로 실행 여부를 판단하지 않는다.
  await new Promise((resolve, reject) => {
    control.once('error', reject)
    control.listen(pipe, resolve)
  })
  async function stop(code) {
    if (stopPromise) return stopPromise
    stopping = true
    stopPromise = (async () => {
      const started = performance.now()
      console.log('[Runtime] draining API and web processes')
      for (const entry of children) {
        if (entry.finished || entry.child.exitCode !== null || entry.child.signalCode !== null) continue
        const childStarted = performance.now()
        // 시작 도중에는 자식의 종료 핸들러 등록을 기다려 IPC 요청 유실을 막는다.
        await Promise.race([entry.ready, entry.exited])
        if (entry.finished) continue
        if (entry.child.connected) entry.child.send({ type: 'mnp:shutdown' }, (error) => {
          if (error) console.error(`[Runtime ${entry.name}]`, error.message)
        })
        // API의 저장이 끝난 후 웹을 종료한다. 자동 강제 종료 제한 시간은 두지 않는다.
        const childCode = await entry.exited
        if (childCode !== 0) {
          console.error(`[Runtime] ${entry.name} shutdown exit code ${childCode ?? 'signal'}`)
          if (code === 0) code = childCode || 1
        }
        console.log(`[Runtime] ${entry.name} process exit ${Math.round(performance.now() - childStarted)}ms`)
      }
      await new Promise((resolve) => control.close(resolve))
      try {
        const current = JSON.parse(await readFile(descriptorFile, 'utf8'))
        if (current.instanceId === instanceId) await rm(descriptorFile, { force: true })
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      console.log(`[Runtime] stopped ${Math.round(performance.now() - started)}ms`)
      process.exit(code)
    })().catch((error) => console.error('[Runtime supervisor shutdown failed]', error))
    return stopPromise
  }
  process.on('SIGINT', () => void stop(0))
  process.on('SIGTERM', () => void stop(0))
  try {
    for (const entry of entries) {
      const child = spawn(process.execPath, [entry.file, ...(entry.args ?? [])], {
        cwd: projectDirectory, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      })
      const managed = { name: entry.name, child, finished: false }
      managed.ready = new Promise((resolve) => {
        child.on('message', (message) => { if (message?.type === 'mnp:shutdown-ready') resolve() })
      })
      managed.exited = new Promise((resolve) => {
        child.once('exit', (code) => { managed.finished = true; resolve(code); if (!stopping) void stop(code || 1) })
        child.once('error', (error) => { managed.finished = true; console.error(`[Runtime ${entry.name}]`, error); resolve(1); if (!stopping) void stop(1) })
      })
      children.push(managed)
      descriptor.children.push({ name: entry.name, pid: child.pid })
    }
    const temporary = `${descriptorFile}.${instanceId}.tmp`
    await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 })
    await rename(temporary, descriptorFile)
  } catch (error) {
    console.error('[Runtime startup failed]', error)
    await stop(1)
  }
}
