# Source Digest: Browserbase — Session Lifecycle, Stealth/Captcha/Bot-Auth Infra

**Source corpus:** `/Users/seventyleven/Desktop/researchfms/browserbase/`
Primary files read in full: `BROWSERBASE_R2_04_SESSION_LIFECYCLE.md`, `BROWSERBASE_R2_05_CAPTCHA_UPSTREAM.md`,
`BROWSERBASE_R2_06_WEB_BOT_AUTH.md`, `BROWSERBASE_R2_07_RECORDING_PIPELINE.md`, `BROWSERBASE_GAP_12_STEALTH_INFRA.md`,
`BROWSERBASE_R3_09_MODEL_GATEWAY.md` (+ skim of `BROWSERBASE_GAP_11_CUA_CLIENTS.md` TOC).

**Framing note:** Browserbase is a *cloud* browser-fleet product (Firecracker microVMs, EKS, per-region k8s services,
S3/CloudFront). Most of its session-lifecycle machinery (allocator, warm pool, regional fleets) is **cloud-infra,
out of scope for a local agent-browser CLI**. What transfers to a local CLI is: (1) the *protocol shapes* it exposes
to clients (console-event signaling, JWE-style session tokens, HLS-style artifact retrieval), (2) the *stealth
patch catalogue* (all locally reproducible via CDP), (3) the *captcha-solver integration pattern* (locally
reproducible by calling the same vendor APIs), and (4) the *Web Bot Auth* identity-signing pattern (fully
implementable in a local egress layer). Each pattern below is flagged CLOUD-ONLY / LOCAL-VIABLE / HYBRID.

---

## Killer Insight

Browserbase's entire stealth/trust stack is built on **layered, swappable black boxes behind a minimal, stable
console/header protocol** — not a monolith. Captcha solving is a 3-console-message protocol
(`browserbase-solving-started/finished/errored`) that abstracts over a multi-vendor solver pool (`captcha-boss`
microservice). Bot identity is a 3-HTTP-header protocol (`Signature`/`Signature-Input`/`Signature-Agent`) that
abstracts over an Ed25519 key-directory service. Recording is a `GET .../recording` endpoint that abstracts over
an entire rrweb→HLS pipeline migration happening underneath it, invisibly, without breaking the SDK contract.
**The lesson for agent-browser: define a tiny, stable, provider-agnostic surface (console events / header triples /
one retrieval verb) and let everything expensive/complex/replaceable live behind it.** This is what let Browserbase
migrate captcha vendors, migrate connect.js from Node to Go, and migrate recording from rrweb to HLS — all without
touching the client SDK. A CLI that adopts the same discipline (e.g. `agent-browser captcha wait`, `agent-browser
identity sign`, `agent-browser session recording get`) can swap its own backing implementation (local extension →
paid API → in-house model) without breaking any agent script built on top of it.

---

## Patterns

### 1. Console-event protocol for async server-side work (captcha solving)
**Tier: CORE**
**What:** Instead of a synchronous "solve this captcha" RPC, Browserbase's browser process emits three
`console.log` magic strings — `browserbase-solving-started`, `browserbase-solving-finished`,
`browserbase-solving-errored` — and the SDK just subscribes to `page.on('console', ...)`. No solver code, no
polling API, ships in the client.
**Why:** Console messages are a universal, already-open channel inside any CDP-controlled browser (no new socket,
no new auth). It decouples "who solves it and how" from "how the agent knows it happened." This is the same
pattern a local CLI needs for any async in-page side effect it doesn't want to poll for (captcha solves, extension
callbacks, OAuth popups closing).
**How to implement:** Define a small set of reserved console-log strings (e.g. `agentbrowser-captcha-started`,
`-finished`, `-errored`) that any injected content script / extension can emit. CLI's session driver subscribes to
`Page.consoleAPICalled` and exposes a blocking `wait_captcha` command with a hard timeout (see #2).
**Evidence:** `BROWSERBASE_GAP_12_STEALTH_INFRA.md` Part 1 "Discovery — Architecture is Server-Side, Client Just
Observes"; `BROWSERBASE_R2_05_CAPTCHA_UPSTREAM.md` §8 (`captchaSolver.ts` verbatim: `SOLVING_STARTED`,
`SOLVING_FINISHED`, `SOLVING_ERRORED` constants).
**Local-viability:** LOCAL-VIABLE — the pattern itself is CDP-native and needs zero cloud infra.

