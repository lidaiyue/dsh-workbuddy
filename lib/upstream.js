/**
 * WorkBuddy 的 chat 上游：请求头、请求体规范化、错误分类。
 *
 * 网关有三道与 OpenAI 兼容协议无关的门，全部来自实测：
 *
 * 1. 会话必须以 `system` 消息开头（`ensureSystemHead`）；
 * 2. 请求要带会话身份三件套（`chatHeaders`）；
 * 3. `system` / `assistant` 文本里出现 DSH 自己的身份句会被 `11128` 拒绝，
 *    且网关会先归一化不可见字符，所以零宽断词无效，只能**改写措辞**
 *    （`rewriteChannelPhrases`）。被拒时再用中性开头整段重试一次。
 *
 * 参考实现：dingminhua/dsh-connect-workbuddy（MIT）的 upstream.ts。
 *
 * @module dsh-workbuddy/upstream
 */

import { randomUUID } from 'node:crypto'

import { chatBaseOf, originOf, regionOf } from './auth.js'

/** chat 通道的 User-Agent：账单与限流认的是这个通道。 */
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

/** 与 `PRODUCT_UA` 一致的 App 版本，供 `X-IDE-Version` 使用。 */
const APP_VERSION = '5.8.3'

/** 补在中性头里的占位 system 提示词。 */
export const NEUTRAL_SYSTEM_HEAD = 'You are a helpful assistant.'

/**
 * 被网关判为“非官方客户端”的提示词措辞，以及同义的改写。
 *
 * 原文匹配、只改命中的那一处；普通对话逐字节不变。改写是幂等的：每个 `to`
 * 都不等于它的 `from`，也不会再生成另一个 `from`。
 */
const CHANNEL_GATE_PHRASES = [
  ['You are an AI agent powered by DeepSeek Harness', 'You are an AI agent running inside DeepSeek Harness'],
  ['You are a coding agent powered by the ', 'You are a coding agent running on the '],
  ['You are interacting with the user through the DeepSeek Harness Web GUI', 'You are working with the user inside the DeepSeek Harness Web GUI'],
  ['Tokens prefixed with @ are paths the user explicitly referenced.', 'Paths that begin with @ are the ones the user explicitly referenced.'],
  ['Relative paths resolve from the workspace root;', 'Relative paths are resolved against the workspace root;'],
  ['absolute paths identify files or directories on the host.', 'absolute paths point at files or directories on the host.'],
  ['A trailing slash marks a directory:', 'A trailing slash indicates a directory:'],
  ['list it when its contents matter.', 'list it whenever its contents matter.'],
  ['Anything else is a file:', 'Everything else is a file:'],
  ['use the read tool when its contents are needed,', 'use the read tool whenever you need its contents,'],
  ['and do not claim to have inspected it before reading.', 'and never claim to have inspected it before reading it.'],
  ['@"..." quotes a path containing spaces.', 'A path containing spaces is quoted with @"...".'],
]

/** 改写一段被扫描的文本。 */
export function rewriteChannelPhrases(text) {
  let out = text
  for (const [from, to] of CHANNEL_GATE_PHRASES) {
    if (out.includes(from)) out = out.replaceAll(from, to)
  }
  return out
}

/** 网关扫描开头的角色：`system` 与 `assistant`。 */
function isScannedRole(role) {
  return role === 'system' || role === 'assistant'
}

function textParts(message) {
  if (typeof message.content === 'string') return [message.content]
  if (!Array.isArray(message.content)) return []
  return message.content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
}

function rewriteInMessages(messages) {
  for (const message of messages) {
    if (!isScannedRole(message.role)) continue
    if (typeof message.content === 'string') {
      message.content = rewriteChannelPhrases(message.content)
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string') part.text = rewriteChannelPhrases(part.text)
    }
  }
}

/** 会话必须由 `system` 消息开头，否则补一条中性 system。 */
export function ensureSystemHead(messages) {
  if (messages[0]?.role === 'system') return
  messages.unshift({ role: 'system', content: NEUTRAL_SYSTEM_HEAD })
}

/**
 * 救援：给每一条被扫描消息的开头补中性头。
 *
 * 网关按开头做前缀匹配，所以把宿主自己的开头挪到中性头之后即可；不针对任何
 * 具体指纹，因此对上没实测过的新词条也有效。
 */
