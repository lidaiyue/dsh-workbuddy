import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  WorkBuddyAdapter,
  normalizeUsage,
  streamChunks,
  toWireBody,
  toWireMessages,
} from '../lib/adapter.js'

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

test('toWireMessages maps DSH roles to chat-completions messages', () => {
  const messages = toWireMessages({ messages: [system, user, assistant, tool] })
  assert.deepEqual(messages, [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'let me check',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: '{"tempC":21}' },
  ])
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
    tools: [{ name: 't', description: 'd', parameters }],
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
    [2, 'tool-call'],
  ])
  assert.equal(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join(''), 'think morehello world')
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '')
  assert.ok(chunks.findIndex(chunk => chunk.type === 'block-end' && chunk.block.type === 'reasoning')
    < chunks.findIndex(chunk => chunk.type === 'tool-call-delta'))
  const toolDeltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
  assert.equal(toolDeltas.length, 1)
  assert.equal(toolDeltas[0].id, 'call-1')
  assert.equal(toolDeltas[0].name, 'get_weather')
  assert.equal(toolDeltas[0].argumentsDelta, '{"city":"Beijing"}')

  const ends = chunks.filter(chunk => chunk.type === 'block-end')
  assert.deepEqual(ends.map(chunk => chunk.block), [
    { type: 'reasoning', text: 'think morehello world' },
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
