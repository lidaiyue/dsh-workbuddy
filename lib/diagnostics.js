import { Buffer } from 'node:buffer'

const STATUS_PATH = '/plugins/dsh-workbuddy/status'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none'])

function loopback(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${value}`).hostname)
  } catch {
    return false
  }
}

function loopbackRemote(req) {
  const address = req.socket?.remoteAddress
  if (address === undefined) return true
  return LOOPBACK_ADDRESSES.has(address)
}

function trustedRequest(req) {
  if (!loopbackRemote(req)) return false
  if (!loopback(req.headers?.host)) return false
  const fetchSite = req.headers?.['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== '' && !TRUSTED_FETCH_SITES.has(fetchSite)) {
    return false
  }
  const origin = req.headers?.origin
  if (origin === undefined || origin === '') return true
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function createDiagnosticsHandler({ getStatus, refresh }) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!trustedRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    let forceRefresh = false
    try {
      forceRefresh = new URL(req.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
    } catch {
      // Invalid URL falls back to a read-only status response.
    }
    if (forceRefresh) {
      try {
        await refresh()
      } catch {
        json(res, 500, { error: 'refresh-failed' })
        return
      }
    }
    json(res, 200, getStatus())
  }
}

export { STATUS_PATH }
