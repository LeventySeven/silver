/**
 * In-page capture + network routing + active-frame sidecars (Vercel-parity verbs).
 *
 * WHY in-page buffers (not `page.on('console')`): Silver is a browser-as-daemon
 * with a STATELESS per-command CDP reconnect (session.ts). A `page.on(...)`
 * listener only lives for the one command's connection window, so it would drop
 * every console message / request that fires BETWEEN commands. Instead we install
 * a small idempotent instrumentation IIFE into the page's own JS (via a CDP
 * `addScriptToEvaluateOnNewDocument` at nav time PLUS a post-load re-install).
 * The monkey-patched `console`/`fetch`/`XHR` wrappers and the `PerformanceObserver`
 * live in the document's JS context, so they keep buffering into `window.__silverCap`
 * after our client disconnects — a later `console`/`network requests` command just
 * reads that page-side ring buffer. Bounded to MAX per channel.
 *
 * Network ROUTING is likewise re-materialized each command: `page.route` handlers
 * are client-side and vanish on reconnect, so rules are persisted to a sidecar and
 * re-applied by `applyRoutes` on every connection — effectively persistent from the
 * caller's view. Same for the active FRAME (a stored key, re-resolved per command).
 *
 * KEYLESS: pure Playwright/CDP + filesystem. No model call anywhere. Sidecars are
 * my own files (capture.json / routes.json / frame.json) — never session.json,
 * refmap.json, tabs.json — so they never race the engine's own sidecar writes.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Page, Frame } from 'playwright'
import { sessionDir } from './session.js'

/** Per-channel ring-buffer ceiling inside the page (mirrors the CLI-side cap). */
const MAX = 500

/**
 * The instrumentation IIFE, as a STRING (tsconfig `lib` has no DOM types, so the
 * project convention is string-form `page.evaluate` for anything touching
 * window/document — see handlers.ts). Idempotent: guarded by `window.__silverCap`
 * so re-running (or a duplicate init-script registration) is a no-op after the
 * first install. Captures three channels into `window.__silverCap`:
 *   console  — console.{log,info,warn,error,debug}
 *   errors   — window 'error' + 'unhandledrejection'
 *   net      — fetch + XMLHttpRequest (real method/status) + PerformanceObserver
 *              resource entries (other sub-resources; status is best-effort 200).
 */
export const INSTALLER = `(function(){
  if (window.__silverCap) return;
  var MAX = ${MAX};
  var C = { console: [], errors: [], net: [] };
  window.__silverCap = C;
  function cap(a, r){ a.push(r); if (a.length > MAX) a.shift(); }
  ['log','info','warn','error','debug'].forEach(function(level){
    var orig = console[level];
    console[level] = function(){
      try {
        var parts = [];
        for (var i=0;i<arguments.length;i++){
          var v = arguments[i];
          try { parts.push(typeof v === 'string' ? v : JSON.stringify(v)); }
          catch(e){ parts.push(String(v)); }
        }
        cap(C.console, { level: level, text: parts.join(' '), ts: Date.now() });
      } catch(e){}
      if (orig) try { return orig.apply(console, arguments); } catch(e){}
    };
  });
  window.addEventListener('error', function(ev){
    try { cap(C.errors, { message: (ev && ev.message) || String(ev), stack: (ev && ev.error && ev.error.stack) || '', ts: Date.now() }); } catch(e){}
  });
  window.addEventListener('unhandledrejection', function(ev){
    try { var r = ev && ev.reason; cap(C.errors, { message: (r && r.message) || String(r), stack: (r && r.stack) || '', ts: Date.now() }); } catch(e){}
  });
  var of = window.fetch;
  if (of) {
    window.fetch = function(input, init){
      var url = '', method = 'GET';
      try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch(e){}
      try { method = (init && init.method) || (input && input.method) || 'GET'; } catch(e){}
      var rec = { url: String(url), method: String(method).toUpperCase(), status: 0, resourceType: 'fetch', ts: Date.now() };
      cap(C.net, rec);
      return of.apply(this, arguments).then(function(res){ try { rec.status = res.status; } catch(e){} return res; }, function(err){ rec.status = -1; throw err; });
    };
  }
  try {
    var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u){ try { this.__silver = { url: String(u), method: String(m||'GET').toUpperCase(), status: 0, resourceType: 'xhr', ts: Date.now() }; } catch(e){} return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(){ var self=this, rec=this.__silver; if (rec){ cap(C.net, rec); try { this.addEventListener('loadend', function(){ try { rec.status = self.status; } catch(e){} }); } catch(e){} } return os.apply(this, arguments); };
  } catch(e){}
  try {
    var po = new PerformanceObserver(function(list){
      list.getEntries().forEach(function(e){
        var it = e.initiatorType || 'other';
        if (it === 'fetch' || it === 'xmlhttprequest') return;
        cap(C.net, { url: e.name, method: 'GET', status: 200, resourceType: it, ts: Date.now() });
      });
    });
    po.observe({ type: 'resource', buffered: true });
  } catch(e){}
})()`

