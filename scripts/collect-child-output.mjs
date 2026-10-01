import { StringDecoder } from 'node:string_decoder'

// 두 스트림의 불완전한 문자는 서로 섞지 않는다. 합친 text의 순서는
// 스트림별 디코더가 완성된 문자열을 내보낸 순서이며 프로세스의 쓰기 순서가 아니다.
export function collectChildOutput(child) {
  return new Promise((resolve, reject) => {
    let text = ''
    const streams = Object.fromEntries(['stdout', 'stderr'].map((name) => {
      const decoder = new StringDecoder('utf8')
      let output = ''
      let ended = false
      const append = (value) => { output += value; text += value }
      const end = () => {
        if (ended) return
        ended = true
        append(decoder.end())
      }
      child[name].on('data', (data) => append(decoder.write(data)))
      child[name].once('end', end)
      child[name].once('error', reject)
      return [name, { end, output: () => output }]
    }))
    child.once('error', reject)
    // exit 뒤에도 pipe 출력이 남을 수 있으므로 stdio가 닫힌 close를 기다린다.
    child.once('close', (exitCode, signal) => {
      streams.stdout.end()
      streams.stderr.end()
      resolve({ text, stdout: streams.stdout.output(), stderr: streams.stderr.output(), exitCode, signal })
    })
  })
}
