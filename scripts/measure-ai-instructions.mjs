import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MNP_MCP_SERVER_INSTRUCTIONS } from '../src/utils/aiContextInstructions.mjs'
import { buildAiInstructionSnapshots } from '../tests/helpers/aiInstructionSnapshots.mjs'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = path.join(projectDirectory, 'tests/fixtures/ai-instruction-budget.json')
const toolSurfaceFixturePath = path.join(projectDirectory, 'tests/fixtures/mcp-tool-input-schema.json')
const execDeclarationChars = 24_602
const perToolWrapperChars = 35
const verificationDescriptions = [
  'mindnprogress_add_card',
  'mindnprogress_apply_reconstruction',
  'mindnprogress_apply_shared_knowledge_review',
  'mindnprogress_checkpoint_ai_workspace',
  'mindnprogress_complete_ai_delegation',
  'mindnprogress_create_group_document',
  'mindnprogress_create_mindmap',
  'mindnprogress_delegate_ai_work',
  'mindnprogress_delete_card',
  'mindnprogress_delete_trashed_documents',
  'mindnprogress_finalize_ai_coordination',
  'mindnprogress_manage_comment',
  'mindnprogress_manage_knowledge_line',
  'mindnprogress_mark_notifications_read',
  'mindnprogress_move_card',
  'mindnprogress_patch_card_text',
  'mindnprogress_reorder_documents',
  'mindnprogress_restore_history',
  'mindnprogress_retry_ai_delegation_report',
  'mindnprogress_rollback_reconstruction',
  'mindnprogress_save_document_layout',
  'mindnprogress_send_group_document_instruction',
  'mindnprogress_set_document_archive',
  'mindnprogress_set_document_trash_state',
  'mindnprogress_submit_card_layout_proposal',
  'mindnprogress_submit_reconstruction_proposal',
  'mindnprogress_supersede_ai_delegation',
  'mindnprogress_update_card',
  'mindnprogress_update_document_info',
  'mindnprogress_update_group_project',
]

function countSchemaDescriptions(value) {
  if (!value || typeof value !== 'object') return 0
  return (typeof value.description === 'string' ? 1 : 0)
    + Object.values(value).reduce((sum, child) => sum + countSchemaDescriptions(child), 0)
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectDirectory, 'mcp/server.mjs')],
  env: { ...process.env, MNP_MCP_USAGE_DISABLED: '1' },
  stderr: 'pipe',
})
const client = new Client({ name: 'measure-ai-instructions', version: '1.0.0' })

try {
  await client.connect(transport)
  const tools = [...(await client.listTools()).tools].sort((a, b) => a.name.localeCompare(b.name))
  const toolDescriptionChars = tools.reduce((sum, tool) => sum + tool.description.length, 0)
  const fixedSurfaceChars = execDeclarationChars + toolDescriptionChars
    + perToolWrapperChars * tools.length + MNP_MCP_SERVER_INSTRUCTIONS.length
  const snapshots = buildAiInstructionSnapshots().map(({ name, text }) => ({
    name,
    chars: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
  }))
  const dynamicTotalChars = snapshots.reduce((sum, snapshot) => sum + snapshot.chars, 0)
  const maxDynamicChars = Math.max(...snapshots.map((snapshot) => snapshot.chars))
  const snapshotText = buildAiInstructionSnapshots().map((snapshot) => snapshot.text).join('\n')
  const count = (token) => snapshotText.split(token).length - 1
  const budget = {
    schemaVersion: 1,
    toolCount: tools.length,
    schemaDescriptionCount: tools.reduce((sum, tool) => sum + countSchemaDescriptions(tool.inputSchema), 0),
    execDeclarationChars,
    execDeclarationSource: '구현 직전 활성 MCP 등록 표면에서 캡처했으며 input schema deep-equal로 불변을 검증합니다.',
    perToolWrapperChars,
    serverInstructionsChars: MNP_MCP_SERVER_INSTRUCTIONS.length,
    toolDescriptionChars,
    fixedSurfaceChars,
    dynamicTotalChars,
    maxDynamicChars,
    maxStartChars: fixedSurfaceChars + maxDynamicChars,
    repetitionCounts: {
      contextBootstrap: count('# 대화 문맥 초기화'),
      writePolicy: count('writePolicy:'),
      workspace: count('# 할당된 작업공간'),
      completion: count('mindnprogress_complete_ai_delegation'),
      doorayProposal: count('workflow: dooray-proposal'),
      doorayApproval: count('진입: approval-first'),
    },
    verificationDescriptions,
    snapshots,
  }
  if (process.argv.includes('--write')) {
    const toolSurface = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    await Promise.all([
      writeFile(fixturePath, `${JSON.stringify(budget, null, 2)}\n`, 'utf8'),
      writeFile(toolSurfaceFixturePath, `${JSON.stringify(toolSurface, null, 2)}\n`, 'utf8'),
    ])
  }
  process.stdout.write(`${JSON.stringify(budget, null, 2)}\n`)
} finally {
  await client.close()
}
