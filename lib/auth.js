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
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

import {
  clearAtRestKeyCache,
  isEncryptedField,
  KEY_MISMATCH_CODE,
  openEncryptedField,
  readAtRestKey,
} from './at-rest.js'

/** chat 与刷新共用的 CLI 通道 User-Agent。 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

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
  const domain = (credential.domain ?? '').trim().toLowerCase()
  return domain === 'codebuddy.ai' || domain.endsWith('.codebuddy.ai')
    ? 'https://www.codebuddy.ai'
    : GLOBAL_BASE
}

/** 该凭据的 Origin / Referer。 */
export function originOf(credential) {
  return regionOf(credential.domain) === 'global' ? chatBaseOf(credential) : CN_ORIGIN
}

function parseJsonObject(text) {
  try {
    const document = JSON.parse(text)
    if (typeof document === 'object' && document !== null && !Array.isArray(document)) return document
  } catch {}
  return undefined
}

function documentSections(document) {
  const auth = typeof document.auth === 'object' && document.auth !== null ? document.auth : document
  const account = typeof document.account === 'object' && document.account !== null ? document.account : document
  return { auth, account }
}

function documentHasEncryptedFields(document) {
  const { auth, account } = documentSections(document)
  return [auth.accessToken, auth.refreshToken, auth.domain, account.uid, account.enterpriseId]
    .some(isEncryptedField)
}

function parseAuthObject(document, filePath, key, diagnostics) {
  const { auth, account } = documentSections(document)

  const field = (value) => {
    if (typeof value === 'string') return value
    if (isEncryptedField(value)) {
      if (key === undefined) return undefined
      try {
        return openEncryptedField(value, key)
      } catch (error) {
        if (error?.code === KEY_MISMATCH_CODE && diagnostics !== undefined) diagnostics.keyMismatch = true
        return undefined
      }
    }
    return undefined
  }

  const accessToken = field(auth.accessToken)
  if (typeof accessToken !== 'string' || accessToken === '') return undefined

  return {
    accessToken,
    refreshToken: field(auth.refreshToken) ?? '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    domain: field(auth.domain) ?? '',
    uid: field(account.uid) ?? '',
    enterpriseId: field(account.enterpriseId),
    lastRefreshAtMs: typeof auth.lastRefreshTime === 'number' ? expiryToMs(auth.lastRefreshTime) : undefined,
    filePath,
  }
}

/** 解析一份 auth 文档；加密字段需要传入字段密钥。 */
export function parseAuthDocument(text, filePath, key) {
  const document = parseJsonObject(text)
  if (document === undefined) return undefined
  return parseAuthObject(document, filePath, key)
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
export async function discoverCredential({ authFile, readKey = readAtRestKey, clearKeyCache = clearAtRestKeyCache } = {}) {
  let key
  let keyRetried = false
  let firstProblem
  let best
  let insecure
  for (const path of authCandidates({ authFile })) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') firstProblem ??= `${path}: ${error.message}`
      continue
    }
    // The file carries a bearer token. Another local account that can read it
    // can spend the user's quota, so a group/world-readable mode is reported
    // once instead of being silently accepted. Windows synthesizes 0o666 on
    // every file, so POSIX mode bits are only meaningful off win32.
    if (process.platform !== 'win32') {
      try {
        const mode = (await stat(path)).mode & 0o777
        if ((mode & 0o077) !== 0 && insecure === undefined) insecure = { path, mode }
      } catch {}
    }
    const document = parseJsonObject(text)
    if (document === undefined) {
      firstProblem ??= `${path}: no usable access token`
      continue
    }
    const encrypted = documentHasEncryptedFields(document)
    if (encrypted) {
      if (key === undefined) {
        try {
          key = await readKey()
        } catch (error) {
          firstProblem ??= `${path}: ${error.message}`
        }
      }
      if (key === undefined) {
        firstProblem ??= `${path}: credential fields are encrypted and the WorkBuddy app did not provide its key`
        continue
      }
    }
    const diagnostics = { keyMismatch: false }
    let credential = parseAuthObject(document, path, key, diagnostics)
    // If the desktop app upgraded and rotated its at-rest key while DSH stayed
    // running, drop the cached key once and re-fetch before giving up.
    if (encrypted && diagnostics.keyMismatch && !keyRetried) {
      keyRetried = true
      clearKeyCache()
      key = undefined
      try {
        key = await readKey()
      } catch (error) {
        firstProblem ??= `${path}: ${error.message}`
      }
      if (key !== undefined) {
        credential = parseAuthObject(document, path, key)
      }
    }
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
  const warning = insecure === undefined
    ? undefined
    : `${insecure.path} is readable by other users (mode ${insecure.mode.toString(8).padStart(3, '0')}); run chmod 600 on it`
  return { credential: best, permissionWarning: warning }
}

