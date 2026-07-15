/**
 * Shared eval helpers: a tiny static HTTP server for fixtures + an async uab
 * command runner.
 *
 * WHY the static server: uab denies `file:` and `data:` top-level navigation by
 * default (egress denylist), so fixtures must be served over http on localhost.
 * It ALSO denies raw-IP literals (127.0.0.1 / ::1), so callers MUST use the
 * `localhost` hostname — `baseUrl` is exactly that. (Verified live: `localhost`
 * navigates, `127.0.0.1` returns `navigation_blocked`.)
 *
 * The server binds on an ephemeral port. We listen without an explicit host so
 * Node accepts whichever family `localhost` resolves to (IPv4 or IPv6), then
 * advertise the URL with the `localhost` hostname so egress permits it.
 *
 * WHY `execCommand` is ASYNC (not spawnSync): the fixture server runs in the
 * SAME process as the harness. `spawnSync` blocks the event loop, so the
 * in-process server can never answer the browser's navigation and `open` hangs
 * until it times out. Async `spawn` keeps the loop alive to serve fixtures while
 * a uab command runs, with a hard SIGKILL timeout.
 *
 * Node built-ins only (http, fs, path, url, child_process). No deps.
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** evals/fixtures — the default document root. */
export const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures')

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Start a static server rooted at `rootDir` (default: evals/fixtures).
 * Resolves to `{ port, baseUrl, url(file), close() }`.
 *   - baseUrl        -> "http://localhost:<port>"
 *   - url("a.html")  -> "http://localhost:<port>/a.html"
 * Path traversal outside the root is refused (403).
 */
export function startServer(rootDir = FIXTURES_DIR) {
  const root = path.resolve(rootDir)

  const server = http.createServer(async (req, res) => {
    try {
      const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      const rel = rawPath.replace(/^\/+/, '') || 'index.html'
      const abs = path.resolve(root, rel)
      // Contain to the document root — never serve outside it.
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' })
        res.end('forbidden')
        return
      }
      const body = await readFile(abs)
      const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // No host arg: bind to the unspecified address so `localhost` (v4 or v6)
    // reaches it regardless of resolver order.
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      const baseUrl = `http://localhost:${port}`
      resolve({
        port,
        baseUrl,
        url: (file) => `${baseUrl}/${String(file).replace(/^\/+/, '')}`,
        close: () =>
          new Promise((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

/**
 * Run a command asynchronously, capturing stdout+stderr, with a hard timeout.
 * Resolves `{ status, out, timedOut }` — never rejects. On timeout the child is
 * SIGKILLed. Uses async spawn so an in-process fixture server keeps serving
 * while the command runs (see the module header).
 */
export function execCommand(bin, argv, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let done = false
    let timedOut = false
    const cap = (buf) => {
      out += buf.toString('utf8')
      if (out.length > 32 * 1024 * 1024) out = out.slice(0, 32 * 1024 * 1024)
    }
    child.stdout.on('data', cap)
    child.stderr.on('data', cap)
    const timer = setTimeout(() => {
      timedOut = true
      out += '\n[[runner: command timed out]]'
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, timeout)
    const finish = (status) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ status, out, timedOut })
    }
    child.on('error', (err) => {
      out += `\n[[runner: spawn error ${err && err.code ? err.code : err}]]`
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/**
 * Convenience: run a uab CLI command (`node <uabBin> <argv...>`) with a timeout.
 * Returns `{ status, out, timedOut }`.
 */
export function runUab(uabBin, argv, opts = {}) {
  return execCommand('node', [uabBin, ...argv], opts)
}
