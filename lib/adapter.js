/**
 * WorkBuddy 的 DSH LLM 适配器。
 *
 * 只做三件事：把 DSH 的消息/工具翻译成 OpenAI chat-completions 请求体、把上游
 * 的 SSE 翻译成 `StreamChunk`、把失败翻译成 `LlmError`。凭据与目录由
 * `auth.js` / `catalog.js` 提供。
 *
 * 图片模型通过宿主附件服务读取并转成 OpenAI 兼容的 image_url 内容块；文件由
 * 宿主投影为文本。其余内容在这里翻译成 text / tool 请求字段。
 *
 * @module dsh-workbuddy/adapter
 */

import { Buffer } from 'node:buffer'

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

import { failureOf, normalizeToolSchemas, postChat, prepareMessages } from './upstream.js'

/** 本插件占用的 provider 路由。 */
export const WORKBUDDY_PROVIDER = 'workbuddy'

/** 目录未知时给已有会话的兜底能力；不会出现在模型选择器里。 */
const FALLBACK_CONTEXT_WINDOW = 1_000_000
const FALLBACK_MAX_TOKENS = 32_000

/** 解析模型时最多等首次目录刷新多久（本地网络通常几十毫秒）。 */
const CATALOG_READY_WAIT_MS = 5_000

/** 流式响应单次等待空闲超时（与官方 dsh-llm-deepseek 一致：5 分钟）。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

function toTransportError(error, signal, label, timedOut = false) {
  if (timedOut) return new LlmError(`WorkBuddy ${label} timed out`, 'TIMEOUT', { cause: error })
  if (signal?.aborted) return new LlmError('WorkBuddy request aborted', 'ABORTED', { cause: error })
  if (error instanceof LlmError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new LlmError(`WorkBuddy ${label} failed: ${detail}`, 'TRANSPORT', { cause: error })
}

function createIdleWatchdog(parentSignal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  let timer
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const pulse = () => {
    clear()
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
  }
  const signal = parentSignal === undefined
    ? controller.signal
    : AbortSignal.any([parentSignal, controller.signal])
  pulse()
  return {
    signal,
    pulse,
    get timedOut() { return timedOut },
    dispose() {
      clear()
      controller.abort()
    },
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'reasoning' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

function toolCallsOf(content) {
  return Array.isArray(content) ? content.filter(block => block?.type === 'tool-call') : []
}

const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function imageCapableOf(model) {
  const identity = `${model.id} ${model.name}`.toLowerCase().replace(/[^a-z0-9]+/gu, '-')
  // DeepSeek V4.1 Flash accepts images even when a fallback/omitted catalog entry
  // lacks supportsImages.
  return model.supportsImages === true || /deepseek-v4(?:-1)?-flash(?:-|$)/u.test(identity)
}

function contentOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  let hasImage = false
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push({ type: 'text', text: block.text })
    } else if (block?.type === 'image_url' && typeof block.image_url?.url === 'string') {
      parts.push({ type: 'image_url', image_url: { url: block.image_url.url } })
      hasImage = true
    }
  }
  return hasImage ? parts : textOf(content)
}

function imageDataUrl(data, mediaType) {
  if (!IMAGE_MEDIA_TYPES.has(mediaType) || data === undefined || data === null) return undefined
  const bytes = Buffer.from(data)
  if (bytes.length === 0) return undefined
  return `data:${mediaType};base64,${bytes.toString('base64')}`
}

function imageLabel(attachment) {
  return attachment?.name || attachment?.attachmentId || 'unknown attachment'
}

export async function messagesWithImages(messages, attachments, provider, model, signal, imageRequestTarget) {
  if (!Array.isArray(messages)) return messages
  const cache = new Map()
  let changed = false
  const result = []

  for (const message of messages) {
    if (!Array.isArray(message?.content) || !message.content.some(block => block?.type === 'image')) {
      result.push(message)
      continue
    }
    if (!['system', 'developer', 'user', 'tool'].includes(message.role)) {
      throw new LlmError('WorkBuddy accepts image attachments in system, developer, user, and tool messages', 'UNSUPPORTED_CONTENT')
    }

    const content = []
    for (const block of message.content) {
      if (block?.type !== 'image') {
        content.push(block)
        continue
      }
      changed = true
      if (block.offloaded === true) {
        content.push({
          type: 'text',
          text: `[image omitted to fit request limits; ${imageLabel(block.attachment)}]`,
        })
        continue
      }

      let dataUrl
      if (typeof block.data === 'string') {
        const trimmed = block.data.trim()
        dataUrl = trimmed === '' ? undefined : imageDataUrl(Buffer.from(trimmed, 'base64'), block.mediaType)
      } else {
        const attachment = block.attachment
        if (attachment === undefined || attachments === undefined || attachments === null) {
          throw new LlmError(`WorkBuddy cannot read image attachment ${imageLabel(attachment)}: attachment storage is unavailable`, 'UNSUPPORTED_CONTENT')
        }
        const cacheKey = typeof attachment.attachmentId === 'string' && attachment.attachmentId !== ''
          ? attachment.attachmentId
          : undefined
        if (cacheKey !== undefined && cache.has(cacheKey)) {
          dataUrl = cache.get(cacheKey)
        } else {
          try {
            const target = imageRequestTarget(provider, model, attachment)
            const stored = typeof attachments.readImageRequest === 'function'
              ? await attachments.readImageRequest(attachment, target, signal)
              : await attachments.readImage(attachment, signal)
            const mediaType = stored?.mediaType ?? stored?.ref?.mediaType ?? attachment.mediaType
            dataUrl = imageDataUrl(stored?.data, mediaType)
            if (cacheKey !== undefined) cache.set(cacheKey, dataUrl)
          } catch (error) {
            if (signal?.aborted) throw new LlmError('WorkBuddy request aborted', 'ABORTED', { cause: error })
            if (error instanceof LlmError) throw error
            const detail = error instanceof Error ? error.message : String(error)
            throw new LlmError(`WorkBuddy could not read image attachment ${imageLabel(attachment)}: ${detail}`, 'INVALID_REQUEST', { cause: error })
          }
        }
      }
      if (dataUrl === undefined) {
        throw new LlmError(`WorkBuddy cannot encode image attachment ${imageLabel(block.attachment)}: unsupported image data`, 'UNSUPPORTED_CONTENT')
      }
      content.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
    result.push({ ...message, content })
  }
  return changed ? result : messages
}

/**
 * 把一次 `GenerateOptions` 的消息列表翻译成 chat-completions 的 `messages`。
 *
 * `developer` 消息在 WorkBuddy 上会被 11128 拒绝，所以映射成 `system`；只带
 * 工具声明增删的 developer 消息没有可发的正文，直接略过（工具由 `tools` 全量
 * 声明）。
 *
 * 当前 user 轮次内（最后一条 `user` 之后）的工具调用循环会保留 `assistant` 的
 * `reasoning_content`，让 DeepSeek 等思考模型连续推理而非每步重头思考；更早
 * 轮次的 `reasoning_content` 按 DeepSeek 规范省略以节省上下文。
 */
