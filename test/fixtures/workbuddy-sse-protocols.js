/**
 * Synthetic WorkBuddy-compatible SSE patterns used to lock parser expectations.
 * These are not captured upstream responses; keep that distinction explicit.
 */
export const normalChatCompletionDeltas = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '我会' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: '先检查问题，然后总结结果。' }, finish_reason: 'stop' }] },
  '[DONE]',
]

export const noFinishReasonAtDone = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '我会继续处理' }, finish_reason: null }] },
  '[DONE]',
]

export const leadingWhitespaceDelta = [
  { choices: [{ index: 0, delta: { content: ' ' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: '我会先读取文件。' }, finish_reason: 'stop' }] },
  '[DONE]',
]

export const legacyFunctionCallDeltas = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '我会先查一下。' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { function_call: { name: 'lookup', arguments: '{"q":' } }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { function_call: { arguments: '"weather"}' } }, finish_reason: 'function_call' }] },
  '[DONE]',
]

export const emptyToolCallsBetweenTextDeltas = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '当前', tool_calls: [] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: '上下文', tool_calls: [] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { content: '信息', tool_calls: [] }, finish_reason: 'stop' }] },
  '[DONE]',
]

export const narrationThenToolCalls = [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '我先核实一下当前可用的数据通道，再说明能提供什么。', tool_calls: [] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'invest_search', arguments: '{}' }, index: 0 }] }, finish_reason: 'tool_calls' }] },
  '[DONE]',
]