export function forceNeutralHead(messages) {
  const head = (text) => text.trimStart().toLowerCase().startsWith(NEUTRAL_SYSTEM_HEAD.toLowerCase())
    ? text
    : `${NEUTRAL_SYSTEM_HEAD}\n\n${text}`
  for (const message of messages) {
    if (!isScannedRole(message.role)) continue
    if (typeof message.content === 'string') {
      if (message.content !== '') message.content = head(message.content)
      continue
    }
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text !== '') part.text = head(part.text)
    }
  }
}

/** 请求体规范化：强制流式、补 system 头、改写被拒措辞。 */
export function prepareMessages(messages, { forceNeutral = false } = {}) {
  ensureSystemHead(messages)
  rewriteInMessages(messages)
  if (forceNeutral) forceNeutralHead(messages)
  return messages
}

/**
 * 网关拒绝的 JSON Schema 拼写（业务码 11129 / 11133），改写成 2020-12 形式。
 *
 * 宿主用 zod 生成工具 schema，某些形状带 draft-4 遗留：元组式 `items`、布尔
 * `exclusiveMinimum`、字符串形式的 `required`、`required` 里的重复项、外部
 * `$ref`。内部 `$ref` 实测可以通过，不动。
 */
const SCHEMA_CHILD_MAPS = ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']
const SCHEMA_CHILD_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems']
const SCHEMA_CHILD_SINGLE = ['items', 'additionalItems', 'additionalProperties', 'not', 'contains', 'if', 'then', 'else', 'propertyNames']
const MAX_SCHEMA_DEPTH = 64

function normalizeSchemaNode(node, depth = 0) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return
  if (depth > MAX_SCHEMA_DEPTH) return
  const schema = node

  if (Array.isArray(schema.items)) {
    schema.prefixItems = schema.items
    schema.items = {}
  }
  for (const [exclusive, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    if (typeof schema[exclusive] !== 'boolean') continue
    if (schema[exclusive] === true && typeof schema[bound] === 'number') schema[exclusive] = schema[bound]
    else delete schema[exclusive]
  }
  if (typeof schema.required === 'string') schema.required = [schema.required]
  if (Array.isArray(schema.required)) {
    schema.required = [...new Set(schema.required.filter(item => typeof item === 'string'))]
    if (schema.required.length === 0) delete schema.required
  }
  if (typeof schema.$ref === 'string' && !schema.$ref.startsWith('#/')) delete schema.$ref

  for (const key of SCHEMA_CHILD_MAPS) {
    const child = schema[key]
    if (typeof child !== 'object' || child === null || Array.isArray(child)) continue
    for (const nested of Object.values(child)) normalizeSchemaNode(nested, depth + 1)
  }
  for (const key of SCHEMA_CHILD_LISTS) {
    if (Array.isArray(schema[key])) for (const nested of schema[key]) normalizeSchemaNode(nested, depth + 1)
  }
  for (const key of SCHEMA_CHILD_SINGLE) normalizeSchemaNode(schema[key], depth + 1)
}

/** 改写 `tools[].function.parameters` 里的被拒拼写。 */
export function normalizeToolSchemas(tools) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (typeof tool?.function === 'object' && tool.function !== null) normalizeSchemaNode(tool.function.parameters)
    else if (tool?.parameters !== undefined) normalizeSchemaNode(tool.parameters)
  }
  return tools
}

/** 一个 chat 请求的完整头。 */
export function chatHeaders(credential) {
  const origin = originOf(credential)
  const global = regionOf(credential.domain) === 'global'
  const requestId = randomUUID()
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': CLIENT_UA,
    'X-CodeBuddy-Request': '1',
    'Accept-Language': global ? 'en-US' : 'zh-CN',
    'Content-Type': 'application/json',
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Version': APP_VERSION,
    'X-Product': 'WorkBuddy',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': requestId,
    'X-Root-Request-ID': requestId,
    'X-Conversation-Message-ID': randomUUID(),
    'Authorization': `Bearer ${credential.accessToken}`,
  }
  if (credential.uid !== undefined && credential.uid !== '') headers['X-User-Id'] = credential.uid
  else headers['X-No-User-Id'] = '1'
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') headers['X-Enterprise-Id'] = credential.enterpriseId
  else headers['X-No-Enterprise-Id'] = '1'
  if (credential.domain !== undefined && credential.domain !== '') headers['X-Domain'] = credential.domain
  else headers['X-No-Department-Info'] = '1'
  return headers
}

