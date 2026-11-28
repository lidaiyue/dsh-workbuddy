import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  businessCodeOf,
  conversationIdOf,
  ensureSystemHead,
  failureOf,
  failureMessageOf,
  forceNeutralHead,
  NEUTRAL_SYSTEM_HEAD,
  normalizeToolSchemas,
  prepareMessages,
  rewriteChannelPhrases,
} from '../lib/upstream.js'

const DSH_PROMPT = 'You are an AI agent powered by DeepSeek Harness.\n'
  + 'You are a coding agent powered by the deepseek-flash model.\n'
  + 'You are interacting with the user through the DeepSeek Harness Web GUI.\n'
  + 'Tokens prefixed with @ are paths the user explicitly referenced.'

test('rewriteChannelPhrases rewrites DSH identity wording and is idempotent', () => {
  const once = rewriteChannelPhrases(DSH_PROMPT)
  assert.ok(!once.includes('You are an AI agent powered by DeepSeek Harness'))
  assert.ok(once.includes('You are an AI agent running inside DeepSeek Harness'))
  assert.ok(once.includes('You are a coding agent running on the deepseek-flash model'))
  assert.ok(once.includes('You are working with the user inside the DeepSeek Harness Web GUI'))
  assert.ok(once.includes('Paths that begin with @ are the ones the user explicitly referenced.'))
  assert.equal(rewriteChannelPhrases(once), once)
})

test('prepareMessages adds a system head and leaves user text alone', () => {
  const messages = [
    { role: 'user', content: 'You are an AI agent powered by DeepSeek Harness' },
    { role: 'assistant', content: 'You are a coding agent powered by the model' },
  ]
  prepareMessages(messages)
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, NEUTRAL_SYSTEM_HEAD)
  assert.equal(messages[1].content, 'You are an AI agent powered by DeepSeek Harness')
  assert.ok(messages[2].content.startsWith('You are a coding agent running on the model'))
})

test('prepareMessages keeps an existing system head byte for byte when nothing matches', () => {
  const messages = [
    { role: 'system', content: 'ordinary prompt' },
    { role: 'user', content: 'hello' },
  ]
  prepareMessages(messages)
  assert.deepEqual(messages, [
    { role: 'system', content: 'ordinary prompt' },
    { role: 'user', content: 'hello' },
  ])
})

test('forceNeutralHead prepends once per scanned message', () => {
  const messages = [
    { role: 'system', content: 'blocked opening' },
    { role: 'assistant', content: 'blocked too' },
    { role: 'user', content: 'untouched' },
  ]
  forceNeutralHead(messages)
  assert.equal(messages[0].content, `${NEUTRAL_SYSTEM_HEAD}\n\nblocked opening`)
  assert.equal(messages[1].content, `${NEUTRAL_SYSTEM_HEAD}\n\nblocked too`)
  assert.equal(messages[2].content, 'untouched')
  const before = messages.map(message => message.content)
  forceNeutralHead(messages)
  assert.deepEqual(messages.map(message => message.content), before)
})

test('ensureSystemHead only acts when the conversation does not open with system', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  ensureSystemHead(messages)
  assert.equal(messages[0].role, 'system')
  const already = [{ role: 'system', content: 'x' }]
  ensureSystemHead(already)
  assert.equal(already.length, 1)
})

test('businessCodeOf reads compact, spaced, string and nested codes', () => {
  assert.equal(businessCodeOf('{"code":11128,"msg":"x"}'), 11128)
  assert.equal(businessCodeOf('{"code": 11115}'), 11115)
  assert.equal(businessCodeOf('{"code":"14018"}'), 14018)
  assert.equal(businessCodeOf('{"error":{"data":{"code":11129}}}'), 11129)
  assert.equal(businessCodeOf('plain text without a code'), undefined)
})

