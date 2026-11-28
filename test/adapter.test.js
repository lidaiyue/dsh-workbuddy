import assert from 'node:assert/strict'
import { test } from 'node:test'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import {
  MAX_SSE_BUFFER_BYTES,
  WorkBuddyAdapter,
  messagesWithImages,
  normalizeUsage,
  streamChunks,
  toWireBody,
  toWireMessages,
} from '../lib/adapter.js'
import { WorkBuddyCatalog } from '../lib/catalog.js'

const system = { role: 'system', content: [{ type: 'text', text: 'system prompt' }] }
const user = { role: 'user', content: [{ type: 'text', text: 'hello' }] }
const assistant = {
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'let me check' },
    { type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
  ],
}
const tool = {
  role: 'tool',
  toolCallId: 'call-1',
  content: [{ type: 'text', text: '{"tempC":21}' }],
}

test('model list displays upstream credit multipliers as selector badges', async () => {
  const catalog = {
    whenReady: async () => {},
    current: () => [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', creditMultiplier: 0 },
      { id: 'hy4flash-free', name: 'Hy4 flash', creditMultiplier: 0 },
    ],
  }
  const adapter = new WorkBuddyAdapter({ store: {}, catalog })

  assert.deepEqual(await adapter.listModels('workbuddy'), [{
    provider: 'workbuddy',
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    badge: { text: '0.00x', tone: 'neutral' },
    inputModalities: ['text', 'image'],
  }])
  assert.equal((await adapter.resolveModel('workbuddy', 'hy4flash-free')).badge, undefined)
})

test('toWireMessages maps DSH roles and keeps same-turn reasoning_content only', () => {
  const messages = toWireMessages({ messages: [system, user, assistant, tool] })
  assert.deepEqual(messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'let me check',
      reasoning_content: 'thinking',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: '{"tempC":21}' },
  ])

  // Once a new user turn starts, prior turns drop reasoning_content.
  const nextTurn = toWireMessages({
    messages: [system, user, assistant, tool, { role: 'user', content: [{ type: 'text', text: 'next question' }] }],
  })
  assert.equal(nextTurn[2].reasoning_content, undefined)
})

test('toWireMessages puts the one-shot system prompt first and rewrites developer roles', () => {
  const messages = toWireMessages({
    system: 'one-shot system',
    messages: [
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'x' }] },
      { role: 'developer', content: [{ type: 'text', text: 'dev note' }] },
      user,
    ],
  })
  assert.deepEqual(messages, [
    { role: 'system', content: 'one-shot system' },
    { role: 'system', content: 'dev note' },
    { role: 'user', content: 'hello' },
  ])
})

test('toWireMessages skips assistant messages with neither text nor tool calls', () => {
  const messages = toWireMessages({ messages: [{ role: 'assistant', content: [] }, user] })
  assert.deepEqual(messages, [{ role: 'user', content: 'hello' }])
})

test('toWireBody sends tools, limits and reasoning effort without mutating the input schema', () => {
  const parameters = {
    type: 'object',
    properties: { tuple: { items: [{ type: 'string' }] } },
  }
  const options = {
    model: 'glm-5.3',
    messages: [system, user],
    tools: [
      { name: 't', description: 'd', parameters },
      { name: 'deferred_tool', description: 'hidden', parameters: { type: 'object' }, deferLoading: true },
    ],
    maxTokens: 128,
    temperature: 0.2,
    stop: ['END'],
    reasoningEffort: 'high',
  }
  const body = toWireBody(options)
  assert.equal(body.model, 'glm-5.3')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 128)
  assert.equal(body.temperature, 0.2)
  assert.deepEqual(body.stop, ['END'])
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tools.length, 1)
  assert.deepEqual(body.tools[0].function.parameters.properties.tuple, { prefixItems: [{ type: 'string' }], items: {} })
  // 原 schema 属于宿主，可能被冻结；规范化只能改克隆出来的副本。
  assert.deepEqual(parameters, { type: 'object', properties: { tuple: { items: [{ type: 'string' }] } } })
})

