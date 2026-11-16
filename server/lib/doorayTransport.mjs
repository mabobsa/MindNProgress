import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Dooray API 요청을 이 PC에 설정한 외부 모듈로 보낼 수 있게 하는 연결 지점이다.
// 데이터 폴더의 _dooray-transport.json({"module": "<절대 경로>"})이 있으면 요청마다 그 모듈의
// fetch(input, init, { fallbackFetch })를 부른다. 모듈은 저장소 밖에 두며 이 저장소는 그 구현을 담지 않는다.
// 설정 파일이 없거나 module이 비어 있으면 원래 fetch를 쓴다. 요청마다 설정을 다시 읽으므로 파일을 지우면 재시작 없이 되돌아간다.
// 같은 경로의 모듈은 한 번만 불러온다. 모듈 코드를 바꿨다면 MnP를 다시 시작해야 반영된다.
export function createDoorayTransport({
  settingsFile,
  fetchImpl = fetch,
  importModule = (file) => import(pathToFileURL(file).href),
  warn = (...args) => console.warn(...args),
} = {}) {
  const modules = new Map()
  let lastWarning = ''
  const warnOnce = (message) => {
    if (message === lastWarning) return
    lastWarning = message
    warn(`[Dooray transport] ${message}`)
  }

  async function externalFetch() {
    let settings
    try {
      settings = JSON.parse(await readFile(settingsFile, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') warnOnce(`설정 파일을 읽지 못해 원래 Dooray 연결을 씁니다: ${error.message}`)
      else lastWarning = ''
      return null
    }
    const file = typeof settings?.module === 'string' ? settings.module.trim() : ''
    if (!file) return null
    if (!path.isAbsolute(file)) {
      warnOnce('설정의 module은 절대 경로여야 합니다. 원래 Dooray 연결을 씁니다.')
      return null
    }
    if (!modules.has(file)) modules.set(file, importModule(file))
    try {
      const loaded = await modules.get(file)
      const external = loaded?.fetch ?? loaded?.default?.fetch
      if (typeof external !== 'function') throw new Error('fetch 함수를 내보내지 않습니다.')
      lastWarning = ''
      return external
    } catch (error) {
      modules.delete(file)
      warnOnce(`외부 모듈을 불러오지 못해 원래 Dooray 연결을 씁니다: ${error.message}`)
      return null
    }
  }

  return async function doorayFetch(input, init) {
    const external = await externalFetch()
    return external ? external(input, init, { fallbackFetch: fetchImpl }) : fetchImpl(input, init)
  }
}
