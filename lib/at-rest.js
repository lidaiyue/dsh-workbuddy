/**
 * WorkBuddy 桌面端的凭据解密。
 *
 * 新版桌面端把 auth 文件里的 token 字段写成
 * `{"$wbEncrypted":1,"envelope":"<base64>"}`，信封是 AES-256-GCM
 * （`{suite,keyId,nonce,authTag,ciphertext}`），AAD 是一段按字段框架拼出的
 * 转录。真正的字段密钥不是用户密钥，而是桌面端构建期内置的常量：这里不复制
 * 常量，而是用 `ELECTRON_RUN_AS_NODE` 让已安装的 App 自己回答
 * `loggerGet()`，再按 App 的算法派生。密钥只在本进程内存里缓存，不落盘、不
 * 进日志。
 *
 * 纯字符串字段（旧版 macOS）不需要这一步，因此不会启动子进程。
 *
 * @module dsh-workbuddy/at-rest
 */

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 指向桌面端可执行文件的环境变量，用于 App 装在非默认位置。 */
export const APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE'

/** macOS 上桌面端的 bundle 名（国内版、国际版）。 */
const MACOS_BUNDLES = ['WorkBuddy.app', 'WorkBuddy AI.app']

/** AAD 转录的域前缀。 */
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii')

/** 字段信封的格式标识与方案名。 */
const FIELD_FORMAT_ID = 'WBEV1'
const SYMMETRIC_SCHEME = 'sym-v1'

/** 字段框架码（见 AAD 转录的倒数第三段）。 */
const FIELD_FRAMING = 2

/** 取密钥的子进程上限。App 正常在几百毫秒内回答。 */
const KEY_FETCH_TIMEOUT_MS = 10_000

/** 一次失败记住多久：装好/启动 App 后不必重启插件。 */
const KEY_FAILURE_TTL_MS = 60_000

/** 是否是桌面端的加密字段包装。 */
export function isEncryptedField(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && value.$wbEncrypted === 1
    && typeof value.envelope === 'string'
}

function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

/** 一个字段信封的 AAD：字段框架没有 sequence，也没有 final 段。 */
function fieldAad(keyId, suite) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('workbuddy: envelope keyId is malformed')
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(FIELD_FORMAT_ID),
    encodeLengthPrefixed(SYMMETRIC_SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FIELD_FRAMING]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

/** 派生密钥的 id：密钥 SHA-256 的前 16 个十六进制字符。 */
export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * 从 App 的 `loggerGet()` 载荷派生 32 字节字段密钥。
 *
 * 桌面端哈希的是载荷里 `atRestSecretKey` 这个 base64 **字符串**本身，不是它
 * 解码后的字节；两种写法会得到不同的密钥，所以要按 App 的写法来。
 */
export function deriveAtRestKey(payloadJson) {
  let payload
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    throw new Error('workbuddy: at-rest key payload is not valid JSON')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('workbuddy: at-rest key payload is not an object')
  }
  const secret = payload.atRestSecretKey
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

/** 密钥不匹配错误码，用于触发一次清缓存重取。 */
export const KEY_MISMATCH_CODE = 'AT_REST_KEY_MISMATCH'

/** 用派生出的密钥打开一个字段，返回明文。 */
export function openEncryptedField(field, key) {
  let envelope
  try {
    envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'))
  } catch {
    throw new Error('workbuddy: encrypted field envelope is not valid JSON')
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('workbuddy: encrypted field envelope is not an object')
  }
  const { suite, keyId, nonce, authTag, ciphertext } = envelope
  if (typeof suite !== 'number' || typeof keyId !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing suite or keyId')
  }
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext')
  }
  const expectedKeyId = deriveAtRestKeyId(key)
  if (keyId !== expectedKeyId) {
    throw Object.assign(
      new Error(`workbuddy: encrypted field belongs to key ${keyId}, not ${expectedKeyId}`),
      { code: KEY_MISMATCH_CODE },
    )
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 })
  decipher.setAAD(fieldAad(keyId, suite))
  decipher.setAuthTag(Buffer.from(authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/** 读 bundle 自己的 `Info.plist`，确认它确实是 WorkBuddy 并返回其可执行文件。 */
function bundleExecutable(bundle) {
  let plist
  try {
    plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
  } catch {
    return undefined
  }
  const identifier = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1]
  if (identifier === undefined || !identifier.toLowerCase().includes('workbuddy')) return undefined
  const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1]
  if (executable === undefined) return undefined
  const path = join(bundle, 'Contents', 'MacOS', executable)
  return existsSync(path) ? path : undefined
}

/**
 * 找到桌面端可执行文件：环境变量优先，其次 macOS 的默认安装位置。
 *
 * 每个 Electron 应用的二进制都叫 `Electron`，所以候选必须先由 bundle id 确认
 * 身份，按名字猜路径会把别的 Electron 应用当成 WorkBuddy 启动。
 */
export function findAppExecutable(env = process.env, home = homedir()) {
  const override = typeof env[APP_EXECUTABLE_ENV] === 'string' ? env[APP_EXECUTABLE_ENV].trim() : ''
  if (override !== '') return existsSync(override) ? override : undefined
  for (const parent of ['/Applications', join(home, 'Applications')]) {
    for (const name of MACOS_BUNDLES) {
      const executable = bundleExecutable(join(parent, name))
      if (executable !== undefined) return executable
    }
  }
  return undefined
}

/** This process's environment, cut down to what a Node runtime needs. */
function minimalEnv() {
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') env[name] = value
  }
  return env
}

/** 让 App 以纯 Node 运行并打印自己的密钥载荷。 */
export function fetchKeyPayload(executable) {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + 'catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}'
    execFile(executable, ['-e', source], {
      // The app is a local binary this process did not build; hand it the
      // minimum an Electron-as-Node launch needs instead of every secret the
      // host was started with.
      env: minimalEnv(),
      timeout: KEY_FETCH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${stderr.trim() || error.message})`))
        return
      }
      const payload = stdout.trim()
      if (payload === '') {
        reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'))
        return
      }
      resolve(payload)
    })
  })
}

let cachedKey
let inflightKey
let failedKeyAtMs = 0

/**
 * 桌面端的字段密钥；App 不在、版本太旧或未来轮换了载荷时返回 undefined。
 *
 * 成功缓存到进程结束（App 最多被启动一次）；失败缓存一分钟，避免机器上没有
 * App 时每个请求都去扫一遍安装路径。
 */
export function readAtRestKey() {
  if (cachedKey !== undefined) return Promise.resolve(cachedKey)
  if (inflightKey !== undefined) return inflightKey
  if (failedKeyAtMs !== 0 && Date.now() - failedKeyAtMs < KEY_FAILURE_TTL_MS) return Promise.resolve(undefined)
  inflightKey = (async () => {
    const executable = findAppExecutable()
    if (executable === undefined) return undefined
    return deriveAtRestKey(await fetchKeyPayload(executable))
  })().then((key) => {
    cachedKey = key
    failedKeyAtMs = key === undefined ? Date.now() : 0
    return key
  }, (error) => {
    failedKeyAtMs = Date.now()
    throw error
  }).finally(() => {
    inflightKey = undefined
  })
  return inflightKey
}

/** 清掉缓存；测试与诊断用。 */
export function clearAtRestKeyCache() {
  cachedKey = undefined
  inflightKey = undefined
  failedKeyAtMs = 0
}
