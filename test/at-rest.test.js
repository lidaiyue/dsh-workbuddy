import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  deriveAtRestKey,
  deriveAtRestKeyId,
  isEncryptedField,
  openEncryptedField,
} from '../lib/at-rest.js'

const SECRET = '7VmwYJ2pfwziKVU/1nEnIcHZwyfZ+n+b4Atg5cajx8o='

function keyOf(secret) {
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** 按文档里的字段转录手工拼 AAD，避免直接复用实现。 */
function fieldAad(keyId, suite) {
  const uint32 = (value) => {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32BE(value)
    return bytes
  }
  const prefixed = (value) => {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([uint32(bytes.length), bytes])
  }
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    prefixed('WBEV1'),
    prefixed('sym-v1'),
    uint32(suite),
    prefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

function seal(plaintext, key) {
  const keyId = deriveAtRestKeyId(key)
  const nonce = Buffer.from('0123456789ab', 'hex')
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(fieldAad(keyId, 1))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const envelope = Buffer.from(JSON.stringify({
    suite: 1,
    keyId,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }), 'utf8').toString('base64')
  return { $wbEncrypted: 1, envelope }
}

test('isEncryptedField only accepts the app wrapper', () => {
  assert.equal(isEncryptedField({ $wbEncrypted: 1, envelope: 'x' }), true)
  assert.equal(isEncryptedField({ $wbEncrypted: 2, envelope: 'x' }), false)
  assert.equal(isEncryptedField({ $wbEncrypted: 1, envelope: 'x', extra: true }), false)
  assert.equal(isEncryptedField('plain'), false)
  assert.equal(isEncryptedField(null), false)
})

test('deriveAtRestKey hashes the base64 string, not the decoded bytes', () => {
  const derived = deriveAtRestKey(JSON.stringify({ atRestSecretKey: SECRET }))
  assert.deepEqual(derived, keyOf(SECRET))
  assert.notDeepEqual(derived, createHash('sha256').update(Buffer.from(SECRET, 'base64')).digest())
  assert.equal(derived.length, 32)
})

test('deriveAtRestKeyId is the first 16 hex chars of the key digest', () => {
  const key = keyOf(SECRET)
  assert.equal(deriveAtRestKeyId(key), createHash('sha256').update(key).digest('hex').slice(0, 16))
  assert.match(deriveAtRestKeyId(key), /^[0-9a-f]{16}$/u)
})

test('openEncryptedField opens a known envelope and rejects another key', () => {
  const key = keyOf(SECRET)
  const field = seal('token-value', key)
  assert.equal(openEncryptedField(field, key), 'token-value')
  assert.throws(() => openEncryptedField(field, keyOf('other')), /belongs to key/u)
})

test('openEncryptedField refuses a tampered ciphertext', () => {
  const key = keyOf(SECRET)
  const field = seal('token-value', key)
  const envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  ciphertext[0] ^= 0xff
  envelope.ciphertext = ciphertext.toString('base64')
  const tampered = { ...field, envelope: Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') }
  assert.throws(() => openEncryptedField(tampered, key))
})

test('deriveAtRestKey rejects payloads without the secret', () => {
  assert.throws(() => deriveAtRestKey('{}'), /atRestSecretKey/u)
  assert.throws(() => deriveAtRestKey('not json'), /not valid JSON/u)
})
