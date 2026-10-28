import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { scryptSync } from 'node:crypto'
import path from 'node:path'
import { storageApi } from './storage-api-harness.mjs'
import { doorayProposalRevision } from '../../server/lib/doorayResponseDecision.mjs'

// 07의 최초 실패와 동일한 합성 승인 자료를 재사용한다.
export async function approvalIntegrationFixture(t, { beforeConversation } = {}) {
  let workspace, revision
  const api = await storageApi(t, { documents: 3, readyTimeoutMs: 60000,
    seed: async ({ data, ids }) => {
      workspace = path.dirname(data)
      const usersFile = path.join(data, '_users.json')
      const users = JSON.parse(await readFile(usersFile, 'utf8'))
      users[0].passwordHash = scryptSync('ApprovalTestOnly!2026', users[0].salt, 64).toString('hex')
      await writeFile(usersFile, JSON.stringify(users))
      const job = { id: 'dooray-launch-fixture', userId: 'user-editor', status: 'approved', attempt: 1,
        createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z',
        source: { fingerprint: 'fixture-only', subject: '격리 연결 검증', item: { key: 'fixture', postId: 'fixture', url: 'https://example.invalid/fixture' } },
        settings: { machineId: 'isolated-storage', agentId: 'fixture-agent', modelId: 'fixture-model' },
        route: { mapId: ids[0], cardId: 'card-1', documentTitle: '격리 문서', cardTitle: '격리 카드' },
        proposal: '합성 자료의 연결 확인만 수행한다.',
        decision: { kind: 'approval', reason: '격리 재현용 승인', questions: [], approval: { title: '격리 확인', scope: ['모의 연결'], exclusions: ['운영 변경'] } } }
      revision = doorayProposalRevision(job)
      job.approval = { revision, approvedAt: '2026-10-28T00:00:00Z', approvedBy: { id: 'user-editor', name: '격리 편집자' }, proposal: job.proposal, ...job.decision.approval }
      await mkdir(path.join(data, '_dooray-responses'))
      await writeFile(path.join(data, '_dooray-responses/user-editor.json'), JSON.stringify({ jobs: [job] }))
    }, mockAion: async url => {
      if (url === '/api/agents/management') return [{ id: 'fixture-agent', name: '검증 AI', installed: true, enabled: true,
        available_models: { available_models: [{ value: 'fixture-model', name: '검증 모델' }] } }]
      if (url === '/api/conversations/approved-launch') {
        await beforeConversation?.()
        return { id: 'approved-launch', name: '모의 생성 대화', created_at: '2026-10-28T00:00:00Z',
          extra: { agent_id: 'fixture-agent', current_model_id: 'fixture-model', workspace } }
      }
      return []
    } })

  return { api, workspace, revision }
}