### 2. Hard timeout + fail-open on captcha/async waits, with shared-promise coalescing
**Tier: CORE**
**What:** `SOLVE_TIMEOUT_MS = 90_000` is a hard client-side ceiling independent of whatever the upstream solver
does. If solving is in-flight when multiple call sites (agent loop + CUA loop) call `waitIfSolving()`
simultaneously, they all share one `Promise` and one deadline — no duplicate listeners, no double-fire.
**Why:** Third-party solvers are unreliable (1–3% timeout rate per the reverse-engineered docs); the caller must
degrade gracefully to an error state and let the agent try an alternate path, rather than hang the whole session.
**How to implement:** A `CaptchaSolver` class with `init(pageProvider)`, `waitIfSolving()` (returns cached in-flight
promise if present), `consumeSolveResult()` returning `{solved, errored}` and resetting flags. Call
`waitIfSolving()` as a pre-step gate before every agent action, not just once at the top of the loop.
**Evidence:** `BROWSERBASE_R2_05_CAPTCHA_UPSTREAM.md` §8 points 2–5 ("waitIfSolving() is a blocking gate before
every agent step", "Shared promise pattern", "Timeout = error path"); `BROWSERBASE_GAP_12_STEALTH_INFRA.md` "Concurrent
Wait Coalescing" and "consumeSolveResult() Pattern".
**Local-viability:** LOCAL-VIABLE — pure client-side control-flow pattern.

### 3. System-prompt injection to suppress agent interference during async solves
**Tier: CORE**
**What:** Verbatim system-prompt strings are injected into the LLM's context the moment a captcha resolves (or
errors), explicitly instructing the model not to re-click the widget "even if it does not visually appear solved."
Separate strings exist for DOM/hybrid agents vs. vision-grounded CUA agents.
**Why:** Vision models literally see an unchecked captcha checkbox after token-injection-based solving (the token
is injected directly into a hidden form field, not via simulated click-through) and will try to "fix" it,
colliding with the in-flight/just-completed solve. This is a fingerprint-of-the-mechanism level detail: because BB
solves via **token injection**, not click-simulation, the widget never visually updates.
**How to implement:** Ship four canned prompt fragments (solved / errored / DOM-system-note / CUA-system-note) and
splice them into the message stream at the exact turn after a `waitIfSolving()` resolves. Keep the "even if it
still looks unresolved" framing — it is load-bearing for vision models.
**Evidence:** `BROWSERBASE_R2_05_CAPTCHA_UPSTREAM.md` §8 point 1 (verbatim `CAPTCHA_SOLVED_MSG`,
`CAPTCHA_ERRORED_MSG`, `CAPTCHA_SYSTEM_PROMPT_NOTE`, `CAPTCHA_CUA_SYSTEM_PROMPT_NOTE`).
**Local-viability:** LOCAL-VIABLE.

### 4. Anti-double-click guard: bounding-box gated click suppression, N-action window
**Tier: IMPORTANT**
**What:** For the 3 actions immediately following a captcha solve, every click is checked against 8 CSS-selector
bounding boxes (`iframe[title*="reCAPTCHA"]`, `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`,
`iframe[src*="turnstile"]`, `.g-recaptcha`, `[data-sitekey]`, `[class*="captcha"]`, `[id*="captcha"]`). Clicks
inside those boxes are silently dropped and replaced with a context note. The guard window is **N clicks, not N
seconds** — it decays with agent activity, not wall-clock time.
**Why:** A vision-grounded CUA agent decides where to click from a stale screenshot; a hard geometry check is a
cheap, deterministic safety net that doesn't require re-prompting the model.
**How to implement:** Maintain a decrementing counter (`captchaClickGuardRemaining = 3` on success, `0` on error);
before dispatching any click action, evaluate the 8 selectors in-page, get bounding rects, and compare to the
target (x,y). Inject a "captcha already solved, click skipped" note back into the agent transcript on skip.
**Evidence:** `BROWSERBASE_GAP_12_STEALTH_INFRA.md` "Anti-Double-Click Guard (KNOWN — v3CuaAgentHandler.js)" with
verbatim selector list and skip-message text.
**Local-viability:** LOCAL-VIABLE.

