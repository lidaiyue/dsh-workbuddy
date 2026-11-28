/**
 * dsh-workbuddy：把本机已登录的 WorkBuddy 桌面端接到 DSH 的模型选择器。
 *
 * 核心链路：
 *
 *   DSH LLM seam → WorkBuddyAdapter → copilot.tencent.com / workbuddy.ai
 *   凭据 ← WorkBuddy 桌面端 auth 文件（只读；加密字段向 App 取密钥）
 *   目录 ← 上游 /v3/config（定时刷新）
 *
 * 只注册一个 provider（`workbuddy`），区域由本机凭据的域名决定：CN 账号走
 * `copilot.tencent.com`，国际版账号走各自的品牌网关。
 *
 * @module dsh-workbuddy
 */

import { isListedModel, WorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.js'
import { CredentialStore, regionOf } from './auth.js'
import { fetchCatalog, WorkBuddyCatalog } from './catalog.js'
import { createDiagnosticsHandler, STATUS_PATH } from './diagnostics.js'

const name = 'dsh-workbuddy'

/** 目录刷新间隔：目录变得很慢，而这个请求每次都要读一次上游。 */
const DEFAULT_CATALOG_REFRESH_MS = 15 * 60 * 1000

/** 最短刷新间隔；更小的值按默认处理，避免把上游当轮询接口。 */
const MIN_CATALOG_REFRESH_MS = 60 * 1000

function refreshIntervalOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_CATALOG_REFRESH_MS
    ? value
    : DEFAULT_CATALOG_REFRESH_MS
}

function apply(ctx, config) {
  const options = config ?? {}
  const logger = ctx.logger
  const store = new CredentialStore({ authFile: options.authFile, logger })
  const catalog = new WorkBuddyCatalog()
  const adapter = new WorkBuddyAdapter({ store, catalog, logger })
  let refreshCatalog = () => Promise.resolve()
  let diagnosticStatus = {
    provider: WORKBUDDY_PROVIDER,
    state: 'starting',
    checkedAt: null,
    lastSuccessAt: null,
    signedIn: null,
    region: null,
    modelCount: 0,
    lastErrorCode: null,
  }

  ctx.inject(['llm'], (child) => {
    child.effect(() => {
      const registration = child.llm.registerAdapter([WORKBUDDY_PROVIDER], adapter)
      return () => registration()
    }, 'dsh-workbuddy: provider registration')
  })

  ctx.inject(['attachments'], (child) => {
    child.effect(() => {
      adapter.setAttachments(child.attachments)
      return () => adapter.setAttachments(undefined)
    }, 'dsh-workbuddy: image attachments')
  })

  ctx.effect(() => {
    let disposed = false
    let inflight
    let lastProblem = ''
    const controller = new AbortController()

    const listedCount = () => catalog.current().filter(isListedModel).length

    const refresh = () => {
      if (disposed) return Promise.resolve()
      if (inflight !== undefined) return inflight
      diagnosticStatus = { ...diagnosticStatus, state: 'refreshing', checkedAt: new Date().toISOString() }
      inflight = (async () => {
        let credential
        try {
          credential = await store.current(controller.signal)
          if (disposed) return
          diagnosticStatus = {
            ...diagnosticStatus,
            signedIn: true,
            region: regionOf(credential.domain),
          }
          const models = await fetchCatalog(credential, controller.signal)
          if (disposed) return
          lastProblem = ''
          const advertised = models.filter(isListedModel).length
          if (catalog.set(models)) {
            logger?.info?.(`dsh-workbuddy: ${advertised} models available (${models.length} in upstream catalog)`)
            ctx.emit('llm/models-updated', WORKBUDDY_PROVIDER)
          }
          diagnosticStatus = {
            ...diagnosticStatus,
            state: 'ok',
            lastSuccessAt: new Date().toISOString(),
            modelCount: advertised,
            lastErrorCode: null,
          }
        } catch (error) {
          if (disposed) return
          const message = error instanceof Error ? error.message : String(error)
          if (message !== lastProblem) {
            lastProblem = message
            logger?.warn?.(`dsh-workbuddy: ${message}`)
          }
          const signedOut = credential === undefined && error?.code === 'AUTH'
          diagnosticStatus = {
            ...diagnosticStatus,
            state: listedCount() > 0 ? 'degraded' : 'error',
            ...credential === undefined
              ? {
                  signedIn: signedOut ? false : diagnosticStatus.signedIn,
                  ...signedOut ? { region: null } : {},
                }
              : { signedIn: true },
            modelCount: listedCount(),
            lastErrorCode: typeof error?.code === 'string' && error.code !== ''
              ? error.code
              : credential === undefined ? 'AUTH_DISCOVERY_FAILED' : 'CATALOG_REFRESH_FAILED',
          }
        } finally {
          inflight = undefined
          catalog.markReady()
        }
      })()
      return inflight
    }

    refreshCatalog = refresh
    refresh()
    const timer = setInterval(refresh, refreshIntervalOf(options.catalogRefreshMs))
    timer.unref?.()
    return () => {
      disposed = true
      controller.abort()
      refreshCatalog = () => Promise.resolve()
      clearInterval(timer)
    }
  }, 'dsh-workbuddy: catalog refresh')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: createDiagnosticsHandler({
          getStatus: () => ({ ...diagnosticStatus }),
          refresh: () => refreshCatalog(),
        }),
      })
      return () => dispose()
    }, 'dsh-workbuddy: diagnostics route')
  })
}

export { apply, name }
