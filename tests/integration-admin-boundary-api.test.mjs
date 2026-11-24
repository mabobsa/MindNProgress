import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { storageApi } from './helpers/storage-api-harness.mjs'

// 연동 토큰과 X-MNP-AI-Editor-Id 헤더만으로 관리자 기능에 접근하던 경로(보안 점검 H-2)를 막는다.
test('연동 토큰 요청은 관리자 계정을 지정해도 관리자 기능을 쓰지 못하고 로그인 세션만 허용한다', { timeout: 60000 }, async (t) => {
  const api = await storageApi(t, { documents: 1 })
  const asAdminAi = { 'X-MNP-AI-Editor-Id': 'user-admin' }
  const usersBefore = await readFile(path.join(api.data, '_users.json'), 'utf8')

  const list = await api.call('/api/admin/editors', 'GET', undefined, asAdminAi)
  assert.equal(list.status, 403)
  assert.equal(list.body.code, 'ADMIN_SESSION_REQUIRED')
  assert.equal(list.body.editors, undefined, '계정 목록(이메일 포함)을 돌려주지 않는다')
  assert.equal((await api.call('/api/admin/editors', 'POST', { name: '추가', email: 'added@mind.local' }, asAdminAi)).status, 403)
  assert.equal((await api.call('/api/admin/editors/user-second/reset-password', 'POST', {}, asAdminAi)).status, 403)
  assert.equal((await api.call('/api/admin/editors/user-second', 'PATCH', { mainMachineAllowed: true }, asAdminAi)).status, 403)
  assert.equal((await api.call('/api/admin/editors/user-second', 'DELETE', undefined, asAdminAi)).status, 403)
  assert.equal(await readFile(path.join(api.data, '_users.json'), 'utf8'), usersBefore, '거부된 요청은 계정을 바꾸지 않는다')

  // 관리자 계정을 지정한 AI도 편집자 권한의 일반 API는 그대로 쓴다.
  assert.equal((await api.call('/api/maps', 'GET', undefined, asAdminAi)).status, 200)
  assert.equal((await api.call('/api/auth/me', 'GET', undefined, asAdminAi)).body.user.role, 'admin')

  // 로그인한 관리자는 기존처럼 관리자 기능을 쓴다.
  const login = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'isolated@mind.local', password: 'IsolatedOnly!2026' }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const signedIn = await api.call('/api/admin/editors', 'GET', undefined, { Authorization: '', Cookie: cookie })
  assert.equal(signedIn.status, 200)
  assert.ok(signedIn.body.editors.some((user) => user.id === 'user-second'))
})