export type CaptureChannel = 'console' | 'errors' | 'net'

export type CaptureMeta = {
  /** True between `network har start` and `network har stop`. */
  harRecording?: boolean
  harStartedAt?: string
}

function capturePath(session: string): string {
  return path.join(sessionDir(session), 'capture.json')
}

async function loadCaptureMeta(session: string): Promise<CaptureMeta> {
  try {
    return JSON.parse(await fs.readFile(capturePath(session), 'utf8')) as CaptureMeta
  } catch {
    return {}
  }
}

async function saveCaptureMeta(session: string, meta: CaptureMeta): Promise<void> {
  await fs.mkdir(sessionDir(session), { recursive: true })
  await fs.writeFile(capturePath(session), JSON.stringify(meta), 'utf8')
}

/**
 * Ensure the capture instrumentation is live. Two complementary installs:
 *
 *  (1) `addInitScript` — Playwright re-injects it at document-start on every new
 *      document WHILE this command's client is connected, so a navigation the
 *      caller is about to trigger (e.g. `open`) is hooked from the very start,
 *      capturing console/network that fires during page load. (A raw CDP
 *      `addScriptToEvaluateOnNewDocument` does NOT survive our per-command CDP
 *      detach, so Playwright's own init-script mechanism is used instead.)
 *
 *  (2) `evaluate` — install on the ALREADY-loaded current document too. Its
 *      monkey-patched wrappers live in the document's own JS, so they keep
 *      buffering after our client disconnects — that is how a LATER command's
 *      `console` / `network requests` still sees activity that happened between
 *      commands on the same document.
 *
 * Both are idempotent (guarded by `window.__silverCap`). `session` is accepted
 * for symmetry / future use. Best-effort; never throws.
 */
export async function ensureCapture(page: Page, session: string): Promise<void> {
  void session
  await page.addInitScript(INSTALLER).catch(() => {})
  await page.evaluate(INSTALLER).catch(() => {})
}

/** Read one capture channel's ring buffer from the page (empty array if absent). */
export async function readCapture(
  page: Page,
  channel: CaptureChannel,
): Promise<Array<Record<string, unknown>>> {
  const out = await page
    .evaluate(`(window.__silverCap && window.__silverCap.${channel}) ? window.__silverCap.${channel}.slice() : []`)
    .catch(() => [])
  return Array.isArray(out) ? (out as Array<Record<string, unknown>>) : []
}

/** Empty one capture channel in the page (best-effort). */
export async function clearCapture(page: Page, channel: CaptureChannel): Promise<void> {
  await page
    .evaluate(`window.__silverCap && (window.__silverCap.${channel}.length = 0)`)
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// Network routing — persisted rules, re-applied on every connection.
// ---------------------------------------------------------------------------

export type RouteRule = {
  /** Playwright URL glob/pattern to intercept. */
  url: string
  /** Abort matching requests. */
  abort: boolean
  /** Fulfill matching requests with this body (mutually exclusive with abort). */
  body?: string
  /** Only intercept these Playwright resource types (else all types match). */
  resourceTypes?: string[]
}

function routesPath(session: string): string {
  return path.join(sessionDir(session), 'routes.json')
}

export async function loadRoutes(session: string): Promise<RouteRule[]> {
  try {
    const arr = JSON.parse(await fs.readFile(routesPath(session), 'utf8')) as unknown
    return Array.isArray(arr) ? (arr as RouteRule[]) : []
  } catch {
    return []
  }
}

async function saveRoutes(session: string, rules: RouteRule[]): Promise<void> {
  await fs.mkdir(sessionDir(session), { recursive: true })
  await fs.writeFile(routesPath(session), JSON.stringify(rules), 'utf8')
}

/** Add (or replace, keyed by url) a route rule. */
export async function addRoute(session: string, rule: RouteRule): Promise<void> {
  const rules = (await loadRoutes(session)).filter((r) => r.url !== rule.url)
  rules.push(rule)
  await saveRoutes(session, rules)
}

/** Remove the rule for `url`, or ALL rules when `url` is undefined. */
export async function removeRoute(session: string, url?: string): Promise<void> {
  if (url === undefined) {
    await saveRoutes(session, [])
    return
  }
  await saveRoutes(session, (await loadRoutes(session)).filter((r) => r.url !== url))
}

function guessContentType(body: string): string {
  const t = body.trim()
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    return 'application/json'
  }
  if (t.startsWith('<')) return 'text/html'
  return 'text/plain'
}

