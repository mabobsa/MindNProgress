import assert from 'node:assert/strict'
import test from 'node:test'
import { compactToolListMessage } from '../mcp/toolListSurface.mjs'

test('도구 목록에서는 $schema와 정수 표현 한도만 빼고 의미 있는 제한·설명은 그대로 둔다', () => {
  const inputSchema = {
    $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false, required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 120, pattern: '^mnpw:', description: '식별자' },
      count: { type: 'integer', exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      nested: { type: 'object', additionalProperties: false, properties: { n: { type: 'number', maximum: Number.MAX_SAFE_INTEGER } } },
      list: { type: 'array', items: [{ type: 'integer', maximum: Number.MAX_SAFE_INTEGER }] },
      // 속성 이름이 maximum이어도 스키마 키워드가 아니면 지우지 않는다.
      maximum: { type: 'integer', description: '사용자 값' },
    },
  }
  const message = { jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'a', description: '설명', inputSchema }], nextCursor: 'c' } }
  const compacted = compactToolListMessage(message)
  const schema = compacted.result.tools[0].inputSchema
  assert.equal('$schema' in schema, false)
  assert.equal('maximum' in schema.properties.count, false)
  assert.equal(schema.properties.count.exclusiveMinimum, 0)
  assert.equal(schema.properties.limit.maximum, 100, '실제 한도는 남긴다')
  assert.equal('maximum' in schema.properties.nested.properties.n, false)
  assert.equal('maximum' in schema.properties.list.items[0], false)
  assert.deepEqual(schema.properties.id, inputSchema.properties.id)
  assert.deepEqual(schema.properties.maximum, inputSchema.properties.maximum)
  assert.equal(schema.additionalProperties, false)
  assert.equal(compacted.result.nextCursor, 'c')
  assert.equal(compacted.result.tools[0].description, '설명')
  assert.equal(inputSchema.$schema, 'http://json-schema.org/draft-07/schema#', '원본 객체는 바꾸지 않는다')
  for (const other of [{ jsonrpc: '2.0', id: 1, result: { content: [] } }, { jsonrpc: '2.0', method: 'notifications/message' }, null]) {
    assert.equal(compactToolListMessage(other), other, '도구 목록이 아닌 메시지는 그대로 보낸다')
  }
})