test('failureMessageOf prefers the localized display message', () => {
  const body = JSON.stringify({
    code: 11128,
    msg: 'Illegal API invocation',
    displayMsg: { zh: '请求被拦截，请重新发送', en: 'Request blocked' },
  })
  assert.equal(failureMessageOf(body, 'fallback'), '请求被拦截，请重新发送')
  assert.equal(failureMessageOf('', 'fallback'), 'fallback')
})

function response(status, body = '', headers = {}) {
  return new Response(body, { status, headers })
}

test('failureOf maps gateway business codes to host failure classes', () => {
  assert.equal(failureOf(response(400, '{"code":11128}'), '{"code":11128}').code, 'CHANNEL_REJECTED')
  assert.equal(failureOf(response(400, '{"code":11115}'), '{"code":11115}').code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(failureOf(response(400, '{"code":11129}'), '{"code":11129}').code, 'INVALID_REQUEST')
  assert.equal(failureOf(response(400, '{"code":11140}'), '{"code":11140}').code, 'CONTENT_REFUSED')
  assert.equal(failureOf(response(400, '{"code":14018}'), '{"code":14018}').code, 'QUOTA')
  assert.equal(failureOf(response(500, '{"code":14003}'), '{"code":14003}').code, 'RATE_LIMIT')
  assert.equal(failureOf(response(401, '{}'), '{}').code, 'AUTH')
  assert.equal(failureOf(response(429, '{}'), '{}').code, 'RATE_LIMIT')
  assert.equal(failureOf(response(502, '<html>'), '<html>').code, 'TRANSPORT')
  assert.equal(failureOf(response(400, '{}'), '{}').code, 'INVALID_REQUEST')
})

test('failureOf carries Retry-After on failures (seconds and HTTP-date)', () => {
  const failure = failureOf(response(429, '{}', { 'retry-after': '3' }), '{}')
  assert.equal(failure.providerRetryAfterMs, 3000)

  const future = new Date(Date.now() + 10_000).toUTCString()
  const dated = failureOf(response(429, '{}', { 'retry-after': future }), '{}')
  assert.ok(dated.providerRetryAfterMs > 0 && dated.providerRetryAfterMs <= 11_000)
})

test('normalizeToolSchemas rewrites the refused draft-4 spellings', () => {
  const tools = [{
    type: 'function',
    function: {
      name: 't',
      parameters: {
        type: 'object',
        properties: {
          tuple: { items: [{ type: 'string' }] },
          closedTuple: { items: [{ type: 'string' }], additionalItems: false },
          bounded: { type: 'number', minimum: 0, exclusiveMinimum: true },
          unanchored: { type: 'number', exclusiveMaximum: true },
          external: { $ref: 'https://example.com/schema.json' },
          internal: { $ref: '#/$defs/x' },
          rootRef: { $ref: '#' },
          list: { type: 'object', required: 'a' },
          duplicates: { type: 'object', required: ['a', 'a'] },
        },
      },
    },
  }]
  normalizeToolSchemas(tools)
  const schema = tools[0].function.parameters.properties
  assert.deepEqual(schema.tuple, { prefixItems: [{ type: 'string' }], items: {} })
  assert.deepEqual(schema.closedTuple, { prefixItems: [{ type: 'string' }], items: false })
  assert.equal(schema.bounded.exclusiveMinimum, 0)
  assert.equal(schema.bounded.minimum, undefined)
  assert.equal(schema.unanchored.exclusiveMaximum, undefined)
  assert.equal(schema.external.$ref, undefined)
  assert.equal(schema.internal.$ref, '#/$defs/x')
  assert.equal(schema.rootRef.$ref, '#')
  assert.deepEqual(schema.list.required, ['a'])
  assert.deepEqual(schema.duplicates.required, ['a'])
})

test('conversationIdOf derives a stable UUID per sessionId and preserves UUID inputs', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000'
  assert.equal(conversationIdOf(uuid), uuid)
  const a = conversationIdOf('session-alpha')
  const b = conversationIdOf('session-alpha')
  const c = conversationIdOf('session-beta')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
})