### 5. Dedicated captcha orchestrator behind the console-event facade — multi-vendor failover pool
**Tier: IMPORTANT (architecture) / CLOUD-ONLY (the microservice itself)**
**What:** Browserbase runs a per-region `captcha-boss` microservice (discovered via CT logs, VPC-internal, gRPC on
port 50051) that routes solve requests to a **pool of commercial solver vendors** (best-hypothesis primary:
CapSolver; secondary: 2Captcha API tier; tertiary: Anti-Captcha/CapMonster), plus **in-house OCR** for the
`captchaImageSelector`/`captchaInputSelector` legacy image-captcha path. Founder quote confirms: "we integrate a
bunch of different CAPTCHAs... we do some stuff in-house, but generally we just integrate with a bunch of known
vendors" and a BB engineer's explicit "we do not use click farms" rules out human-solver tiers.
**Why for the CLI:** A local agent-browser CLI can't run a VPC microservice, but it CAN replicate the *shape*: an
adapter interface with health-tracked, failover-ordered vendor adapters (CapSolver `createTask`/`getTaskResult`
polling; 2Captcha `in.php`/`res.php` polling), each with a per-vendor timeout budget summing to under the 90s
client ceiling, plus a cheap local OCR fallback (Tesseract/TrOCR) for simple image captchas.
**How to implement (replication recipe, verbatim from source):**
```python
async def solve(req):
    if req.type == 'image-ocr':
        return await in_house_ocr(req.image_data)
    for vendor in vendor_pool.ordered_by_health():
        try:
            token = await asyncio.wait_for(vendor.solve(req.type, req.sitekey, req.pageurl), timeout=85)
            vendor.record_success(); return token
        except (TimeoutError, VendorError):
            vendor.record_failure(); continue
    raise CaptchaSolveError("all vendors failed")
```
CapSolver adapter: `POST https://api.capsolver.com/createTask` with
`{clientKey, task: {type: 'ReCaptchaV2TaskProxyless'|'HCaptchaTaskProxyless'|'AntiTurnstileTaskProxyless',
websiteURL, websiteKey}}`, poll `getTaskResult` every 2s up to 40 times, extract
`data.solution.gRecaptchaResponse`.
Token injection points (verbatim): reCAPTCHA →
`document.querySelector('textarea[name=g-recaptcha-response]').value = token` + dig into
`window.___grecaptcha_cfg.clients[...].callback(token)`; hCaptcha →
`textarea[name=h-captcha-response]`; Turnstile → `input[name=cf-turnstile-response]` +
`window.turnstile.execute(widgetId)`.
**Evidence:** `BROWSERBASE_R2_05_CAPTCHA_UPSTREAM.md` §6 (captcha-boss cert-transparency discovery), §11 (Paul
Klein quote), §23 (full replication recipe with CapSolver adapter code, cost model: ~$0.001 marginal cost/session
at 1M sessions/mo, 30% captcha rate).
**Local-viability:** HYBRID — orchestration logic is local; vendor calls are third-party APIs (need API keys), no
Browserbase-specific cloud dependency.

### 6. `captchaImageSelector`/`captchaInputSelector` — user-supplied DOM hooks for legacy OCR captchas
**Tier: NICE
**What:** A dedicated escape hatch in session config for old-style "read distorted text, type into box" captchas
that don't use a known vendor's widget. The user supplies two CSS selectors (image, input); the solving layer
screenshots the image element and OCRs it, or forwards to a vendor's ImageToTextTask endpoint.
**Why:** Vendor-agnostic captcha detection (iframe src matching, `data-sitekey`) covers ~95% of real-world
captchas, but arbitrary internal/legacy sites need a manual override. Cheap to build, closes a long tail.
**How to implement:** Session/task config field `captcha: {imageSelector, inputSelector}`; if present, on
detection-miss for known vendors, screenshot the `imageSelector` element and OCR locally (Tesseract) or via a
vendor `ImageToTextTask` call, then type the result into `inputSelector`.
**Evidence:** `BROWSERBASE_R2_05_CAPTCHA_UPSTREAM.md` §2; `BROWSERBASE_GAP_12_STEALTH_INFRA.md` "Fingerprint
Configuration Schema" / `BrowserSettings` schema block.
**Local-viability:** LOCAL-VIABLE.

### 7. Full stealth-patch catalogue, applied via CDP `Page.addScriptToEvaluateOnNewDocument` — no browser fork needed
**Tier: CORE**
**What:** Browserbase ships NO stealth code in its SDK; all patches are applied server-side to the Chromium
process, reproducible entirely via standard CDP calls (no private browser fork required, confirmed by the
`browserbasehq/playwright` GitHub 404). Catalogue (11 patches, all standard "playwright-stealth"-class techniques):
`navigator.webdriver` removal, `window.chrome` runtime object injection, Permissions API query override, plugins/
MimeTypes array spoofing, WebGL vendor/renderer (`UNMASKED_VENDOR_WEBGL`=0x9245/`UNMASKED_RENDERER_WEBGL`=0x9246)
override, canvas `toDataURL` noise injection, `AudioBuffer.getChannelData` noise injection, font-enumeration
normalization, `navigator.hardwareConcurrency`/`deviceMemory` spoofing, `navigator.getBattery()` mock, and CDP
`Network.setUserAgentOverride` to keep UA + platform + Client Hints internally consistent (a common bug source:
mismatched UA string vs `Sec-CH-UA-Platform`).
**Why:** Every one of these is a documented, individually-checkable fingerprint surface used by DataDome/Akamai/
PerimeterX/Kasada-class detectors. The insight for a CLI: **this entire stack requires zero cloud infrastructure**
— it's CDP script injection plus a handful of `Emulation.*`/`Network.*` overrides, runnable against any local
Chromium.
**How to implement:** Bundle a single `stealth-inject.js` that does all 11 patches, injected via
`Page.addScriptToEvaluateOnNewDocument` on every new document (so it survives navigations). Pair with
`Network.setUserAgentOverride` set consistently at session start, not per-navigation.
**Evidence:** `BROWSERBASE_GAP_12_STEALTH_INFRA.md` Part 2 "How Stealth Likely Works (INFERRED)" — all 11 code
snippets verbatim, plus "Browserbase Playwright Fork — NOT PUBLIC" analysis concluding CDP-runtime-only, no fork.
**Local-viability:** LOCAL-VIABLE — this is the single most directly transferable pattern in the whole source.

