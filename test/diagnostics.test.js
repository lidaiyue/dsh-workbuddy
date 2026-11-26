import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDiagnosticsHandler } from '../lib/diagnostics.js'

function responseCapture() {
  return {
    headers: undefined,
    status: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = JSON.parse(body)
    },
  }
}

function request({ method = 'GET', url = '/', host = '127.0.0.1:3080', origin } = {}) {
  return { method, url, headers: { host, ...(origin === undefined ? {} : { origin }) } }
}

test('diagnostics only serves loopback callers', async () => {
  const handler = createDiagnosticsHandler({ getStatus: () => ({ state: 'ok' }), refresh: async () => {} })
  const res = responseCapture()
  await handler(request({ host: 'dsh.example', origin: 'https://dsh.example' }), res)
  assert.equal(res.status, 403)
  assert.deepEqual(res.body, { error: 'request-not-trusted' })
})

test('diagnostics returns no-store status and optionally refreshes first', async () => {
  let refreshCount = 0
  const handler = createDiagnosticsHandler({
    getStatus: () => ({ provider: 'workbuddy', state: 'ok', modelCount: 2 }),
    refresh: async () => { refreshCount += 1 },
  })
  const res = responseCapture()
  await handler(request({ url: '/plugins/dsh-workbuddy/status?refresh=1', origin: 'http://localhost:3080' }), res)
  assert.equal(refreshCount, 1)
  assert.equal(res.status, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.deepEqual(res.body, { provider: 'workbuddy', state: 'ok', modelCount: 2 })
})

test('diagnostics rejects non-GET methods', async () => {
  const handler = createDiagnosticsHandler({ getStatus: () => ({}), refresh: async () => {} })
  const res = responseCapture()
  await handler(request({ method: 'POST' }), res)
  assert.equal(res.status, 405)
})
