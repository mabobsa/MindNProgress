// LAN 주소로 접속하면 보안 컨텍스트가 아니어서 navigator.clipboard가 존재하지 않는다.
// 같은 PC에서 127.0.0.1로 열면 동작하고 다른 장비에서 IP로 열면 조용히 실패하므로,
// 선택 영역 복사로 폴백하고 그마저 막히면 호출한 쪽이 안내할 수 있도록 예외를 던진다.
export async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // 권한이 제한된 브라우저에서는 선택 영역 복사 방식으로 다시 시도합니다.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } finally {
    textarea.remove()
  }
  if (!copied) throw new Error('클립보드 복사를 지원하지 않는 브라우저입니다.')
}