### 8. `verified`/fingerprint config schema as a structured, declarative stealth-intent API
**Tier: IMPORTANT**
**What:** Session creation accepts a structured `fingerprint` object — `browsers` (chrome/edge/firefox/safari),
`devices` (desktop/mobile), `httpVersion` ("1"|"2", a TLS/JA3-JA4 fingerprint lever), `locales`,
`operatingSystems`, `screen` (min/max width/height ranges) — resolved server-side into concrete UA/viewport/locale
values, applied partly at pool-selection time (OS/locale) and partly at runtime via CDP `Emulation.*`.
**Why:** Declarative-intent config ("give me a plausible Windows+Chrome+en-US fingerprint") is more robust than
requiring the caller to hand-pick a UA string — the resolver can keep an up-to-date pool of *coherent* fingerprint
tuples (UA + platform + font list + screen must all agree) instead of the caller assembling an incoherent one.
**How to implement:** Define the same schema locally; maintain a small table of coherent (UA, platform, screen
range, font-set, locale) tuples per OS/browser combination, randomly select within the caller's declared
constraints, apply as a single atomic `Emulation.setUserAgentOverride` + `Emulation.setDeviceMetricsOverride` +
`Emulation.setLocaleOverride` batch so nothing is left inconsistent mid-session.
**Evidence:** `BROWSERBASE_GAP_12_STEALTH_INFRA.md` "Fingerprint Configuration Schema (KNOWN — from Zod schema)";
`BROWSERBASE_R2_04_SESSION_LIFECYCLE.md` §12 "Browser Fingerprint Resolution Pipeline" (two-layer: pool
partitioning + runtime CDP injection).
**Local-viability:** LOCAL-VIABLE (the resolver logic); the *pool of pre-warmed OS images* is cloud-only, but a
local CLI just needs one coherent tuple per launch, not a warm pool.

### 9. Web Bot Auth: cryptographic bot-identity signing as an alternative to stealth (HTTP Message Signatures / RFC 9421)
**Tier: IMPORTANT**
**What:** A parallel, opposite strategy to stealth: sign every outbound request with Ed25519 via RFC 9421 HTTP
Message Signatures (`Signature`, `Signature-Input`, `Signature-Agent` headers, `tag="web-bot-auth"`), publish
public keys at `/.well-known/http-message-signatures-directory` (a self-signed JWKS), and let sites/CDNs
(Cloudflare, Fingerprint.com) verify and *allowlist* the bot rather than trying to fool them. Captured live and
fully decoded: BB signs with `alg=ed25519`, `expires` ~60–3600s window, `nonce` ≥64 bytes, `tag="web-bot-auth"`;
keyid = base64url JWK SHA-256 thumbprint (RFC 8037 §A.3 canonicalization → JCS → SHA-256 → base64url-nopad).
**Why:** Stealth is an arms race that degrades over time; cryptographic identity is a durable trust primitive for
sites that opt in. For agent-browser, offering *both* modes (stealth-by-default, sign-if-configured) covers more
of the web than either alone — and signing is trivial to implement locally (no cloud dependency at all).
**How to implement (verbatim recipe from source):**
- Directory service: generate an Ed25519 keypair, publish `{keys:[{kty:"OKP",crv:"Ed25519",kid:<thumbprint>,
  x:<pubkey-b64url>,use:"sig"}]}` at the well-known path with `Cache-Control: public, max-age=3600`, and
  **self-sign the directory response** (each key signs `("@authority")` with itself — this is the part most
  competitors like OpenAI skip, per the cross-reference in the source).
