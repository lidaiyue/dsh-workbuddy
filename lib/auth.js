/**
 * 本机 WorkBuddy 登录态：发现、解析、按需刷新。
 *
 * 凭据由 WorkBuddy 桌面端写入，插件**只读**那份文件，从不改写。刷新得到的
 * 新 token 只留在本进程内存里；同一 refresh token 的并发刷新会合并为一次，App
 * 自己写的文件永远是权威来源。
 *
 * 兼容两种文档形态：嵌套的 `{auth:{…},account:{…}}` 与扁平形态；也兼容旧版
 * 纯字符串 token 与新版加密字段（见 `at-rest.js`）。
 *
 * @module dsh-workbuddy/auth
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

import { isEncryptedField, openEncryptedField, readAtRestKey } from './at-rest.js'

/** 桌面端登录文件名（升级期间新旧拼写可能并存）。 */
const AUTH_FILENAMES = ['workbuddy-desktop.info', 'workbuddy-desktop-ai.info']

/** 国内版网关（chat）。 */
const CN_BASE = 'https://copilot.tencent.com'

/** 国际版网关；凭据自己的域名会选择 `codebuddy.ai` 还是 `workbuddy.ai`。 */
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/** 国内版品牌站，用于 Origin / Referer。 */
const CN_ORIGIN = 'https://www.codebuddy.cn'

/** 提前多久刷新：留出一次请求的余量。 */
const REFRESH_SKEW_MS = 5 * 60 * 1000

/** 刷新请求的超时。 */
const REFRESH_TIMEOUT_MS = 20_000

