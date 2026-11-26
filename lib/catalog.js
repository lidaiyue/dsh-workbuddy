/**
 * WorkBuddy 模型目录。
 *
 * 读的是 App 自己读的那份 `/v3/config`，并以 App 的客户端身份去读：这个端点
 * 按客户端通道下发不同文档，CLI 通道的答复是 App 通道的子集。目录只用于
 * 展示与上下文/推理能力声明，不参与请求校验——上游随时会改价、加模型。
 *
 * @module dsh-workbuddy/catalog
 */

import { chatBaseOf, originOf } from './auth.js'

/** 上游产品配置路径。 */
const CONFIG_PATH = '/v3/config'

/**
 * 目录通道的 User-Agent。
 *
 * 这是 App 自己读配置时发的那个身份；换成 chat 的 CLI 身份会拿到一份更小的
 * 文档。与请求所属区域无关，两个区都认这个形状。
 */
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0'

/** 元数据读的超时。 */
const JSON_TIMEOUT_MS = 30_000

/**
 * 上游的 ROUTER 行不是模型：它们由网关在请求时决定具体模型，价格、窗口和
 * 行为都不是这一行能描述的。
 */
const ROUTER_IDS = new Set(['auto', 'default-model'])

/** 从上游的 `credits` 字符串（`x0.79 credits`）取倍率。 */
export function parseCreditMultiplier(value) {
  if (typeof value !== 'string') return undefined
  const match = /x\s*([0-9]+(?:\.[0-9]+)?)/iu.exec(value)
  if (match === null) return undefined
  const multiplier = Number(match[1])
  return Number.isFinite(multiplier) ? multiplier : undefined
}

function parseReasoning(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const supported = Array.isArray(value.supportedEfforts)
    ? value.supportedEfforts.filter(effort => typeof effort === 'string' && effort !== '')
    : undefined
  const defaultEffort = typeof value.defaultEffort === 'string' && value.defaultEffort !== ''
    ? value.defaultEffort
    : undefined
  const effort = typeof value.effort === 'string' && value.effort !== '' ? value.effort : undefined
  if (supported === undefined && defaultEffort === undefined && effort === undefined) return undefined
  return {
    ...supported === undefined ? {} : { supportedEfforts: supported },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...effort === undefined ? {} : { effort },
  }
}

/** 解析一个上游模型条目；没有正数窗口的行不是可用的 chat 模型。 */
export function parseUpstreamModel(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const id = typeof value.id === 'string' ? value.id : ''
  if (id === '' || value.disabled === true) return undefined
  const contextWindow = typeof value.maxInputTokens === 'number' ? value.maxInputTokens : 0
  const maxTokens = typeof value.maxOutputTokens === 'number' ? value.maxOutputTokens : 0
  if (contextWindow <= 0 || maxTokens <= 0) return undefined
  const name = typeof value.name === 'string' && value.name !== '' ? value.name : id
  const creditMultiplier = parseCreditMultiplier(value.credits)
  const reasoning = parseReasoning(value.reasoning)
  const supportsImages = value.disabledMultimodal === true
    ? false
    : typeof value.supportsImages === 'boolean'
      ? value.supportsImages
      : undefined
  const description = typeof value.descriptionZh === 'string' && value.descriptionZh !== ''
    ? value.descriptionZh
    : typeof value.descriptionEn === 'string' && value.descriptionEn !== ''
      ? value.descriptionEn
      : undefined
  return {
    id,
    name,
    contextWindow,
    maxTokens,
    ...creditMultiplier === undefined ? {} : { creditMultiplier },
    ...supportsImages === undefined ? {} : { supportsImages },
    ...reasoning === undefined ? {} : { reasoning },
    ...description === undefined ? {} : { description },
    ...typeof value.supportsToolCall === 'boolean' ? { supportsToolCall: value.supportsToolCall } : {},
  }
}

/**
 * 从目录文档里选出 CLI 可用的模型：解析全部条目，保留 `cli` agent 声明的
 * 那些（按声明顺序）。没有可用的 `cli` 名册时退回整份目录，而不是空列表——
 * 名册是上游的实现细节，不该让 provider 突然没有模型。
 */
export function selectCliModels(rawModels, agents) {
  const byId = new Map()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    const parsed = parseUpstreamModel(model)
    if (parsed !== undefined) byId.set(parsed.id, parsed)
  }
  let roster
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (typeof agent === 'object' && agent !== null && agent.name === 'cli' && Array.isArray(agent.models)) {
      roster = agent.models.filter(id => typeof id === 'string')
      break
    }
  }
  const ids = roster !== undefined && roster.length > 0 ? roster : [...byId.keys()]
  const models = [...new Set(ids)]
    .filter(id => !ROUTER_IDS.has(id))
    .map(id => byId.get(id))
    .filter(model => model !== undefined)
  if (models.length === 0) throw new Error('workbuddy: model catalog resolved to an empty list')
  return models
}

/** 读一次模型目录。 */
export async function fetchCatalog(credential, signal) {
  const response = await fetch(`${chatBaseOf(credential)}${CONFIG_PATH}`, {
    headers: {
      'Authorization': `Bearer ${credential.accessToken}`,
      'Accept': 'application/json',
      'Origin': originOf(credential),
      'Referer': `${originOf(credential)}/`,
      'User-Agent': PRODUCT_UA,
    },
    signal: signal === undefined ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
  })
  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy: model catalog returned HTTP ${response.status} and a non-JSON body`)
  }
  if (!response.ok || envelope?.code !== 0) {
    throw new Error(`workbuddy: model catalog failed (HTTP ${response.status}, code ${envelope?.code ?? '?'}: ${envelope?.msg ?? 'unknown'})`)
  }
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  return selectCliModels(data.models, data.agents)
}

/**
 * 运行时目录：启动时为空的目录，首次成功刷新后才有模型。
 *
 * 没有登录、或刷新还没成功时不列出任何模型——列出来只会让人点到一个注定
 * 401 的行。
 */
export class WorkBuddyCatalog {
  #models = []
  #ready = false
  #markReady
  #readyPromise

  constructor() {
    this.#readyPromise = new Promise((resolve) => {
      this.#markReady = resolve
    })
  }

  current() {
    return this.#models
  }

  /**
   * 等首次目录刷新结束（最多 `timeoutMs`）。
   *
   * 启动时宿主的默认模型可能在第一次刷新落地之前就被解析；等一次可以让
   * 已保存的 WorkBuddy 模型（含它的推理档位）在开机时就解析正确。目录是网络
   * 请求，所以必须有上限——超时就按“目录还没到”处理。
   */
  async whenReady(timeoutMs) {
    if (this.#ready) return
    let timer
    await Promise.race([
      this.#readyPromise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
  }

  markReady() {
    if (this.#ready) return
    this.#ready = true
    this.#markReady()
  }

  /** 替换目录；返回是否发生了变化，供调用方决定要不要通知宿主。 */
  set(models) {
    const next = models.map(model => ({ ...model }))
    // 目录很小（十几个条目），逐字节比较比逐字段挑几个字段更不容易漏掉变化。
    if (JSON.stringify(next) === JSON.stringify(this.#models)) return false
    this.#models = next
    return true
  }
}
