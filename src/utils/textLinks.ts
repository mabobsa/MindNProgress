export type TextLink = { href: string; label: string; start: number; end: number }

function openableHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function extractTextLinks(text: string): TextLink[] {
  const links: TextLink[] = []
  const urlPattern = /https?:\/\/[^\s<>"']+/gi
  let match: RegExpExecArray | null

  while ((match = urlPattern.exec(text)) !== null) {
    const rawUrl = match[0]
    let label = rawUrl.replace(/[.,!?;:，。！？；：]+$/u, '')
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      while (label.endsWith(closing) && label.split(closing).length > label.split(opening).length) {
        label = label.slice(0, -1)
      }
    }
    const href = openableHttpUrl(label)
    if (href) links.push({ href, label, start: match.index, end: match.index + label.length })
  }

  return links
}