test('toWireBody forceNeutral prepends the neutral head to every scanned message', () => {
  const body = toWireBody({
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness' }] },
      user,
    ],
  }, { forceNeutral: true })
  assert.ok(body.messages[0].content.startsWith('You are a helpful assistant.\n\n'))
  assert.equal(body.messages[1].content, 'hello')
})

test('normalizeUsage subtracts cached prompt tokens and forwards reasoning tokens', () => {
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 97,
    completion_tokens: 64,
    total_tokens: 161,
    prompt_tokens_details: { cached_tokens: 7 },
    completion_tokens_details: { reasoning_tokens: 32 },
  }), {
    inputTokens: 90,
    outputTokens: 64,
    totalTokens: 161,
    cacheReadTokens: 7,
    reasoningTokens: 32,
  })
  assert.equal(normalizeUsage(null), undefined)
})

function sseResponse(chunks) {
  const text = chunks.map(chunk => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(response, options = { signal: undefined }) {
  const out = []
  for await (const chunk of streamChunks(response, options)) out.push(chunk)
  return out
}

test('streamChunks translates reasoning, text, tool calls, usage and finish', async () => {
  const chunks = await collect(sseResponse([
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think ' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'more' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '' }, index: 0 }] },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ function: { arguments: '{"city":"Beijing"}' }, index: 0 }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    '[DONE]',
  ]))

  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start').map(chunk => [chunk.index, chunk.blockType]), [
    [0, 'reasoning'],
    [1, 'text'],
    [2, 'tool-call'],
  ])
  assert.equal(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join(''), 'think more')
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'hello world')
  assert.ok(chunks.findIndex(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    < chunks.findIndex(chunk => chunk.type === 'text-delta'))
  assert.ok(chunks.findIndex(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
    < chunks.findIndex(chunk => chunk.type === 'tool-call-delta'))
  const toolDeltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
  assert.equal(toolDeltas.length, 1)
  assert.equal(toolDeltas[0].id, 'call-1')
  assert.equal(toolDeltas[0].name, 'get_weather')
  assert.equal(toolDeltas[0].argumentsDelta, '{"city":"Beijing"}')

  const ends = chunks.filter(chunk => chunk.type === 'block-end')
  assert.deepEqual(ends.map(chunk => chunk.block), [
    { type: 'reasoning', text: 'think more' },
    { type: 'text', text: 'hello world' },
    { type: 'tool-call', id: 'call-1', name: 'get_weather', arguments: '{"city":"Beijing"}' },
  ])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('streamChunks stops on [DONE] even when the upstream leaves SSE open', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
    },
  })
  const chunks = await collect(new Response(body), { signal: undefined })
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'done')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('streamChunks keeps late tool metadata consistent with buffered arguments', async () => {
  const chunks = await collect(sseResponse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'real-call', function: { name: 'lookup', arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
  ]))
  const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
  assert.deepEqual(deltas, [{ type: 'tool-call-delta', index: 2, id: 'real-call', name: 'lookup', argumentsDelta: '{"x":1}' }])
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-end').at(-1).block, {
    type: 'tool-call', id: 'real-call', name: 'lookup', arguments: '{"x":1}',
  })
})

test('streamChunks maps a length stop to max-tokens', async () => {
  const chunks = await collect(sseResponse([
    { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  ]))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('streamChunks reports a missing upstream finish reason as an error', async () => {
  const chunks = await collect(sseResponse([
    { choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] },
    '[DONE]',
  ]))
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'WorkBuddy stream ended without a finish reason', code: 'TRANSPORT' } },
  })
})

test('streamChunks rejects an empty stream', async () => {
  await assert.rejects(collect(sseResponse(['[DONE]'])), (error) => error.code === 'EMPTY_RESPONSE')
})

test('streamChunks refuses an upstream that never ends a line', async () => {
  const body = new ReadableStream({
    start(controller) {
      // No newline anywhere: without a cap this grows until the process dies.
      controller.enqueue(new TextEncoder().encode('data: {"choices":['))
      controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_SSE_BUFFER_BYTES + 1)))
      controller.close()
    },
  })
  await assert.rejects(
    () => collect(new Response(body), { signal: undefined }),
    (error) => error.code === 'MALFORMED_RESPONSE'
  )
})

