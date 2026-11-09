// tools/list 응답의 inputSchema에서 AI가 쓰지 않는 직렬화 표기만 뺀다. 입력 검증(zod)과 서버 검증은 그대로다.
// - $schema: SDK 변환기(zod-to-json-schema)가 도구마다 붙이는 draft-07 표기. 지금 쓰는 키워드는 MCP 기본 해석과 의미가 같다.
// - maximum: Number.MAX_SAFE_INTEGER: 정수 표현 한도일 뿐 실제 입력 제한이 아니다.
// 길이·형식 제한, 허용 항목(additionalProperties) 같은 의미 있는 표기는 바꾸지 않는다.
function compactSchema(value) {
  if (Array.isArray(value)) return value.map(compactSchema)
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'maximum' && child === Number.MAX_SAFE_INTEGER) continue
    result[key] = compactSchema(child)
  }
  return result
}

export function compactToolInputSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema
  const { $schema: _dialect, ...rest } = schema
  return compactSchema(rest)
}

/** 서버가 보내는 JSON-RPC 메시지 중 tools/list 결과만 바꾸고 나머지는 그대로 돌려준다. */
export function compactToolListMessage(message) {
  const tools = message?.result?.tools
  if (!Array.isArray(tools)) return message
  return { ...message, result: { ...message.result, tools: tools.map((tool) => ({ ...tool, inputSchema: compactToolInputSchema(tool.inputSchema) })) } }
}