export function toWireMessages(options) {
  const messages = []
  if (typeof options.system === 'string' && options.system !== '') {
    messages.push({ role: 'system', content: options.system })
  }
  const input = Array.isArray(options.messages) ? options.messages : []
  let lastUserIndex = -1
  for (let i = input.length - 1; i >= 0; i -= 1) {
    if (input[i]?.role === 'user') {
      lastUserIndex = i
      break
    }
  }
  for (const [index, message] of input.entries()) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: contentOf(message.content) })
        break
      case 'user':
        messages.push({ role: 'user', content: contentOf(message.content) })
        break
      case 'developer': {
        const content = contentOf(message.content)
        if (content !== '' && (!Array.isArray(content) || content.length > 0)) {
          messages.push({ role: 'system', content })
        }
        break
      }
      case 'assistant': {
        const content = textOf(message.content)
        const calls = toolCallsOf(message.content)
        const reasoning = index > lastUserIndex ? reasoningOf(message.content) : ''
        if (content === '' && calls.length === 0 && reasoning === '') break
        messages.push({
          role: 'assistant',
          content,
          ...reasoning === '' ? {} : { reasoning_content: reasoning },
          ...calls.length === 0 ? {} : {
            tool_calls: calls.map(call => ({
              id: String(call.id),
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          },
        })
        break
      }
      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: String(message.toolCallId ?? message.source?.callId ?? ''),
          content: contentOf(message.content),
        })
        break
      default:
        break
    }
  }
  return messages
}

/** 组装一次请求体；`forceNeutral` 用于 11128 之后的那一次重试。 */
export function toWireBody(options, { forceNeutral = false } = {}) {
  const body = {
    model: options.model,
    messages: toWireMessages(options),
    stream: true,
  }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    const activeTools = options.tools.filter(tool => tool?.deferLoading !== true)
    if (activeTools.length > 0) {
      body.tools = normalizeToolSchemas(activeTools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: structuredClone(tool.parameters),
        },
      })))
    }
  }
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) body.max_tokens = options.maxTokens
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') {
    body.reasoning_effort = options.reasoningEffort
  }
  prepareMessages(body.messages, { forceNeutral })
  return body
}

