// 확장 프로그램이 실행하는 진입점이다. 서버 구성은 index.mjs에 두어 테스트가 시작 부작용 없이 가져다 쓸 수 있게 한다.
// 확인함 화면 HTML은 빌드가 ui/inbox.html에 만들어 두며, 번들 기준 ../ui/inbox.html에 있다.
import { readFile } from 'node:fs/promises'
import { main } from './index.mjs'

const uiHtml = await readFile(new URL('../ui/inbox.html', import.meta.url), 'utf8').catch((error) => {
  console.error('[dooray-mention-inbox] 확인함 화면 파일을 읽지 못했습니다:', error?.message ?? error)
  return '<!doctype html><meta charset="utf-8"><p>확인함 화면 파일이 없습니다. 확장 프로그램을 다시 설치해 주세요.</p>'
})

main({ uiHtml }).catch((error) => {
  console.error('[dooray-mention-inbox]', error)
  process.exit(1)
})
