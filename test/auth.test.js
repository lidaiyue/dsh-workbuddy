import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { chmod, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { deriveAtRestKeyId } from '../lib/at-rest.js'
import {
  authCandidates,
  chatBaseOf,
  CredentialStore,
  defaultAuthDirs,
  discoverCredential,
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

test('discoverCredential reports a group/world-readable token file once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-auth-mode-'))
  const file = join(dir, 'workbuddy-desktop.info')
  try {
    await writeFile(file, PLAIN, { encoding: 'utf8', mode: 0o644 })
    const discovered = await discoverCredential({ authFile: file })
    assert.equal(discovered.credential.accessToken, 'token-1')
    assert.match(discovered.permissionWarning ?? '', /other users/)
    assert.match(discovered.permissionWarning ?? '', /chmod 600/)

    await chmod(file, 0o600)
    const tightened = await discoverCredential({ authFile: file })
    assert.equal(tightened.permissionWarning, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chatBaseOf trims whitespace around credential domain', () => {
  assert.equal(chatBaseOf({ domain: ' www.codebuddy.ai ' }), 'https://www.codebuddy.ai')
})

test('CredentialStore preserves ABORTED code and avoids unhandled rejections when a shared refresh fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-abort-'))
  const authFile = join(dir, 'auth.info')
  await writeFile(authFile, JSON.stringify({
    auth: {
      accessToken: 'expired-access',
      refreshToken: 'refresh-abort-test',
      expiresAt: Date.now() - 10_000,
      domain: 'www.codebuddy.cn',
    },
  }))
  const originalFetch = globalThis.fetch
  let unhandled = false
  const onUnhandled = () => { unhandled = true }
  process.on('unhandledRejection', onUnhandled)
  globalThis.fetch = async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
    throw new TypeError('network down')
  }
  try {
    const store = new CredentialStore({ authFile })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    await assert.rejects(() => store.current(controller.signal), (error) => error.code === 'ABORTED')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(unhandled, false)

    // Without abort, a transport error during refresh maps to TRANSPORT instead of AUTH.
    await assert.rejects(() => store.current(), (error) => error.code === 'TRANSPORT')
  } finally {
    process.off('unhandledRejection', onUnhandled)
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test('CredentialStore drops cached refresh on sign-out or account switch / re-login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-switch-'))
  const authFile = join(dir, 'auth.info')
  const now = Date.now()
  await writeFile(authFile, JSON.stringify({
    auth: {
      accessToken: 'old-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 1_000,
      lastRefreshTime: now - 10_000,
      domain: 'www.codebuddy.cn',
    },
    account: { uid: 'uid-a' },
  }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 0,
    data: { accessToken: 'refreshed-a', refreshToken: 'rotated-a', expiresIn: 7200 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const store = new CredentialStore({ authFile })
    const first = await store.current()
    assert.equal(first.accessToken, 'refreshed-a')

    // Re-reading while disk is unchanged keeps the in-memory refreshed token.
    const second = await store.current()
    assert.equal(second.accessToken, 'refreshed-a')

    // Re-login into a new account with shorter expiry overrides stale in-memory token.
    await writeFile(authFile, JSON.stringify({
      auth: {
        accessToken: 'new-b',
        refreshToken: 'refresh-b',
        expiresAt: now + 3600_000,
        lastRefreshTime: now + 5_000,
        domain: 'www.workbuddy.ai',
      },
      account: { uid: 'uid-b' },
    }))
    const switched = await store.current()
    assert.equal(switched.accessToken, 'new-b')
    assert.equal(switched.uid, 'uid-b')

    // Deleting the auth file (sign-out) clears cached credentials instead of keeping old session alive.
    await unlink(authFile)
    await assert.rejects(() => store.current(), (error) => error.code === 'AUTH')
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test('discoverCredential clears the cached at-rest key and retries once on key rotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-key-rotate-'))
  const authFile = join(dir, 'auth.info')
  const oldKey = createHash('sha256').update('old-secret', 'utf8').digest()
  const newKey = createHash('sha256').update('new-secret', 'utf8').digest()

  const seal = (plaintext, key) => {
    const keyId = deriveAtRestKeyId(key)
    const nonce = Buffer.from('0123456789ab', 'hex')
    const uint32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b }
    const prefixed = (value) => { const b = Buffer.from(value, 'utf8'); return Buffer.concat([uint32(b.length), b]) }
    const aad = Buffer.concat([
      Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]), prefixed('WBEV1'), prefixed('sym-v1'),
      uint32(1), prefixed(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
    ])
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const envelope = Buffer.from(JSON.stringify({
      suite: 1, keyId, nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }), 'utf8').toString('base64')
    return { $wbEncrypted: 1, envelope }
  }

  try {
    await writeFile(authFile, JSON.stringify({ auth: { accessToken: seal('rotated-token', newKey), domain: 'www.codebuddy.cn' } }), { mode: 0o600 })
    let cleared = 0
    let reads = 0
    const discovered = await discoverCredential({
      authFile,
      readKey: async () => {
        reads += 1
        return reads === 1 ? oldKey : newKey
      },
      clearKeyCache: () => { cleared += 1 },
    })
    assert.equal(cleared, 1)
    assert.equal(reads, 2)
    assert.equal(discovered.credential?.accessToken, 'rotated-token')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