/** 上游 usage → 宿主的 `TokenUsage`（缓存命中从输入里扣掉）。 */
export function normalizeUsage(usage) {
  if (typeof usage !== 'object' || usage === null) return undefined
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const cached = typeof usage.cache_read_input_tokens === 'number' && usage.cache_read_input_tokens > 0
    ? usage.cache_read_input_tokens
    : typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : typeof usage.cached_tokens === 'number'
        ? usage.cached_tokens
        : 0
  const reasoning = typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
    ? usage.completion_tokens_details.reasoning_tokens
    : undefined
  const normalized = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
    ...typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {},
    ...cached > 0 ? { cacheReadTokens: cached } : {},
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
  return normalized
}

function firstReasoningDelta(delta) {
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    const value = delta?.[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** `finish_reason` → 宿主的 `FinishReason`。 */
function finishReasonOf(reason, hasToolCalls) {
  if (reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'error') return { kind: 'error', failure: { message: 'WorkBuddy reported an error finish reason', code: 'TRANSPORT' } }
  if (hasToolCalls && (reason === undefined || reason === null)) return { kind: 'tool-calls' }
  if (reason === 'stop') return { kind: 'stop' }
  return { kind: 'error', failure: { message: 'WorkBuddy stream ended without a finish reason', code: 'TRANSPORT' } }
}

/**
 * How much of an unfinished SSE line may sit in memory. A well-formed stream
 * ends every line, so a buffer past this means the upstream is sending a single
 * unbroken record (or garbage) and the turn must fail instead of growing.
 */
export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024

/**
 * 把上游 SSE 原样翻译成 `StreamChunk`。
 *
 * 与宿主自带 `dsh-llm-deepseek` 及 `dsh-acp-client` 保持一致：不缓冲也不改写
 * 正文与思考块的语义，按到达顺序即时透传 `reasoning` / `text` / `tool-call`，
 * 折叠展示完全交由官方 `TurnProcessNodeView` 与用户的 `foldedReplies` 策略控制。
 * 首次块索引使用 reasoning=0、text=1、tool-call=2+，已关闭块再次出现时分配新索引。
 */
export async function * streamChunks(response, options) {
  if (response.body === null) throw new LlmError('WorkBuddy returned no response body', 'EMPTY_RESPONSE')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const reasoning = { type: 'reasoning', index: 0, open: false, used: false, text: '' }
  const text = { type: 'text', index: 1, open: false, used: false, text: '' }
  const tools = new Map()
  let nextBlockIndex = 2
  let finishReason
  let usage
  let emitted = false
  let buffer = ''

  const openBlock = (slot) => {
    if (slot.open) return undefined
    if (slot.used) slot.index = nextBlockIndex++
    slot.used = true
    slot.open = true
    slot.text = ''
    emitted = true
    return { type: 'block-start', index: slot.index, blockType: slot.type }
  }
  const closeBlock = (slot) => {
    if (!slot.open) return undefined
    slot.open = false
    return { type: 'block-end', index: slot.index, block: { type: slot.type, text: slot.text } }
  }

  const abortSignal = options.idleSignal ?? options.signal
  const onAbort = () => { reader.cancel().catch(() => {}) }
  if (abortSignal !== undefined) {
    if (abortSignal.aborted) onAbort()
    else abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    let finished = false
    while (true) {
      if (!finished) {
        if (options.isTimedOut?.() === true) throw new LlmError('WorkBuddy stream idle timed out', 'TIMEOUT')
        if (options.signal?.aborted === true) throw new LlmError('WorkBuddy request aborted', 'ABORTED')
        let readResult
        try {
          readResult = await reader.read()
        } catch (error) {
          throw toTransportError(error, options.signal, 'stream transport', options.isTimedOut?.() === true)
        }
        if (options.isTimedOut?.() === true) throw new LlmError('WorkBuddy stream idle timed out', 'TIMEOUT')
        if (options.signal?.aborted === true) throw new LlmError('WorkBuddy request aborted', 'ABORTED')
        options.onActivity?.()
        const { value, done } = readResult
        if (done) {
          // 最后一行可能没有换行符，补一个让下面的循环处理它。
          finished = true
          buffer += '\n'
        } else {
          buffer += value
        }
      }
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '') continue
        if (data === '[DONE]') {
          finished = true
          break
        }
        let chunk
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (typeof chunk.usage === 'object' && chunk.usage !== null) usage = chunk.usage
        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
        if (choice === undefined) continue
        if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
          finishReason = choice.finish_reason
        }
        const delta = choice.delta
        if (delta === undefined || delta === null) continue

        const thinking = firstReasoningDelta(delta)
        if (thinking !== '') {
          const closedText = closeBlock(text)
          if (closedText !== undefined) yield closedText
          const started = openBlock(reasoning)
          if (started !== undefined) yield started
          reasoning.text += thinking
          yield { type: 'reasoning-delta', index: reasoning.index, text: thinking }
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          const closedReasoning = closeBlock(reasoning)
          if (closedReasoning !== undefined) yield closedReasoning
          const started = openBlock(text)
          if (started !== undefined) yield started
          text.text += delta.content
          yield { type: 'text-delta', index: text.index, text: delta.content }
        }

        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
          const closedReasoning = closeBlock(reasoning)
          if (closedReasoning !== undefined) yield closedReasoning
          const closedText = closeBlock(text)
          if (closedText !== undefined) yield closedText
          for (const [position, call] of delta.tool_calls.entries()) {
            const key = typeof call.index === 'number' ? call.index : position
            let block = tools.get(key)
            if (block === undefined) {
              block = { index: nextBlockIndex++, open: false, id: '', name: '', arguments: '', pendingArguments: '' }
              tools.set(key, block)
            }
            if (typeof call.id === 'string' && call.id !== '') block.id = call.id
            if (typeof call.function?.name === 'string' && call.function.name !== '') block.name = call.function.name
            if (!block.open) {
              block.open = true
              emitted = true
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            }
            const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
            if (argumentsDelta !== '') {
              block.arguments += argumentsDelta
              block.pendingArguments += argumentsDelta
            }
            if (block.id !== '' && block.name !== '' && block.pendingArguments !== '') {
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.id,
                name: block.name,
                argumentsDelta: block.pendingArguments,
              }
              block.pendingArguments = ''
            }
          }
        }
      }
      // Nothing was consumed above, so anything left is an unfinished line.
      // A well-formed stream always ends one, so this is a broken upstream.
      if (buffer.length > MAX_SSE_BUFFER_BYTES) {
        throw new LlmError('WorkBuddy sent an unterminated event line', 'MALFORMED_RESPONSE')
      }
      if (finished) break
    }
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    reader.cancel().catch(() => {})
  }

  if (options.isTimedOut?.() === true) throw new LlmError('WorkBuddy stream idle timed out', 'TIMEOUT')
  if (options.signal?.aborted === true) throw new LlmError('WorkBuddy request aborted', 'ABORTED')

  const closedReasoning = closeBlock(reasoning)
  if (closedReasoning !== undefined) yield closedReasoning
  const closedText = closeBlock(text)
  if (closedText !== undefined) yield closedText
  for (const block of tools.values()) {
    if (block.pendingArguments !== '') {
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: block.id === '' ? `call-${block.index}` : block.id,
        ...block.name === '' ? {} : { name: block.name },
        argumentsDelta: block.pendingArguments,
      }
    }
    yield {
      type: 'block-end',
      index: block.index,
      block: {
        type: 'tool-call',
        id: block.id === '' ? `call-${block.index}` : block.id,
        name: block.name,
        arguments: block.arguments,
      },
    }
  }
  if (!emitted) throw new LlmError('WorkBuddy returned an empty response', 'EMPTY_RESPONSE')

  const normalizedUsage = normalizeUsage(usage)
  if (normalizedUsage !== undefined) yield { type: 'usage', usage: normalizedUsage }
  yield { type: 'finish', reason: finishReasonOf(finishReason, tools.size > 0) }
}

