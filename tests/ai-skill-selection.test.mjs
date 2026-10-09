import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultAiSkillIds } from '../src/utils/aiSkillSelection.mjs'

test('session-message가 현재 머신의 스킬 목록에 있으면 기본 선택한다', () => {
  assert.deepEqual([...defaultAiSkillIds([
    { id: 'other-skill' },
    { id: 'session-message' },
  ])], ['session-message'])
})

test('session-message가 없는 머신에서는 존재하지 않는 스킬을 선택하지 않는다', () => {
  assert.deepEqual([...defaultAiSkillIds([{ id: 'other-skill' }])], [])
  assert.deepEqual([...defaultAiSkillIds([])], [])
})
