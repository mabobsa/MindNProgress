import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fixture, actor } from './storage-api-harness.mjs'

export async function seedReadFixture({ data, ids }) {
  const ref = fixture(ids[1])
  for (let i = 1; i < 20; i++) ref.nodes[i].data.reference = { mapId: ids[2 + i % 5], nodeId: `card-${i}` }
  await writeFile(path.join(data, `${ids[1]}.json`), JSON.stringify(ref))
  for (const mapId of ids.slice(0, 7)) {
    const comments = Array.from({ length: 100 }, (_, i) => ({ id: `comment-fixture-${i}`, mapId, nodeId: `card-${i % 20}`,
      text: '검증 댓글입니다. '.repeat(100), createdAt: `2026-10-26T00:00:${String(i % 60).padStart(2, '0')}.000Z`, author: actor }))
    await writeFile(path.join(data, '_comments', `${mapId}.json`), JSON.stringify(comments))
  }
  const schedule = fixture(ids[7])
  for (const node of schedule.nodes) Object.assign(node.data, { isWork: true, kind: 'task', assigneeId: 'user-editor', dueDate: '2026-10-27' })
  await writeFile(path.join(data, `${ids[7]}.json`), JSON.stringify(schedule))
  const result = '고정 합성 위임 결과입니다. '.repeat(100).slice(0, 1000)
  const delegations = Array.from({ length: 200 }, (_, i) => ({ id: `delegation-read-${i}`, mapId: ids[7],
    parentCardId: 'card-0', targetCardId: `card-${i % 20}`, parentConversationId: 'fixture-parent', targetConversationId: `fixture-child-${i}`,
    state: 'completed', childStatus: 'completed', parentDispatchState: 'completed', startedBy: 'user-editor',
    createdAt: new Date(Date.UTC(2026, 9, 27, 0, i)).toISOString(), completedAt: '2026-10-27T04:00:00.000Z',
    updatedAt: '2026-10-27T04:00:00.000Z', childResultSnapshot: result,
    childResultHash: createHash('sha256').update(result).digest('hex'),
  }))
  await writeFile(path.join(data, '_ai-delegations.json'), JSON.stringify(delegations))
}