/** 一条目录条目 → 选择器用的 `LlmModelInfo`。 */
function modelInfoOf(provider, model, showCreditBadge = false) {
  return {
    provider,
    id: model.id,
    name: model.name,
    ...model.description === undefined ? {} : { description: model.description },
    ...!showCreditBadge || model.creditMultiplier === undefined ? {} : {
      badge: { text: `${model.creditMultiplier.toFixed(2)}x`, tone: 'neutral' },
    },
    inputModalities: imageCapableOf(model) ? ['text', 'image'] : ['text'],
  }
}

/** 一条目录条目 → 精确路由的 `LlmResolvedModelInfo`。 */
function resolvedInfoOf(provider, model) {
  const info = {
    ...modelInfoOf(provider, model),
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: model.maxTokens,
  }
  const supported = model.reasoning?.supportedEfforts
  const preferred = model.reasoning?.defaultEffort ?? model.reasoning?.effort
  if (supported !== undefined && supported.length > 0) {
    const defaultEffort = preferred !== undefined && supported.includes(preferred) ? preferred : undefined
    info.reasoning = {
      efforts: supported.map(effort => ({ id: effort, name: effort })),
      ...defaultEffort === undefined ? {} : { defaultEffort },
    }
  } else if (preferred !== undefined) {
    info.reasoning = { efforts: [{ id: preferred, name: preferred }], defaultEffort: preferred }
  }
  return info
}