/** 平台默认的 auth 目录。 */
export function defaultAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')]
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
    const roaming = env.APPDATA || win32.join(home, 'AppData', 'Roaming')
    return [
      win32.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      win32.join(roaming, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ]
  }
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share')
  return [
    join(config, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    join(data, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  ]
}

function expandHome(path, home = homedir()) {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/**
 * 候选 auth 文件，按探测顺序。
 *
 * 显式配置（`config.authFile`）或 `WORKBUDDY_AUTH_FILE` 覆盖平台默认路径；
 * 两者都只影响**读哪份文件**，不影响写。
 */
export function authCandidates({ authFile } = {}, platform = process.platform, home = homedir(), env = process.env) {
  const override = typeof authFile === 'string' && authFile.trim() !== ''
    ? expandHome(authFile.trim(), home)
    : typeof env.WORKBUDDY_AUTH_FILE === 'string' && env.WORKBUDDY_AUTH_FILE.trim() !== ''
      ? expandHome(env.WORKBUDDY_AUTH_FILE.trim(), home)
      : ''
  if (override !== '') return [override]
  return defaultAuthDirs(platform, home, env).flatMap(dir => AUTH_FILENAMES.map(name => join(dir, name)))
}

/** 秒/毫秒都接受。 */
export function expiryToMs(value) {
  if (typeof value !== 'number' || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

/** 凭据域名所属区域。 */
export function regionOf(domain) {
  const lowered = (domain ?? '').trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  if (lowered === 'codebuddy.ai' || lowered.endsWith('.codebuddy.ai')) return 'global'
  return 'cn'
}

/** 该凭据的 chat 网关。 */
export function chatBaseOf(credential) {
  if (regionOf(credential.domain) !== 'global') return CN_BASE
  const domain = credential.domain.toLowerCase()
  return domain === 'codebuddy.ai' || domain.endsWith('.codebuddy.ai')
    ? 'https://www.codebuddy.ai'
    : GLOBAL_BASE
}

/** 该凭据的 Origin / Referer。 */
export function originOf(credential) {
  return regionOf(credential.domain) === 'global' ? chatBaseOf(credential) : CN_ORIGIN
}

/** 解析一份 auth 文档；加密字段需要传入字段密钥。 */
export function parseAuthDocument(text, filePath, key) {
  let document
  try {
    document = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document
  const account = typeof document.account === 'object' && document.account !== null ? document.account : document

  const field = (value) => {
    if (typeof value === 'string') return value
    if (isEncryptedField(value)) {
      if (key === undefined) return undefined
      try {
        return openEncryptedField(value, key)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  const accessToken = field(auth.accessToken)
  if (typeof accessToken !== 'string' || accessToken === '') return undefined

  const credential = {
    accessToken,
    refreshToken: field(auth.refreshToken) ?? '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    domain: field(auth.domain) ?? '',
    uid: field(account.uid) ?? '',
    uin: field(account.uin),
    enterpriseId: field(account.enterpriseId),
    nickname: field(account.nickname),
    lastRefreshAtMs: typeof auth.lastRefreshTime === 'number' ? expiryToMs(auth.lastRefreshTime) : undefined,
    filePath,
  }
  const refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt)
  if (refreshExpiresAtMs > 0) credential.refreshExpiresAtMs = refreshExpiresAtMs
  return credential
}

/** 文档里是否存在需要密钥的字段。 */
function needsAtRestKey(text) {
  try {
    const document = JSON.parse(text)
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return false
    const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document
    const account = typeof document.account === 'object' && document.account !== null ? document.account : document
    return [auth.accessToken, auth.refreshToken, auth.domain, account.uid, account.uin, account.enterpriseId, account.nickname]
      .some(isEncryptedField)
  } catch {
    return false
  }
}

/**
 * 同一账号的排序：先看上游自己的签发时间，没有才退回有效期。
 *
 * 签发时间比 `expiresAt` 更可信：被撤销的旧 token 仍会带着一个很远的
 * `expiresAt`，而重新登录过的文件有更晚的 `lastRefreshTime`。
 */
function isFresher(candidate, incumbent) {
  const a = candidate.lastRefreshAtMs
  const b = incumbent.lastRefreshAtMs
  if (a !== undefined && b !== undefined) {
    if (a !== b) return a > b
  } else if (a !== undefined) {
    return true
  } else if (b !== undefined) {
    return false
  }
  return candidate.expiresAtMs > incumbent.expiresAtMs
}

/**
 * 扫描本机登录态，返回最新的一份。
 *
 * @returns {Promise<{credential?: object, reason?: string}>} 没有登录时
 *   `credential` 缺席，`reason` 说明探测到了什么。
 */
export async function discoverCredential({ authFile } = {}) {
  let key
  let firstProblem
  let best
  for (const path of authCandidates({ authFile })) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') firstProblem ??= `${path}: ${error.message}`
      continue
    }
    if (needsAtRestKey(text)) {
      if (key === undefined) {
        try {
          key = await readAtRestKey()
        } catch (error) {
          firstProblem ??= `${path}: ${error.message}`
        }
      }
      if (key === undefined) {
        firstProblem ??= `${path}: credential fields are encrypted and the WorkBuddy app did not provide its key`
        continue
      }
    }
    const credential = parseAuthDocument(text, path, key)
    if (credential === undefined) {
      firstProblem ??= `${path}: no usable access token`
      continue
    }
    if (best === undefined || isFresher(credential, best)) best = credential
  }
  if (best === undefined) {
    return {
      reason: firstProblem
        ?? `no WorkBuddy sign-in found (looked for ${AUTH_FILENAMES.join(' / ')} in ${defaultAuthDirs().join(', ')})`,
    }
  }
  return { credential: best }
}

/** POST 一次 token 刷新，返回合并后的凭据。 */
export async function refreshCredential(credential, signal) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originOf(credential),
    'Referer': `${originOf(credential)}/`,
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS)
  const response = await fetch(`${chatBaseOf(credential)}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers,
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  const text = await response.text()
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy: token refresh returned HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  if (!response.ok || envelope?.code !== 0) {
    throw new Error(`workbuddy: token refresh failed (HTTP ${response.status}, code ${envelope?.code ?? '?'}: ${envelope?.msg ?? text.slice(0, 200)})`)
  }
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  if (typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw new Error('workbuddy: token refresh returned no accessToken; sign in again in the WorkBuddy app')
  }
  const refreshed = {
    ...credential,
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : credential.refreshToken,
    expiresAtMs: typeof data.expiresIn === 'number' && data.expiresIn > 0
      ? Date.now() + data.expiresIn * 1000
      : credential.expiresAtMs,
    lastRefreshAtMs: Date.now(),
  }
  if (typeof data.domain === 'string' && data.domain !== '') refreshed.domain = data.domain
  return refreshed
}

/** 快到期时刷新；刷新失败但旧 token 还没过期就继续用旧的。 */
export async function ensureFresh(credential, signal, logger) {
  if (credential.expiresAtMs === 0 || credential.expiresAtMs - Date.now() > REFRESH_SKEW_MS) return credential
  if (credential.refreshToken === '') return credential
  try {
    return await refreshCredential(credential, signal)
  } catch (error) {
    if (Date.now() < credential.expiresAtMs) {
      logger?.warn?.(`dsh-workbuddy: token refresh failed, continuing with the unexpired token: ${error.message}`)
      return credential
    }
    throw error
  }
}

/**
 * 当前可用的 WorkBuddy 凭据。
 *
 * 每次调用都重读桌面端文件，所以用户在 App 里重新登录后不用重启 DSH；刷新
 * 结果留在内存里，避免同一进程内反复更换 token。
 */
async function awaitRefresh(pending, signal) {
  if (signal === undefined) return pending
  if (signal.aborted) throw new LlmError('WorkBuddy request aborted', 'ABORTED')
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new LlmError('WorkBuddy request aborted', 'ABORTED'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export class CredentialStore {
  #refreshed
  #refreshes = new Map()
  #authFile
  #logger

  constructor({ authFile, logger } = {}) {
    this.#authFile = authFile
    this.#logger = logger
  }

  async current(signal) {
    let discovered
    try {
      discovered = await discoverCredential({ authFile: this.#authFile })
    } catch (error) {
      throw new LlmError(`WorkBuddy credential discovery failed: ${error.message}`, 'AUTH', { cause: error })
    }
    let credential = discovered.credential
    if (this.#refreshed !== undefined
      && (credential === undefined || this.#refreshed.expiresAtMs > credential.expiresAtMs)) {
      credential = this.#refreshed
    }
    if (credential === undefined) {
      throw new LlmError(`WorkBuddy is not signed in on this machine: ${discovered.reason}`, 'AUTH')
    }
    try {
      const refreshKey = credential.refreshToken
      if (refreshKey === '' || credential.expiresAtMs === 0 || credential.expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
        return credential
      }
      let pending = this.#refreshes.get(refreshKey)
      if (pending === undefined) {
        pending = ensureFresh(credential, undefined, this.#logger)
          .then((fresh) => {
            if (fresh !== credential && (this.#refreshed === undefined || fresh.expiresAtMs >= this.#refreshed.expiresAtMs)) {
              this.#refreshed = fresh
            }
            return fresh
          })
          .finally(() => {
            if (this.#refreshes.get(refreshKey) === pending) this.#refreshes.delete(refreshKey)
          })
        this.#refreshes.set(refreshKey, pending)
      }
      return await awaitRefresh(pending, signal)
    } catch (error) {
      throw new LlmError(`WorkBuddy credential refresh failed: ${error.message}`, 'AUTH', { cause: error })
    }
  }
}
