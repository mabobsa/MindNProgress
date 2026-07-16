import { Fragment } from 'react'
import { LinkifiedText } from './LinkifiedText'

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function MentionText({ text, names }: { text: string; names: string[] }) {
  const mentionNames = names.filter(Boolean).sort((first, second) => second.length - first.length)
  if (mentionNames.length === 0) return <LinkifiedText text={text} />
  const mentionPattern = new RegExp(`(${mentionNames.map((name) => `@${escapeRegExp(name)}`).join('|')})`, 'g')

  return (
    <>
      {text.split(mentionPattern).map((part, index) => mentionNames.some((name) => part === `@${name}`)
        ? <mark className="comment-mention" key={`${part}-${index}`}>{part}</mark>
        : <Fragment key={index}><LinkifiedText text={part} /></Fragment>)}
    </>
  )
}