- Egress signer: for every outbound request, compute
  `Signature-Input: bb=("@authority" "@target-uri" "signature-agent";key="bb");created=<now>;expires=<now+60>;
  keyid="<thumbprint>";alg="ed25519";nonce="<64B b64url>";tag="web-bot-auth"`, sign the RFC 9421 canonical base,
  attach as `Signature: bb=:<sig>:` and `Signature-Agent: bb="https://<your-directory-host>"`.
- Rotate: keep 2 overlapping keys, add-new → wait one cache window → promote → retire-old.
- Register with Cloudflare: Dashboard → Bot Submission Form → Verification Method = "Request Signature" →
  point at your directory URL.
**Evidence:** `BROWSERBASE_R2_06_WEB_BOT_AUTH.md` §1–§5 (full spec read + live-captured directory JSON + header
dump), §10 (full TypeScript directory-publisher + Rust egress-signer code), §5.6 (OpenAI comparison — OpenAI's
directory is NOT self-signed, Cloudflare accepts it anyway, meaning self-signing is best-practice-but-optional).
**Local-viability:** LOCAL-VIABLE — this is a pure crypto + HTTP-header pattern; the "directory" just needs to be
served from any HTTPS host the CLI's operator controls (even a GitHub Pages / Cloudflare Pages static file).

### 10. Credential brokering via e2e-encrypted channel, never through the LLM or logs (1Password Noise-protocol pattern)
**Tier: IMPORTANT**
**What:** Separate from Web Bot Auth: a headless credential-manager extension inside the browser sandbox opens a
Noise-protocol (WireGuard-primitive) end-to-end encrypted channel directly to the human's local password-manager
device. Every autofill triggers a human approval prompt; only the approved item, still encrypted to the
extension's session key, crosses the automation platform's boundary; the LLM only ever sees "fill triggered,
status: ok" — never plaintext. Session recording/logging pipelines must explicitly redact fields flagged as
credential carriers.
**Why:** This is the correct trust boundary for "let an agent log into things" — the automation platform (and the
model driving it) is explicitly kept out of the plaintext-secret path, which is both a security property and a
liability-limiting one.
**How to implement:** (a) pairing handshake between a local credential-manager companion app and a headless
extension injected into the CLI's browser session; (b) per-fill human-approval prompt on the companion device,
never "always allow"; (c) redaction layer in whatever session-log/recording sink the CLI has, filtering any field
DOM-tagged as a password/TOTP input before it's ever written to disk.
**Evidence:** `BROWSERBASE_R2_06_WEB_BOT_AUTH.md` §7 (full protocol quote from 1Password's press release +
architecture diagram + "Secrets never pass through or become visible to the AI" verbatim).
**Local-viability:** LOCAL-VIABLE in principle (Noise is a standard, implementable protocol) but is a substantial
build — flag as a stretch goal, not MVP.

