/**
 * 手动端到端冒烟：真的走一遍 DSH 的 LLM seam 与本机 WorkBuddy 凭据。
 *
 * 不属于 `npm test`（文件名不是 `*.test.js`），因为它会向上游发一次真实请求。
 * 默认用目录里倍率为 0 的模型，并把输出压到几十个 token：
 *
 *   node test/live.mjs
 *   node test/live.mjs deepseek-v4.1-flash   # 指定模型（会产生真实扣费）
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'

import { apply, name } from '../lib/index.js'

const requestedModel = process.argv[2]
const app = new Context()
app.plugin(LlmRuntime)
const logger = { info: console.log, warn: console.warn, debug: () => {} }
app.logger = logger
app.plugin({ name, apply })
await new Promise(resolve => setTimeout(resolve, 100))

const providers = app.llm.listProviders()
console.log('providers:', providers)
if (!providers.some(provider => provider.id === 'workbuddy')) throw new Error('workbuddy provider was not registered')

let models = await app.llm.listModels('workbuddy')
for (let waited = 0; models.length === 0 && waited < 15_000; waited += 500) {
  await new Promise(resolve => setTimeout(resolve, 500))
  models = await app.llm.listModels('workbuddy')
}
console.log('models:', models.length, models.slice(0, 6).map(model => model.id).join(', '))
if (models.length === 0) throw new Error('workbuddy catalog is empty')

const model = requestedModel ?? 'hy4flash-free'
const resolved = await app.llm.resolveModelInfo('workbuddy', model)
console.log('resolved:', JSON.stringify({
  contextWindow: resolved.context?.contextWindow,
  maxTokens: resolved.defaultMaxTokens,
  efforts: resolved.reasoning?.efforts.map(effort => effort.id),
  defaultEffort: resolved.reasoning?.defaultEffort,
}))

const chunks = []
for await (const chunk of app.llm.stream({
  provider: 'workbuddy',
  model,
  messages: [
    createSystemMessage('You are a helpful assistant. Use the provided tool when asked about weather.'),
    createUserMessage({ content: [{ type: 'text', text: 'What is the weather in Beijing? Call get_weather.' }], source: { kind: 'user' } }),
  ],
  tools: [{
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
      additionalProperties: false,
    },
  }],
  maxTokens: 256,
})) {
  chunks.push(chunk)
}

const text = chunks
  .filter(chunk => chunk.type === 'text-delta')
  .map(chunk => chunk.text)
  .join('')
const reasoning = chunks
  .filter(chunk => chunk.type === 'reasoning-delta')
  .map(chunk => chunk.text)
  .join('')
const toolCalls = chunks
  .filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  .map(chunk => chunk.block)
const finish = chunks.at(-1)
console.log('chunks:', chunks.length, 'reasoning chars:', reasoning.length)
console.log('text:', text)
console.log('tool calls:', JSON.stringify(toolCalls))
console.log('finish:', JSON.stringify(finish))
if (finish?.type !== 'finish' || finish.reason.kind === 'error') throw new Error('stream did not finish cleanly')
if (text === '' && reasoning === '' && toolCalls.length === 0) throw new Error('stream carried no content')
for (const call of toolCalls) JSON.parse(call.arguments)

// 第二轮：把工具结果按宿主的方式回传，验证 assistant.tool_calls + tool 消息的序列化。
if (toolCalls.length > 0) {
  const toolMessages = toolCalls.map(call => createToolResultMessage({
    callId: call.id,
    content: [{ type: 'text', text: '{"tempC":21,"sky":"clear"}' }],
    isError: false,
  }))
  const followUp = []
  for await (const chunk of app.llm.stream({
    provider: 'workbuddy',
    model,
    messages: [
      createSystemMessage('You are a helpful assistant. Use the provided tool when asked about weather.'),
      createUserMessage({ content: [{ type: 'text', text: 'What is the weather in Beijing? Call get_weather.' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [
          ...chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block),
        ],
        source: { provider: 'workbuddy', model },
      }),
      ...toolMessages,
    ],
    tools: [{
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
        additionalProperties: false,
      },
    }],
    maxTokens: 256,
  })) {
    followUp.push(chunk)
  }
  const answer = followUp.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  const followFinish = followUp.at(-1)
  console.log('follow-up text:', answer)
  console.log('follow-up finish:', JSON.stringify(followFinish))
  if (followFinish?.type !== 'finish' || followFinish.reason.kind === 'error') throw new Error('follow-up stream did not finish cleanly')
  if (answer === '') throw new Error('follow-up stream produced no text')
}
