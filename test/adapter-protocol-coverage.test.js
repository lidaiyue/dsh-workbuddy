import assert from 'node:assert/strict'
import { test } from 'node:test'

import { streamChunks } from '../lib/adapter.js'
import {
  emptyToolCallsBetweenTextDeltas,
  leadingWhitespaceDelta,
  legacyFunctionCallDeltas,
  narrationThenToolCalls,
  noFinishReasonAtDone,
  normalChatCompletionDeltas,
} from './fixtures/workbuddy-sse-protocols.js'

function sseResponse(frames, { closeStream = true } = {}) {
  let controller
  const body = new ReadableStream({
    start(value) {
      controller = value
      for (const frame of frames) {
        const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      }
      if (closeStream) controller.close()
    },
    cancel() {
      controller = undefined
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(response) {
  const chunks = []
  for await (const chunk of streamChunks(response, { signal: undefined })) chunks.push(chunk)
  return chunks
}

test('compatible Chat Completions stream forwards all text deltas and settles stop', async () => {
  const chunks = await collect(sseResponse(normalChatCompletionDeltas))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '我会先检查问题，然后总结结果。')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('legacy function_call is deliberately ignored by the DSH adapter', async () => {
  const chunks = await collect(sseResponse(legacyFunctionCallDeltas))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '我会先查一下。')
  assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call'), false)
})

test('leading whitespace is emitted rather than trimmed', async () => {
  const chunks = await collect(sseResponse(leadingWhitespaceDelta))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), ' 我会先读取文件。')
})

test('a missing finish_reason maps to a transport finish after [DONE]', async () => {
  const chunks = await collect(sseResponse(noFinishReasonAtDone))
  assert.deepEqual(chunks.at(-1), {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'WorkBuddy stream ended without a finish reason', code: 'TRANSPORT' } },
  })
})

test('the parser publishes text deltas before [DONE] without waiting for stream close', async () => {
  const { COMMIT_VISIBLE_TEXT_AFTER } = await import('../lib/adapter.js')
  const content = '我会先检查问题，然后总结结果。'.repeat(20)
  assert.ok(content.length >= COMMIT_VISIBLE_TEXT_AFTER)
  const response = sseResponse([
    { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
  ], { closeStream: false })
  const iterator = streamChunks(response, { signal: undefined })[Symbol.asyncIterator]()

  try {
    const start = await iterator.next()
    assert.deepEqual(start.value, { type: 'block-start', index: 1, blockType: 'text' })
    const delta = await iterator.next()
    assert.deepEqual(delta.value, { type: 'text-delta', index: 1, text: content })
  } finally {
    await iterator.return()
  }
})

test('empty tool_calls arrays do not close the text block between deltas', async () => {
  const chunks = await collect(sseResponse(emptyToolCallsBetweenTextDeltas))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '当前上下文信息')
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'text').length, 1)
  assert.equal(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text').length, 1)
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text').block, {
    type: 'text',
    text: '当前上下文信息',
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('short narration before tool_calls is folded into reasoning, not visible text', async () => {
  const chunks = await collect(sseResponse(narrationThenToolCalls))
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '')
  assert.equal(
    chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join(''),
    '我先核实一下当前可用的数据通道，再说明能提供什么。',
  )
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start' && chunk.blockType === 'text').length, 0)
  assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'), true)
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})