/** 选择器展示的模型过滤规则：目前仅列出 DeepSeek 系列模型。 */
export function isListedModel(model) {
  return /deepseek/iu.test(model.id) || /deepseek/iu.test(model.name)
}

export class WorkBuddyAdapter extends LlmAdapter {
  #store
  #catalog
  #logger
  #attachments
  #streamIdleTimeoutMs
  #warnedMissing = new Set()

  constructor({ store, catalog, logger, attachments, streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS }) {
    super()
    this.#store = store
    this.#catalog = catalog
    this.#logger = logger
    this.#attachments = attachments
    this.#streamIdleTimeoutMs = streamIdleTimeoutMs
  }

  setAttachments(attachments) {
    this.#attachments = attachments
  }

  providerInfo(provider) {
    return { id: provider, name: 'WorkBuddy' }
  }

  async listModels(provider) {
    await this.#catalog.whenReady(CATALOG_READY_WAIT_MS)
    return this.#catalog.current()
      .filter(isListedModel)
      .map(model => modelInfoOf(provider, model, true))
  }

  async resolveModel(provider, model, signal) {
    await this.#catalog.whenReady(CATALOG_READY_WAIT_MS, signal)
    if (signal?.aborted) throw new LlmError('WorkBuddy model resolution aborted', 'ABORTED')
    const entry = this.#catalog.current().find(candidate => candidate.id === model)
    if (entry !== undefined) return resolvedInfoOf(provider, entry)
    if (!this.#warnedMissing.has(model)) {
      this.#warnedMissing.add(model)
      this.#logger?.warn?.(`dsh-workbuddy: model "${model}" is not in the current catalog; using fallback limits`)
    }
    const fallbackModel = { id: model, name: model }
    return {
      provider,
      id: model,
      name: model,
      inputModalities: imageCapableOf(fallbackModel) ? ['text', 'image'] : ['text'],
      context: { contextWindow: FALLBACK_CONTEXT_WINDOW },
      defaultMaxTokens: FALLBACK_MAX_TOKENS,
    }
  }

  async *stream(options) {
    let credential = await this.#store.current(options.signal)
    const messages = await messagesWithImages(
      options.messages,
      this.#attachments,
      options.provider,
      options.model,
      options.signal,
      (provider, model, image) => this.imageRequestTarget(provider, model, image),
    )
    const watchdog = createIdleWatchdog(options.signal, this.#streamIdleTimeoutMs)
    const request = async (forceNeutral) => {
      watchdog.pulse()
      let response
      try {
        response = await postChat(
          credential,
          toWireBody({ ...options, messages }, { forceNeutral }),
          watchdog.signal,
          options.sessionId,
        )
      } catch (error) {
        throw toTransportError(error, options.signal, 'request transport', watchdog.timedOut)
      }
      watchdog.pulse()
      if (response.ok) return response
      let text
      try {
        text = await response.text()
      } catch (error) {
        throw toTransportError(error, options.signal, 'error body read', watchdog.timedOut)
      }
      return { failure: failureOf(response, text, options.model) }
    }
    try {
      let result = await request(false)
      if (result.failure?.status === 401 && typeof this.#store.forceRefresh === 'function') {
        let refreshed
        try {
          refreshed = await this.#store.forceRefresh(credential, options.signal)
        } catch (error) {
          if (error?.code === 'ABORTED') throw error
        }
        if (refreshed !== undefined && refreshed.accessToken !== credential.accessToken) {
          credential = refreshed
          result = await request(false)
        }
      }
      if (result.failure !== undefined && result.failure.code === 'CHANNEL_REJECTED') {
        // First retry only prepends neutral head to system messages so assistant history stays clean.
        result = await request('system')
        if (result.failure !== undefined && result.failure.code === 'CHANNEL_REJECTED') {
          result = await request(true)
        }
      }
      if (result.failure !== undefined) {
        throw new LlmError(result.failure.message, result.failure.code, {
          status: result.failure.status,
          ...result.failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: result.failure.providerRetryAfterMs },
        })
      }
      yield * streamChunks(result, {
        ...options,
        idleSignal: watchdog.signal,
        onActivity: () => watchdog.pulse(),
        isTimedOut: () => watchdog.timedOut,
      })
    } finally {
      watchdog.dispose()
    }
  }
}
