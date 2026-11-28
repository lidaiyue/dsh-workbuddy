import assert from 'node:assert/strict'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

function mockContext() {
  const disposers = []
  const events = []
  let registeredAdapter
  let statusHandler
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    llm: {
      registerAdapter(providers, adapter) {
        registeredAdapter = { providers, adapter }
        return () => { registeredAdapter = undefined }
      },
    },
    webServer: {
      register(route) {
        statusHandler = route.handler
        return () => { statusHandler = undefined }
      },
    },
    inject(_deps, fn) {
      fn(ctx)
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
    },
    emit(event, ...args) {
      events.push([event, ...args])
    },
    dispose() {
      for (const fn of disposers.splice(0)) fn()
    },
    get adapter() {
      return registeredAdapter?.adapter
    },
    get statusHandler() {
      return statusHandler
    },
    events,
  }
  return ctx
}

async function fetchStatus(handler, query = '') {
  let status
  let body
  await handler(
    { method: 'GET', url: `/plugins/dsh-workbuddy/status${query}`, headers: { host: '127.0.0.1:3080' } },
    { writeHead(code) { status = code }, end(payload) { body = JSON.parse(payload) } },
  )
  return { status, body }
}

test('plugin apply registers provider, aligns diagnostic modelCount with listModels, and aborts on dispose', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-workbuddy-index-'))
  const authFile = join(dir, 'auth.info')
  await writeFile(authFile, JSON.stringify({
    auth: { accessToken: 'tok', expiresAt: Date.now() + 3_600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'u1' },
  }), { mode: 0o600 })

  const originalFetch = globalThis.fetch
  let lastSignal
  globalThis.fetch = async (_url, init) => {
    lastSignal = init?.signal
    return new Response(JSON.stringify({
      code: 0,
      data: {
        models: [
          { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', maxInputTokens: 1_000_000, maxOutputTokens: 32_000, credits: 'x0.50' },
          { id: 'hy4flash-free', name: 'Hy4 flash', maxInputTokens: 128_000, maxOutputTokens: 8_000, credits: 'x0.00' },
        ],
        agents: [{ name: 'cli', models: ['deepseek-v4.1-flash', 'hy4flash-free'] }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const ctx = mockContext()
  try {
    apply(ctx, { authFile })
    const listed = await ctx.adapter.listModels('workbuddy')
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, 'deepseek-v4.1-flash')

    const { status, body } = await fetchStatus(ctx.statusHandler)
    assert.equal(status, 200)
    assert.equal(body.state, 'ok')
    assert.equal(body.signedIn, true)
    assert.equal(body.region, 'cn')
    assert.equal(body.modelCount, listed.length)
    assert.deepEqual(ctx.events, [['llm/models-updated', 'workbuddy']])

    // Signing out clears region and reports signedIn: false while keeping degraded count.
    await unlink(authFile)
    const afterSignOut = await fetchStatus(ctx.statusHandler, '?refresh=1')
    assert.equal(afterSignOut.body.signedIn, false)
    assert.equal(afterSignOut.body.region, null)
    assert.equal(afterSignOut.body.state, 'degraded')

    ctx.dispose()
    assert.equal(lastSignal?.aborted, true)
  } finally {
    ctx.dispose()
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
})