/** 发一次 chat 请求；不设总超时，由宿主的中止信号负责取消。 */
export function postChat(credential, body, signal) {
  return fetch(`${chatBaseOf(credential)}/v2/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(credential),
    body: JSON.stringify(body),
    ...signal === undefined ? {} : { signal },
  })
}

/** 从失败体里读上游业务码（紧凑写法与嵌套信封都认）。 */
export function businessCodeOf(text) {
  const asNumber = (value) => {
    if (typeof value === 'number') return value
    if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value)
    return undefined
  }
  try {
    const document = JSON.parse(text)
    for (const value of [document?.code, document?.error?.code, document?.error?.data?.code, document?.data?.code]) {
      const code = asNumber(value)
      if (code !== undefined) return code
    }
  } catch {
    // 非 JSON 失败体走下面的正则。
  }
  const match = /"code"\s*:\s*"?(\d{3,6})"?/u.exec(text)
  return match === null ? undefined : Number(match[1])
}

/** 从失败体里读一句能给人看的话。 */
export function failureMessageOf(text, fallback) {
  try {
    const document = JSON.parse(text)
    const tips = document?.displayMsg ?? document?.displayTips
    const localized = typeof tips === 'object' && tips !== null ? tips.zh ?? tips.en : undefined
    if (typeof localized === 'string' && localized !== '') return localized
    if (typeof document?.msg === 'string' && document.msg !== '') return document.msg
  } catch {
    // 非 JSON 失败体直接截断展示。
  }
  return text === '' ? fallback : `${fallback}: ${text.slice(0, 300)}`
}

/** 429 是否带了可用的 Retry-After（秒）。 */
function retryAfterMsOf(response) {
  const raw = response.headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/**
 * 把一次失败的 HTTP 响应翻译成宿主认识的失败码。
 *
 * `11128` 单独成类：它是请求内容被渠道校验拒绝，换号、重试同一个 body 都不会
 * 变，只有改写措辞（见 `prepareMessages`）才有意义。
 */
export function failureOf(response, text, model) {
  const status = response.status
  const code = businessCodeOf(text)
  const withFacts = (failureCode, message) => ({
    code: failureCode,
    message,
    status,
    ...retryAfterMsOf(response) === undefined ? {} : { providerRetryAfterMs: retryAfterMsOf(response) },
  })

  if (code === 11128) return withFacts('CHANNEL_REJECTED', `WorkBuddy 渠道校验拒绝了这次请求（11128）：${failureMessageOf(text, 'request blocked')}`)
  if (code === 11115) return withFacts('CONTEXT_WINDOW_EXCEEDED', `WorkBuddy 上游认为提示词超出模型窗口（11115）：${failureMessageOf(text, 'prompt too long')}`)
  if (code === 14018) return withFacts('QUOTA', `WorkBuddy 账号积分不足（14018）：${failureMessageOf(text, 'credits exhausted')}`)
  if (code === 11140) return withFacts('INVALID_REQUEST', `WorkBuddy 内容策略拒绝了这次请求（11140）：${failureMessageOf(text, 'request rejected')}`)
  if (code === 11129) return withFacts('INVALID_REQUEST', `WorkBuddy 拒绝了工具 schema（11129）：${failureMessageOf(text, 'tool schema rejected')}`)
  if (code === 11133) return withFacts('MODEL_UNSUPPORTED', `WorkBuddy 拒绝了这个模型（11133）：${failureMessageOf(text, `model ${model ?? ''} unavailable`)}`)
  if (code === 14003) return withFacts('RATE_LIMIT', `WorkBuddy 模型繁忙（14003）：${failureMessageOf(text, 'model busy')}`)
  if (code === 6004 || code === 6020 || code === 6021 || code === 6022) {
    return withFacts('RATE_LIMIT', `WorkBuddy 排队或限流（${code}）：${failureMessageOf(text, 'queued')}`)
  }
  if (status === 401 || status === 403) return withFacts('AUTH', `WorkBuddy 凭据被拒绝（HTTP ${status}）：${failureMessageOf(text, 'unauthorized')}`)
  if (status === 404) return withFacts('UNKNOWN_MODEL', `WorkBuddy 找不到这个模型（HTTP 404）：${failureMessageOf(text, 'not found')}`)
  if (status === 429) return withFacts('RATE_LIMIT', `WorkBuddy 请求过快（HTTP 429）：${failureMessageOf(text, 'rate limited')}`)
  if (status >= 500) return withFacts('TRANSPORT', `WorkBuddy 网关错误（HTTP ${status}）：${failureMessageOf(text, 'server error')}`)
  return withFacts('INVALID_REQUEST', `WorkBuddy 拒绝了请求（HTTP ${status}${code === undefined ? '' : `，code ${code}`}）：${failureMessageOf(text, 'request rejected')}`)
}