/**
 * Re-materialize all persisted route rules on `page`. No-op (single cheap sidecar
 * read) when no rules exist — safe to call on every connection. Never throws.
 */
export async function applyRoutes(page: Page, session: string): Promise<void> {
  const rules = await loadRoutes(session)
  if (rules.length === 0) return
  for (const r of rules) {
    try {
      await page.route(r.url, async (route) => {
        try {
          if (r.resourceTypes && r.resourceTypes.length > 0) {
            const rt = route.request().resourceType()
            if (!r.resourceTypes.includes(rt)) {
              await route.fallback()
              return
            }
          }
          if (r.abort) {
            await route.abort()
            return
          }
          if (r.body !== undefined) {
            await route.fulfill({ body: r.body, contentType: guessContentType(r.body) })
            return
          }
          await route.continue()
        } catch {
          try {
            await route.continue()
          } catch {
            /* request already handled / route torn down */
          }
        }
      })
    } catch {
      /* invalid pattern or already routed on this page — skip */
    }
  }
}

// ---------------------------------------------------------------------------
// HAR (built from the in-page network buffer — recordHar needs context-creation
// options we cannot set on a CDP-attached context, so we export our own buffer).
// ---------------------------------------------------------------------------

export async function startHar(session: string): Promise<void> {
  const meta = await loadCaptureMeta(session)
  await saveCaptureMeta(session, { ...meta, harRecording: true, harStartedAt: new Date().toISOString() })
}

export async function stopHar(session: string): Promise<void> {
  const meta = await loadCaptureMeta(session)
  const next: CaptureMeta = { ...meta }
  delete next.harRecording
  delete next.harStartedAt
  await saveCaptureMeta(session, next)
}

/** Build a minimal, valid HAR 1.2 log from captured network records. */
export function buildHar(entries: Array<Record<string, unknown>>): unknown {
  return {
    log: {
      version: '1.2',
      creator: { name: 'silver', version: '0.1.0' },
      entries: entries.map((e) => {
        const ts = typeof e.ts === 'number' ? e.ts : Date.now()
        return {
          startedDateTime: new Date(ts).toISOString(),
          time: 0,
          request: {
            method: String(e.method ?? 'GET'),
            url: String(e.url ?? ''),
            httpVersion: 'HTTP/1.1',
            headers: [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: typeof e.status === 'number' ? e.status : 0,
            statusText: '',
            httpVersion: 'HTTP/1.1',
            headers: [],
            cookies: [],
            content: { size: 0, mimeType: '' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          _resourceType: String(e.resourceType ?? 'other'),
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        }
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// Active frame — a stored key (frame name / url substring / iframe selector),
// re-resolved against the live frame tree on each command.
// ---------------------------------------------------------------------------

function framePath(session: string): string {
  return path.join(sessionDir(session), 'frame.json')
}

export async function saveActiveFrame(session: string, key: string): Promise<void> {
  await fs.mkdir(sessionDir(session), { recursive: true })
  await fs.writeFile(framePath(session), JSON.stringify({ key }), 'utf8')
}

export async function clearActiveFrame(session: string): Promise<void> {
  await fs.rm(framePath(session), { force: true }).catch(() => {})
}

async function loadActiveFrame(session: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(framePath(session), 'utf8')) as { key?: unknown }
    return typeof parsed.key === 'string' ? parsed.key : null
  } catch {
    return null
  }
}

/**
 * Find a child frame by (in order): exact frame name, url substring, or an
 * iframe-element CSS selector whose contentFrame we take. Returns null if none
 * match. The main frame is never returned here (that is the "no active frame"
 * default handled by resolveActiveFrame).
 */
export async function findFrame(page: Page, key: string): Promise<Frame | null> {
  const main = page.mainFrame()
  for (const f of page.frames()) {
    if (f !== main && f.name() === key) return f
  }
  for (const f of page.frames()) {
    if (f !== main && key.length > 0 && f.url().includes(key)) return f
  }
  try {
    const handle = await page.locator(key).first().elementHandle({ timeout: 800 })
    if (handle) {
      const cf = await handle.contentFrame()
      if (cf) return cf
    }
  } catch {
    /* not a selector / matched no iframe element */
  }
  return null
}

/**
 * Resolve the frame subsequent selector/eval commands should target: the stored
 * active frame if one is set AND still resolvable, else the main frame.
 */
export async function resolveActiveFrame(page: Page, session: string): Promise<Frame> {
  const key = await loadActiveFrame(session)
  if (!key) return page.mainFrame()
  const f = await findFrame(page, key)
  return f ?? page.mainFrame()
}
