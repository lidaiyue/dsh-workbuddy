import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  authCandidates,
  chatBaseOf,
  CredentialStore,
  defaultAuthDirs,
  expiryToMs,
  originOf,
  parseAuthDocument,
  regionOf,
} from '../lib/auth.js'

const PLAIN = JSON.stringify({
  auth: {
    accessToken: 'token-1',
    refreshToken: 'refresh-1',
    expiresAt: 1797321236164,
    lastRefreshTime: 1794902036504,
    domain: 'www.codebuddy.cn',
  },
  account: { uid: 'uid-1', uin: '1001', enterpriseId: 'ent-1' },
})

test('parseAuthDocument reads the nested desktop shape', () => {
  const credential = parseAuthDocument(PLAIN, '/tmp/workbuddy-desktop.info')
  assert.equal(credential.accessToken, 'token-1')
  assert.equal(credential.refreshToken, 'refresh-1')
  assert.equal(credential.domain, 'www.codebuddy.cn')
  assert.equal(credential.uid, 'uid-1')
  assert.equal(credential.enterpriseId, 'ent-1')
  assert.equal(credential.expiresAtMs, 1797321236164)
  assert.equal(credential.lastRefreshAtMs, 1794902036504)
})

test('parseAuthDocument reads the flat shape and converts second expiries', () => {
  const credential = parseAuthDocument(JSON.stringify({
    accessToken: 'token-2',
    expiresAt: 1797321236,
    domain: 'www.workbuddy.ai',
  }), '/tmp/flat.info')
  assert.equal(credential.accessToken, 'token-2')
  assert.equal(credential.refreshToken, '')
  assert.equal(credential.expiresAtMs, 1797321236000)
})

test('parseAuthDocument returns undefined without a usable token', () => {
  assert.equal(parseAuthDocument('{}', '/tmp/x'), undefined)
  assert.equal(parseAuthDocument('not json', '/tmp/x'), undefined)
  assert.equal(parseAuthDocument(JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: 'e' } } }), '/tmp/x'), undefined)
})

test('expiryToMs accepts seconds and milliseconds', () => {
  assert.equal(expiryToMs(1797321236), 1797321236000)
  assert.equal(expiryToMs(1797321236164), 1797321236164)
  assert.equal(expiryToMs(0), 0)
  assert.equal(expiryToMs(-5), 0)
})

test('region and gateway follow the credential domain', () => {
  assert.equal(regionOf('www.codebuddy.cn'), 'cn')
  assert.equal(regionOf('copilot.tencent.com'), 'cn')
  assert.equal(regionOf('www.workbuddy.ai'), 'global')
  assert.equal(regionOf('codebuddy.ai'), 'global')
  assert.equal(regionOf(''), 'cn')

  assert.equal(chatBaseOf({ domain: 'www.codebuddy.cn' }), 'https://copilot.tencent.com')
  assert.equal(chatBaseOf({ domain: 'www.workbuddy.ai' }), 'https://www.workbuddy.ai')
  assert.equal(chatBaseOf({ domain: 'www.codebuddy.ai' }), 'https://www.codebuddy.ai')

  assert.equal(originOf({ domain: 'www.codebuddy.cn' }), 'https://www.codebuddy.cn')
  assert.equal(originOf({ domain: 'www.workbuddy.ai' }), 'https://www.workbuddy.ai')
})

test('default auth directories follow the platform', () => {
  assert.deepEqual(defaultAuthDirs('darwin', '/Users/me', {}), [
    '/Users/me/Library/Application Support/CodeBuddyExtension/Data/Public/auth',
  ])
  assert.deepEqual(defaultAuthDirs('linux', '/home/me', { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' }), [
    '/cfg/CodeBuddyExtension/Data/Public/auth',
    '/data/CodeBuddyExtension/Data/Public/auth',
  ])
  assert.deepEqual(defaultAuthDirs('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roaming' }), [
    'C:\\Local\\CodeBuddyExtension\\Data\\Public\\auth',
    'C:\\Roaming\\CodeBuddyExtension\\Data\\Public\\auth',
  ])
})

test('an explicit auth file wins over the platform default', () => {
  assert.deepEqual(authCandidates({ authFile: '/tmp/custom.info' }, 'darwin', '/Users/me', {}), ['/tmp/custom.info'])
  assert.deepEqual(authCandidates({ authFile: '~/custom.info' }, 'darwin', '/Users/me', {}), ['/Users/me/custom.info'])
  assert.deepEqual(
    authCandidates({}, 'darwin', '/Users/me', { WORKBUDDY_AUTH_FILE: '/tmp/env.info' }),
    ['/tmp/env.info'],
  )
  assert.equal(authCandidates({}, 'darwin', '/Users/me', {}).length, 2)
})

test('CredentialStore shares concurrent token refreshes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-auth-'))
  const authFile = join(dir, 'auth.info')
  const now = Date.now()
  await writeFile(authFile, JSON.stringify({
    auth: {
      accessToken: 'old-access',
      refreshToken: 'same-refresh-token',
      expiresAt: now + 1_000,
      domain: 'www.codebuddy.cn',
    },
  }))
  const originalFetch = globalThis.fetch
  let refreshCount = 0
  globalThis.fetch = async () => {
    refreshCount += 1
    await new Promise(resolve => setTimeout(resolve, 20))
    return new Response(JSON.stringify({
      code: 0,
      data: { accessToken: 'new-access', refreshToken: 'rotated-refresh-token', expiresIn: 3600 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const store = new CredentialStore({ authFile })
    const results = await Promise.all([store.current(), store.current(), store.current()])
    assert.equal(refreshCount, 1)
    assert.deepEqual(results.map(credential => credential.accessToken), ['new-access', 'new-access', 'new-access'])
    assert.deepEqual(results.map(credential => credential.refreshToken), ['rotated-refresh-token', 'rotated-refresh-token', 'rotated-refresh-token'])
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})