/** POST 一次 token 刷新，返回合并后的凭据。 */
export async function refreshCredential(credential, signal) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originOf(credential),
    'Referer': `${originOf(credential)}/`,
    'User-Agent': CLIENT_UA,
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS)
  let response
  try {
    response = await fetch(`${chatBaseOf(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      // The refresh body carries a long-lived token; a redirect would hand it to
      // the Location host instead of the gateway.
      redirect: 'error',
      headers,
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    })
  } catch (error) {
    if (signal?.aborted) throw new LlmError('WorkBuddy token refresh aborted', 'ABORTED', { cause: error })
    const detail = error instanceof Error ? error.message : String(error)
    throw new LlmError(`workbuddy: token refresh transport failed: ${detail}`, 'TRANSPORT', { cause: error })
  }
  let text
  try {
    text = await response.text()
  } catch (error) {
    if (signal?.aborted) throw new LlmError('WorkBuddy token refresh aborted', 'ABORTED', { cause: error })
    const detail = error instanceof Error ? error.message : String(error)
    throw new LlmError(`workbuddy: token refresh read failed: ${detail}`, 'TRANSPORT', { cause: error })
  }
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new LlmError(
      `workbuddy: token refresh returned HTTP ${response.status}: ${text.slice(0, 200)}`,
      response.status >= 500 ? 'TRANSPORT' : 'AUTH',
      { status: response.status },
    )
  }
  if (!response.ok || envelope?.code !== 0) {
    throw new LlmError(
      `workbuddy: token refresh failed (HTTP ${response.status}, code ${envelope?.code ?? '?'}: ${envelope?.msg ?? text.slice(0, 200)})`,
      response.status >= 500 ? 'TRANSPORT' : 'AUTH',
      { status: response.status },
    )
  }
  const data = typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}
  if (typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw new LlmError('workbuddy: token refresh returned no accessToken; sign in again in the WorkBuddy app', 'AUTH')
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

function sameCredentialLineage(entry, disk) {
  if (entry.credential.filePath !== disk.filePath) return false
  if (entry.credential.uid !== disk.uid) return false
  return entry.sourceRefreshToken === disk.refreshToken
    || entry.credential.refreshToken === disk.refreshToken
}

export class CredentialStore {
  #refreshed
  #refreshes = new Map()
  #authFile
  #logger
  #warnedPermission = false

  constructor({ authFile, logger } = {}) {
    this.#authFile = authFile
    this.#logger = logger
  }

  #shareRefresh(credential, task, signal) {
    const refreshKey = credential.refreshToken
    let pending = this.#refreshes.get(refreshKey)
    if (pending === undefined) {
      const sourceRefreshToken = this.#refreshed?.sourceRefreshToken ?? credential.refreshToken
      pending = task()
        .then((fresh) => {
          if (fresh !== credential
            && (this.#refreshed === undefined || isFresher(fresh, this.#refreshed.credential))) {
            this.#refreshed = { credential: fresh, sourceRefreshToken }
          }
          return fresh
        })
        .finally(() => {
          if (this.#refreshes.get(refreshKey) === pending) this.#refreshes.delete(refreshKey)
        })
      // Prevent unhandled rejections if every caller aborts before the shared refresh settles.
      pending.catch(() => {})
      this.#refreshes.set(refreshKey, pending)
    }
    return awaitRefresh(pending, signal)
  }

  /** 上游返回 401 时忽略本地过期时间，强制刷新一次 token。 */
  async forceRefresh(credential, signal) {
    if (signal?.aborted) throw new LlmError('WorkBuddy request aborted', 'ABORTED')
    if (typeof credential?.refreshToken !== 'string' || credential.refreshToken === '') return undefined
    try {
      return await this.#shareRefresh(credential, () => refreshCredential(credential), signal)
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(`WorkBuddy credential refresh failed: ${error.message}`, 'AUTH', { cause: error })
    }
  }

  async current(signal) {
    if (signal?.aborted) throw new LlmError('WorkBuddy request aborted', 'ABORTED')
    let discovered
    try {
      discovered = await discoverCredential({ authFile: this.#authFile })
    } catch (error) {
      throw new LlmError(`WorkBuddy credential discovery failed: ${error.message}`, 'AUTH', { cause: error })
    }
    let credential = discovered.credential
    if (discovered.permissionWarning !== undefined && this.#warnedPermission !== true) {
      this.#warnedPermission = true
      try { this.#logger?.warn?.(`dsh-workbuddy: ${discovered.permissionWarning}`) } catch {}
    }
    if (credential === undefined) {
      // The desktop auth file is gone or unreadable (e.g. user signed out);
      // drop any cached in-memory refresh instead of keeping a stale session alive.
      this.#refreshed = undefined
      throw new LlmError(`WorkBuddy is not signed in on this machine: ${discovered.reason}`, 'AUTH')
    }
    if (this.#refreshed !== undefined) {
      if (sameCredentialLineage(this.#refreshed, credential)
        && isFresher(this.#refreshed.credential, credential)) {
        credential = this.#refreshed.credential
      } else {
        // The desktop app signed into another account or wrote a newer login.
        this.#refreshed = undefined
      }
    }
    try {
      const refreshKey = credential.refreshToken
      if (refreshKey === '' || credential.expiresAtMs === 0 || credential.expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
        return credential
      }
      return await this.#shareRefresh(credential, () => ensureFresh(credential, undefined, this.#logger), signal)
    } catch (error) {
      if (error instanceof LlmError) throw error
      throw new LlmError(`WorkBuddy credential refresh failed: ${error.message}`, 'AUTH', { cause: error })
    }
  }
}