test('a frame split across chunks that does end is still parsed', async () => {
  const body = new ReadableStream({
    start(controller) {
      const text = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
      const at = Math.floor(text.length / 2)
      controller.enqueue(new TextEncoder().encode(text.slice(0, at)))
      controller.enqueue(new TextEncoder().encode(text.slice(at)))
      controller.close()
    },
  })
  const chunks = await collect(new Response(body), { signal: undefined })
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'ok')
})

test('streamChunks allocates fresh block indices after closing blocks so BlockAssembler keeps all content', async () => {
  const chunks = await collect(sseResponse([
    { choices: [{ index: 0, delta: { reasoning_content: 'first-think' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'first-text' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'second-think' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'trailing-text' }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]))

  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const blocks = assembler.blocks()
  assert.deepEqual(blocks.map(block => block.type), ['reasoning', 'text', 'tool-call', 'reasoning', 'text'])
  assert.equal(blocks[0].text, 'first-think')
  assert.equal(blocks[1].text, 'first-text')
  assert.equal(blocks[3].text, 'second-think')
  assert.equal(blocks[4].text, 'trailing-text')
})

test('streamChunks wraps mid-stream transport and abort errors as LlmError', async () => {
  const broken = new ReadableStream({
    pull() {
      throw new TypeError('socket terminated')
    },
  })
  await assert.rejects(
    () => collect(new Response(broken), { signal: undefined }),
    (error) => error.code === 'TRANSPORT'
  )

  const controller = new AbortController()
  const aborting = new ReadableStream({
    pull() {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    },
  })
  await assert.rejects(
    () => collect(new Response(aborting), { signal: controller.signal }),
    (error) => error.code === 'ABORTED'
  )
})

test('resolveModel honors AbortSignal while waiting for catalog readiness', async () => {
  const catalog = new WorkBuddyCatalog()
  const adapter = new WorkBuddyAdapter({ store: {}, catalog })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 15)
  await assert.rejects(
    () => adapter.resolveModel('workbuddy', 'deepseek-v4.1-flash', controller.signal),
    (error) => error.code === 'ABORTED'
  )
})

test('messagesWithImages encodes inline and stored images and rejects empty or failed attachments cleanly', async () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  let readCount = 0
  const attachments = {
    async readImageRequest(ref) {
      readCount += 1
      return { mediaType: ref.mediaType, data: pngBytes }
    },
  }
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', offloaded: true, attachment: { attachmentId: 'off-1', name: 'old.png', mediaType: 'image/png' } },
      { type: 'image', data: pngBytes.toString('base64'), mediaType: 'image/png' },
      { type: 'image', attachment: { attachmentId: 'att-1', name: 'a.png', mediaType: 'image/png', width: 10, height: 10, bytes: 4 } },
      { type: 'image', attachment: { attachmentId: 'att-1', name: 'a.png', mediaType: 'image/png', width: 10, height: 10, bytes: 4 } },
    ],
  }]
  const resolved = await messagesWithImages(messages, attachments, 'workbuddy', 'deepseek-v4.1-flash', undefined, (_p, _m, ref) => ref)
  assert.equal(readCount, 1)
  assert.equal(resolved[0].content[0].type, 'text')
  assert.match(resolved[0].content[0].text, /old\.png/)
  assert.equal(resolved[0].content[1].type, 'image_url')
  assert.equal(resolved[0].content[2].image_url.url, resolved[0].content[3].image_url.url)

  await assert.rejects(
    () => messagesWithImages([{ role: 'user', content: [{ type: 'image', data: '', mediaType: 'image/png' }] }], attachments, 'workbuddy', 'm', undefined, () => ({})),
    (error) => error.code === 'UNSUPPORTED_CONTENT'
  )

  const failingAttachments = {
    async readImage() {
      const err = new Error('disk missing')
      err.code = ''
      throw err
    },
  }
  await assert.rejects(
    () => messagesWithImages([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png' } }] }], failingAttachments, 'workbuddy', 'm', undefined, () => ({})),
    (error) => error.code === 'INVALID_REQUEST'
  )
})