### 11. Signed short-lived session-routing tokens (JWE, not JWT) to hide internal topology from the client
**Tier: NICE (mostly CLOUD-ONLY, but the crypto-hygiene lesson transfers)**
**What:** Browserbase's `connectUrl` embeds a `signingKey` that is a **JWE** (encrypted), not a JWT (merely
signed) — `alg=dir`, `enc=A256GCM`. The payload (`sessionId, podHost, podPort, exp`) is only decryptable
server-side; the client can't introspect where its session is actually routed. Two auth modes are mutually
exclusive by design (`apiKey` XOR `signingKey`) with hard 400s for combinations.
**Why relevant to a local CLI:** For a purely local CLI there's no "hide internal routing from the client" problem
(client and server are the same process). But the *pattern* — never leak infra topology in a token even when you
don't strictly need to — is good hygiene if the CLI ever grows a remote/multi-machine mode (e.g. a fleet manager
dispatching sessions to worker machines). Worth noting as a forward-looking design constraint, not an MVP need.
**Evidence:** `BROWSERBASE_R2_04_SESSION_LIFECYCLE.md` §6–§7 (JWE cryptographic inference, verbatim error
messages proving `jose`'s `jwtDecrypt()` is used, mutually-exclusive auth-mode error matrix).
**Local-viability:** CLOUD-ONLY as literally practiced; the underlying discipline (don't leak topology in tokens)
is a nice-to-have design note for any future distributed mode.

### 12. Adaptive-rate visual session recording: capture only on change, encode async, HLS-multiplex tabs as variants
**Tier: NICE**
**What:** Browserbase pivoted from rrweb DOM-event recording to raw PNG-frame capture ("if nothing changes for 10
seconds, capture nothing; if the page is animating, capture more"), explicitly rejecting JPEG (CPU cost) and
WebRTC (steals CPU from the automation workload) in favor of lossless PNG streamed off-browser immediately, then
encoded async by a worker pool (ffmpeg → fMP4) with **10-second segment boundaries**, and only the first ~30s
eagerly encoded (rest is lazy, gated on the fact that "only ~8% of sessions are ever replayed" — an explicit
economics-driven laziness decision). Multiple tabs are multiplexed as **HLS variants** (normally used for
bitrate ladders) sharing one global timeline, so switching tabs in the player is a variant switch, not a
timestamp jump.
**Why for a CLI:** A local agent-browser CLI that wants "session replay for debugging" doesn't need S3/CloudFront,
but the *capture discipline* is directly reusable: don't screenshot on a fixed timer, screenshot on
render-change; don't block the page paint (use `HeadlessExperimental.beginFrame` for offscreen rasterization
rather than a blocking `Page.captureScreenshot` loop); encode lazily, not eagerly, since most recordings are never
watched.
**How to implement locally:** write PNG frames to a local temp dir keyed by `tab-{targetId}/{timestamp}.png` on a
change-hash trigger (naive: hash the screenshot bytes and skip identical frames — source flags this as
"CALIBRATE", the real signal is a paint/animation CDP event, not polling); on-demand (not eager) run `ffmpeg -f
concat` with variable per-frame duration into a single MP4 per tab when the user actually asks to view/export a
replay.
**Evidence:** `BROWSERBASE_R2_07_RECORDING_PIPELINE.md` §2.3 (capture architecture, verbatim blog quotes on PNG
vs JPEG vs WebRTC rejection reasoning), §7.2–7.3 (Go capture sidecar + Python ffmpeg encoder code, including the
`tfdt` box byte-patch needed because parallel-encoded fMP4 segments all start at ts=0 by default — "There is no
flag, filter, or muxer option that fixes this for HLS. It's byte-level surgery.").
**Local-viability:** HYBRID — capture-on-change + lazy-encode logic is fully local; HLS/CloudFront/S3 delivery is
cloud-scale infra a local CLI doesn't need (a flat local MP4 file per session is the right-sized replacement).

### 13. Live-view vs. recording are architecturally separate planes — don't conflate them
**Tier: IMPORTANT (design lesson)**
**What:** Browserbase cleanly separates three distinct URL/data planes per session: `connectUrl` (CDP
control, read/write, wss), `debugUrl`/`wsUrl` (a live DevTools-Frontend-in-an-iframe view, real-time, also
read/write via the *same* CDP channel — a human "taking over" fights over the same target as the agent), and the
recording artifact (post-hoc, read-only, entirely separate storage/pipeline). Disconnect signaling for the
live-view iframe is a `postMessage("browserbase-disconnected")` to the parent window — a clean, documented
contract for embedding.
**Why:** Conflating "watch live" and "watch replay" leads to either paying live-stream costs for replay use cases
or losing replay fidelity trying to reuse a live pipeline. Keep them as separate subsystems from day one.
**How to implement:** A CLI's "show me what's happening" (attach a local devtools/CDP viewer to the running
session) should be a thin proxy over the browser's own `--remote-debugging-port` (Chrome already serves
`/json`, `/json/list`, `/json/version`, `/devtools/inspector.html` for free) — don't build a custom live-view
renderer. Recording/export is a separate, decoupled feature.
**Evidence:** `BROWSERBASE_R2_07_RECORDING_PIPELINE.md` §4 ("The two URLs vs. recording — DIFFERENT pipelines"
table + "Why Live View is read+write by default"); `BROWSERBASE_R2_04_SESSION_LIFECYCLE.md` §6 (CDP discovery
endpoints `/json`, `/json/list`, `/json/protocol`, `/json/version`, `/json/new` proxied verbatim from Chrome's own
`--remote-debugging-port` HTTP API).
**Local-viability:** LOCAL-VIABLE — and actually *easier* locally since Chrome already exposes this for free on
localhost; no proxying needed at all for a single-machine CLI.

### 14. Proxy assignment is a Chrome-launch-time decision, not a runtime-injectable one — budget for it
**Tier: NICE**
**What:** Proxies must be set via `--proxy-server=` Chrome CLI flag at launch (plus a `chrome.webRequest.onAuthRequired`-handling extension for proxy auth) because DNS resolution and TLS happen inside the browser process through the proxy. This is NOT a runtime CDP-injectable setting like UA or locale — sessions requesting a proxy pay a Chrome-cold-boot cost (BB's data: 2–5s extra) vs. proxy-less sessions reusing an already-running warm instance.
**Why for a CLI:** If the CLI wants to support "route this session through a proxy," it must launch (or relaunch)
Chrome with the flag set — it cannot retrofit proxy config onto an already-running browser instance. Document this
constraint explicitly so callers don't assume a mid-session proxy switch is possible.
**How to implement:** `chrome --proxy-server=http://host:port ...` at spawn time; for proxy auth, either use
`http://user:pass@host:port` inline (works for most proxies) or inject a small extension handling
`webRequest.onAuthRequired`. Per-domain proxy routing (Browserbase's `domainPattern` array) requires either
multiple browser contexts or a local forward-proxy layer (e.g. a mitmproxy instance) that does the per-domain
routing itself and presents Chrome with a single upstream.
**Evidence:** `BROWSERBASE_R2_04_SESSION_LIFECYCLE.md` §11 (full proxy-assignment pipeline pseudocode, "Chrome
already running... instant" vs "launch Chrome inside the picked microVM with the proxy CLI flag... adds 2-5s");
`BROWSERBASE_GAP_12_STEALTH_INFRA.md` Part 5 (`proxies` schema: boolean | array of `{type: browserbase|external,
domainPattern, geolocation|server/username/password}`).
**Local-viability:** LOCAL-VIABLE.

### 15. Model-routing via a thin universal-prefix passthrough (`provider/model-name`) instead of a custom router
**Tier: IMPORTANT (for any CLI feature that calls multiple LLM providers, e.g. its own CUA loop)**
**What:** Browserbase writes almost no LLM-routing code itself. It's a thin wrapper over Vercel AI Gateway's
`generateText({model: 'anthropic/claude-opus-4.6', ...})` — a single `creator/model-name` string selects
provider, and the Gateway/AI-SDK handles per-provider request-shape translation, failover, retries, and spend
metering. Legacy bare model names (`'gpt-4o'`) are translated via a small (~24-entry) compatibility table with a
`console.warn` deprecation path rather than a hard break.
**Why:** If agent-browser ever needs to drive its own multi-provider CUA loop (Anthropic computer-use, OpenAI
computer-use-preview, Gemini, etc.), don't write bespoke per-provider HTTP clients — adopt (or build) a single
`provider/model` string convention and a thin adapter layer, and keep an explicit backward-compat shim table
rather than breaking existing configs on rename.
**How to implement:** `resolveModel(name)`: if it contains `/`, pass through; else look up in a small legacy-name
table, warn-and-translate; else throw with a clear "use provider-prefixed names" message.
**Evidence:** `BROWSERBASE_R3_09_MODEL_GATEWAY.md` §1–§4 (endpoint, provider-prefix table of 19 providers, sample
calls in TS/Python/cURL, `modelToProviderMap` 24-entry compatibility table with warn-not-throw code).
**Local-viability:** LOCAL-VIABLE — this is a design pattern, not an infra dependency (a CLI can either use Vercel
AI Gateway itself, or replicate the thin-adapter idea with direct provider SDKs).

---

## Command Surface (verbatim / near-verbatim)

**Console-event protocol (captcha):**
```
console.log("browserbase-solving-started")
console.log("browserbase-solving-finished")
console.log("browserbase-solving-errored")
SOLVE_TIMEOUT_MS = 90_000
```

**Session create → connect (SDK-level shape worth mirroring for a local session handle):**
```
POST /v1/sessions  {projectId, region, browserSettings: {...}, proxies, keepAlive}
  -> 201 {id, connectUrl: "wss://.../?apiKey=...|signingKey=...", seleniumRemoteUrl, signingKey, status}
GET  /v1/sessions/{id}/debug
  -> {debuggerFullscreenUrl, debuggerUrl, wsUrl, pages: [{id, url, faviconUrl, title, debuggerUrl, debuggerFullscreenUrl}]}
GET  /v1/sessions/{id}/recording   -> Array<{data, sessionId, timestamp, type}>  (rrweb; DEPRECATED path)
```
CDP discovery endpoints proxied verbatim from Chrome's own debug port (free on any local Chromium too):
```
GET /json          GET /json/list        GET /json/protocol
GET /json/version  GET /json/new
```

**BrowserSettings config surface worth mirroring in a local session-config schema:**
```typescript
{
  advancedStealth: boolean,           // == verified
  blockAds: boolean,
  captchaImageSelector: string,
  captchaInputSelector: string,
  context: { id: string, persist: boolean },
  extensionId: string,
  fingerprint: {
    browsers: ("chrome"|"edge"|"firefox"|"safari")[],
    devices: ("desktop"|"mobile")[],
    httpVersion: "1"|"2",
    locales: string[],
    operatingSystems: ("android"|"ios"|"linux"|"macos"|"windows")[],
    screen: { maxHeight, maxWidth, minHeight, minWidth }
  },
  os: "mobile"|"linux"|"windows"|"mac"|"tablet",
  recordSession: boolean,
  solveCaptchas: boolean,
  verified: boolean,
  viewport: { width, height }
}
proxies: boolean | Array<
  {type:"browserbase", domainPattern?, geolocation?: {country, city?, state?}} |
  {type:"external", server, domainPattern?, username?, password?}
>
```

**Web Bot Auth header triple (RFC 9421 / draft-meunier-web-bot-auth):**
```
Signature-Agent: bb="https://your-domain/"
Signature-Input: bb=("@authority" "@target-uri" "signature-agent";key="bb")
  ;created=<unix>;expires=<unix+60>;keyid="<jwk-thumbprint>";alg="ed25519"
  ;nonce="<64B base64url>";tag="web-bot-auth"
Signature: bb=:<base64 ed25519 sig>:
```
Directory: `GET /.well-known/http-message-signatures-directory` →
`Content-Type: application/http-message-signatures-directory+json`,
body `{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"<thumbprint>","x":"<pubkey-b64url>","use":"sig"}]}`.

**CapSolver vendor adapter (for the local captcha-solving replacement of `captcha-boss`):**
```
POST https://api.capsolver.com/createTask
  {clientKey, task: {type: "ReCaptchaV2TaskProxyless"|"HCaptchaTaskProxyless"|"AntiTurnstileTaskProxyless",
                      websiteURL, websiteKey}}
POST https://api.capsolver.com/getTaskResult   {clientKey, taskId}
  -> poll ~2s interval, up to ~40x; on status:"ready" -> solution.gRecaptchaResponse
```

**Model gateway (multi-provider LLM call convention worth adopting for any CUA loop):**
```ts
generateText({ model: 'anthropic/claude-opus-4.6', prompt })   // provider/model string, no custom HTTP code
```

---

## Anti-Patterns (do NOT copy as-is)

1. **Do not build a cloud microVM/EKS fleet to get "session isolation."** Browserbase's entire allocator/warm-pool/
   Firecracker-per-session architecture (`BROWSERBASE_R2_04_SESSION_LIFECYCLE.md` §3, §11, §15) is solving a
   multi-tenant SaaS problem (many strangers sharing infra) that a local single-operator CLI does not have. Copying
   this would be enormous, unjustified over-engineering — a local CLI's "isolation" is just an OS process / temp
   profile dir.
2. **Do not blindly trust the "argon2 auth costs 700ms" finding as something to replicate.** That's an artifact of
   Browserbase's multi-tenant API-key auth model (`BROWSERBASE_R2_04_SESSION_LIFECYCLE.md` §5, §9); a local CLI
   authenticates to nothing of its own and should not add deliberate latency anywhere.
3. **Do not chase "which captcha vendor exactly does Browserbase use" as an implementation requirement.** The
   entire §5/§6/§11/§15/§21/§22 vendor-identification chase in `BROWSERBASE_R2_05_CAPTCHA_UPSTREAM.md` is
   speculative (confidence explicitly labeled MEDIUM/MEDIUM-HIGH) and functionally irrelevant — any AI-tier vendor
   (CapSolver, 2Captcha API tier, Anti-Captcha) works equivalently. Don't burn CLI-build time reverse-engineering
   which one Browserbase picked; just pick one and make the adapter interface swappable.
4. **Do not adopt JWE-encrypted session-routing tokens for a single-machine local CLI.** Pattern #11 above — the
   entire point of hiding pod IPs in an encrypted token is to prevent an untrusted *client* from learning a
   multi-tenant cloud's internal topology. A local CLI's client and "server" are the same trust domain; this is
   pure cargo-cult complexity if copied without a genuine remote/distributed use case.
5. **Do not build a signed-CDN-URL + S3 + CloudFront + multi-region-replication pipeline for local session
   recordings.** (`BROWSERBASE_R2_07_RECORDING_PIPELINE.md` §3, §6.) A flat local video/GIF file per session
   achieves the same debugging value at near-zero engineering cost. Only the *capture discipline* (§12 above:
   change-triggered frame capture, lazy encode) is worth taking — the storage/delivery half of that pipeline is
   pure cloud-SaaS plumbing.
6. **Do not treat "purpose: rag" / "purpose: ai" directory fields as spec-required.** Both Browserbase and OpenAI
   ship a field that was explicitly **removed in draft v03** of the Web Bot Auth spec
   (`BROWSERBASE_R2_06_WEB_BOT_AUTH.md` §5.7) — it's legacy cruft from an early draft version. A fresh
   implementation should follow the current draft, not copy this dead field forward.
7. **Do not skip the directory self-signing step "because OpenAI's directory doesn't do it either and Cloudflare
   accepts it anyway."** (§5.6, §5.8 in the Web Bot Auth file.) That's evidence Cloudflare's verifier is lenient
   today, not evidence the spec doesn't require it — self-signing is cheap to implement and future-proofs against
   stricter verifiers.
