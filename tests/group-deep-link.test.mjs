import assert from 'node:assert/strict'
import test from 'node:test'
import { groupPageUrl, parseGroupDeepLink } from '../src/utils/groupDeepLink.mjs'

test('총괄 페이지 링크는 공개 주소와 안정적인 그룹 ID를 사용한다', () => {
  const groupId = 'group-72077068-3025-4d87-a4fe-bb841a828d53'
  const url = groupPageUrl('http://10.77.15.110:4175/', groupId)
  assert.equal(url, `http://10.77.15.110:4175/groups/${groupId}`)
  assert.equal(parseGroupDeepLink(new URL(url).pathname), groupId)
  assert.equal(parseGroupDeepLink(`/groups/${groupId}/`), groupId)
  assert.equal(parseGroupDeepLink('/groups/group-%61bc'), 'group-abc')
})

test('현재 문서 경로나 쿼리와 무관하게 총괄 페이지 주소를 만든다', () => {
  assert.equal(groupPageUrl('https://mind.example/mindmap/map-a/root?tab=old#selection', 'group-a'), 'https://mind.example/groups/group-a')
})

test('기존 문서 링크와 잘못된 그룹 경로는 총괄 페이지로 해석하지 않는다', () => {
  for (const pathname of ['/', '/mindmap/map-a/root', '/viewer', '/groups', '/groups/', '/groups/group-a/extra', '/groups/../', '/groups/group-%2Fother', '/groups/%E0%A4%A', '/groups/group-한글', `/groups/group-${'a'.repeat(101)}`]) {
    assert.equal(parseGroupDeepLink(pathname), null, pathname)
  }
})

test('복사할 그룹 링크는 잘못된 주소나 식별자를 거부한다', () => {
  for (const base of ['', 'not a url', 'javascript:alert(1)', 'file:///C:/Git/', 'https://user:password@mind.example']) {
    assert.throws(() => groupPageUrl(base, 'group-a'))
  }
  assert.throws(() => groupPageUrl('https://mind.example', '../group-a'))
})