test('resolveModel exposes catalog defaultEffort when declared', async () => {
  const catalog = {
    whenReady: async () => {},
    current: () => [{
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek-V4.1-Flash',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    }],
  }
  const adapter = new WorkBuddyAdapter({ store: {}, catalog })
  const resolved = await adapter.resolveModel('workbuddy', 'deepseek-v4.1-flash')
  assert.equal(resolved.reasoning.defaultEffort, 'high')
  assert.deepEqual(resolved.reasoning.efforts.map(e => e.id), ['low', 'high', 'max'])
})

test('WorkBuddyAdapter.stream tries system-only neutral head before assistant on 11128 and maps fetch failures to TRANSPORT', async () => {
  const originalFetch = globalThis.fetch
  const bodies = []
  const headersList = []
  let calls = 0
  const adapter = new WorkBuddyAdapter({
    store: {
      async current() {
        return { accessToken: 'tok', domain: 'www.codebuddy.cn', uid: 'u1' }
      },
    },
    catalog: new WorkBuddyCatalog(),
  })

  globalThis.fetch = async (_url, init) => {
    calls += 1
    bodies.push(JSON.parse(init.body))
    headersList.push(init.headers)
    if (calls === 1) {
      return new Response(JSON.stringify({ code: 11128, msg: 'blocked' }), { status: 400 })
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: 'stop' }] },
      '[DONE]',
    ])
  }
  try {
    const out = []
    for await (const chunk of adapter.stream({
      provider: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      sessionId: 'sess-stable-1',
      messages: [system, user, { role: 'assistant', content: [{ type: 'text', text: 'prior reply' }] }, user],
    })) {
      out.push(chunk)
    }
    assert.equal(calls, 2)
    assert.equal(bodies[0].messages[0].content, 'system prompt')
    assert.ok(bodies[1].messages[0].content.startsWith('You are a helpful assistant.\n\n'))
    // First 11128 retry keeps historical assistant messages untouched.
    assert.equal(bodies[1].messages[2].content, 'prior reply')
    // Same sessionId produces a stable X-Conversation-ID across requests.
    assert.equal(headersList[0]['X-Conversation-ID'], headersList[1]['X-Conversation-ID'])
    assert.equal(out.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'recovered')

    globalThis.fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({ provider: 'workbuddy', model: 'deepseek-v4.1-flash', messages: [user] })) {}
    }, (error) => error.code === 'TRANSPORT')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('WorkBuddyAdapter.stream forces one token refresh on HTTP 401 and fails with TIMEOUT when idle', async () => {
  const originalFetch = globalThis.fetch
  let refreshed = 0
  let authHeaders = []
  const adapter = new WorkBuddyAdapter({
    store: {
      async current() {
        return { accessToken: 'stale-tok', refreshToken: 'ref-1', domain: 'www.codebuddy.cn', uid: 'u1' }
      },
      async forceRefresh(stale) {
        refreshed += 1
        return { ...stale, accessToken: 'fresh-tok' }
      },
    },
    catalog: new WorkBuddyCatalog(),
    streamIdleTimeoutMs: 30,
  })

  globalThis.fetch = async (_url, init) => {
    authHeaders.push(init.headers.Authorization)
    if (authHeaders.length === 1) {
      return new Response(JSON.stringify({ msg: 'expired' }), { status: 401 })
    }
    return sseResponse([
      { choices: [{ index: 0, delta: { content: 'after-refresh' }, finish_reason: 'stop' }] },
      '[DONE]',
    ])
  }
  try {
    const out = []
    for await (const chunk of adapter.stream({ provider: 'workbuddy', model: 'deepseek-v4.1-flash', messages: [user] })) {
      out.push(chunk)
    }
    assert.equal(refreshed, 1)
    assert.deepEqual(authHeaders, ['Bearer stale-tok', 'Bearer fresh-tok'])
    assert.equal(out.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'after-refresh')

    // A stalled SSE body trips the idle watchdog with TIMEOUT.
    globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), { status: 200 })
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({ provider: 'workbuddy', model: 'deepseek-v4.1-flash', messages: [user] })) {}
    }, (error) => error.code === 'TIMEOUT')
  } finally {
    globalThis.fetch = originalFetch
  }
})
