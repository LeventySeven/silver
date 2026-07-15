# Browserbase → moxxie gap-alignment: Stealth / Proxy / Fingerprint (local, keyless subset)

Source: `/Users/seventyleven/Desktop/researchfms/browserbase/BROWSERBASE_GAP_12_STEALTH_INFRA.md` (Parts 2, 3, 5, 6)
moxxie anchor: `/Users/seventyleven/Desktop/moxxie/skill/agent-browser/src/core/session.ts` (`openSession`, lines 85-144; comment "stealth: never advertise automation" at line 102)

## Headline finding

Browserbase's entire stealth/fingerprint/captcha/Web-Bot-Auth stack is explicitly **server-side only** — the SDK "has zero stealth/Web-Bot-Auth/recording-protocol code" (source doc, Summary section). That's the opposite of moxxie's shape: moxxie IS the browser process (local Chromium spawned by `openSession`), so it can't offload stealth to a fleet — but it also means moxxie already controls the one layer BB's SDK explicitly cannot touch (process launch flags + page-level JS). The gap is that moxxie's current launch args (session.ts:96-105) are minimal — just `--remote-debugging-port`, `--user-data-dir`, `--no-first-run`, `--no-default-browser-check`, `--disable-session-crashed-bubble`, and `--headless=new`. There is no `--disable-blink-features=AutomationControlled`, no `addInitScript` fingerprint patching, no proxy plumbing, no locale/viewport/UA control, and no extension loading anywhere in `src/` (verified via repo-wide grep — zero hits for `webdriver|addInitScript|userAgent|viewport|locale|proxy|load-extension|AutomationControlled`, apart from the session.ts comment itself which is currently just a comment, not code).

## Gap-alignment findings

1. **AutomationControlled flag is claimed in a comment but not implemented**
   - source_does: N/A — this is an internal moxxie gap surfaced while reading it against BB's stealth checklist (BB Part 2's #11 "CDP Network.setUserAgentOverride" list implies process-flag-level control is a baseline stealth layer BB's fleet does that moxxie, as the literal browser host, must do itself).
   - moxxie_current: `session.ts:102` has the comment `// stealth: never advertise automation (spec §7)` immediately above `...(opts.headed ? [] : ['--headless=new'])` — the comment promises stealth but the actual flag added is only `--headless=new`. No `--disable-blink-features=AutomationControlled` or `--exclude-switches=enable-automation` is passed to the Chromium launch args.
   - recommendation: align
   - change: In `openSession`'s `args` array (session.ts:96-105), add `'--disable-blink-features=AutomationControlled'`. This is the single highest-leverage flag: it's what makes `navigator.webdriver` false OOTB in current Chromium instead of true, which is the #1 signal cheap bot-detection scripts check first.
   - keyless_ok: true
   - priority: P0
   - evidence: session.ts:96-105 (source: BB GAP_12 Part 2, "navigator.webdriver removal" pattern, lines 330-334)

2. **No page-level fingerprint patch injection (navigator.webdriver, chrome.runtime, plugins, permissions API)**
   - source_does: BB's INFERRED stealth stack (Part 2, "How Stealth Likely Works") lists 11 standard CDP/JS patches: webdriver removal, `chrome.runtime` injection, Permissions API faking, plugins/mimetypes spoofing, WebGL vendor/renderer spoofing, canvas noise, audio noise, font normalization, hardwareConcurrency/deviceMemory spoofing, battery API mock, and `Network.setUserAgentOverride` consistency. These are all standard "playwright-stealth" patches applied via `Page.addScriptToEvaluateOnNewDocument` — no server infra required.
   - moxxie_current: absent. No `context.addInitScript(...)` call anywhere in `src/` (grep confirmed zero hits).
   - recommendation: adopt (partial — the cheap ones only)
   - change: Add a `stealth.ts` module in `core/` that runs once per `connect()` via `context.addInitScript(...)` with the low-cost, high-signal patches only: navigator.webdriver override, `chrome.runtime` stub, Permissions.query override for notifications. Skip canvas/audio/WebGL noise injection (see finding 8, cargo-cult) — those defeat *behavioral fingerprinting at scale* (BB's use case: thousands of scraping sessions needing per-session-unique-but-stable fingerprints) which is not moxxie's threat model (one agent, one task, ephemeral session).
   - keyless_ok: true
   - priority: P0
   - evidence: session.ts (no addInitScript call exists) vs BB GAP_12 Part 2 lines 330-359

3. **No user-supplied proxy plumbing at all**
   - source_does: BB's `proxies` field (top-level `BrowserbaseSessionCreateParams`, Part 5) supports `type: "external"` with `server`, `username`, `password`, `domainPattern` — i.e., bring-your-own-proxy is a first-class, keyless-compatible shape even inside BB's paid product. The managed `type: "browserbase"` residential pool is the paid/cloud part (skip), but the *external proxy passthrough* is pure config plumbing BB's SDK does client-side.
   - moxxie_current: absent. `openSession`/`OpenOptions` (session.ts:29-38) has no `proxy` field; Chromium is always launched with no `--proxy-server` flag.
   - recommendation: adopt
   - change: Add `proxyServer?: string` (and optional `proxyUsername`/`proxyPassword`) to `OpenOptions` (session.ts:29-38), and when set, push `--proxy-server=${opts.proxyServer}` into the `args` array in `openSession` (session.ts:96-105). Auth (`username`/`password`) can be passed via Playwright's `context.route`/`page.authenticate` equivalent for CDP, or simplest: accept `http://user:pass@host:port` inline since Chromium supports that in `--proxy-server` for some proxy types — otherwise document env-var based `PROXY_URL` convention. This lets the host LLM/operator point moxxie at their own proxy (residential, corporate, Tor) with zero moxxie-side cost or API key.
   - keyless_ok: true
   - priority: P1
   - evidence: session.ts:29-38, 96-105 vs BB GAP_12 Part 5 lines 594-617

4. **No locale/timezone/viewport/UA control — every session looks identical**
   - source_does: BB's `fingerprint` schema (Part 2, lines 273-287) exposes `locales`, `operatingSystems`, `screen.{min,max}{Width,Height}` explicitly because "bots often have screen=1024x768 (default headless) which is a giveaway; randomizing within a plausible range defeats simple checks."
   - moxxie_current: absent. `OpenOptions` has no `locale`, `timezoneId`, `viewport`, or `userAgent` fields; every moxxie session launches with Chromium/Playwright defaults, meaning every session run from the same host has an identical, fingerprintable viewport/locale signature.
   - recommendation: align
   - change: Add `viewport?: {width:number,height:number}`, `locale?: string`, `timezoneId?: string` to `OpenOptions` (session.ts:29-38), threaded through to the `context.newPage()`/persistent-context creation (Playwright's `launchPersistentContext` accepts these directly as options — moxxie is spawning Chromium as a detached child process then `connectOverCDP`, so these would need to be applied via CDP `Emulation.setDeviceMetricsOverride` / `Emulation.setLocaleOverride` after connect, or via extra chromium args `--window-size=W,H --lang=xx-XX`). Default to a plausible fixed profile (e.g. 1366x768, en-US) rather than Playwright's bot-typical default, no randomization needed for v1 — just "not the default headless giveaway size."
   - keyless_ok: true
   - priority: P1
   - evidence: session.ts:29-38 vs BB GAP_12 Part 2 lines 269-295

5. **No unpacked-extension loading support**
   - source_does: BB's Extensions API (Part 6, `/v1/extensions`) lets users upload a Chrome extension ZIP that gets loaded into the session's Chromium at startup — used for custom filter lists, credential injectors, human-in-the-loop overlays.
   - moxxie_current: absent. `openSession`'s `args` array has no `--load-extension=` or `--disable-extensions-except=` flags, and `OpenOptions` has no extension path field.
   - recommendation: adopt
   - change: Add `extensionPaths?: string[]` to `OpenOptions`; when present, append `--disable-extensions-except=${paths.join(',')}` and `--load-extension=${paths.join(',')}` to the launch `args` (session.ts:96-105). This is strictly local filesystem paths the operator supplies — zero network/key dependency, and it's the keyless equivalent of BB's upload flow (BB uploads to their cloud; moxxie just points at a local dir).
   - keyless_ok: true
   - priority: P2
   - evidence: session.ts:96-105 vs BB GAP_12 Part 6 lines 687-727

6. **Captcha handling: moxxie has none — should detect-and-report, not attempt to solve**
   - source_does: BB's captcha layer (Part 1) is 100% server-side puzzle-solving (CapSolver/2Captcha-class backend) triggered by `solveCaptchas: true`, plus a client-side "click guard" using 8 CSS selectors (`iframe[src*="recaptcha"]`, `[data-sitekey]`, `[class*="captcha"]`, etc., Part 1 lines 218-230) that suppresses clicks on a solved captcha widget for 3 clicks after solve.
   - moxxie_current: absent — no captcha-related code anywhere in `src/`.
   - recommendation: adopt (the detection half only — solving requires a paid solver API and is INVALID per the hard keyless rule)
   - change: Add a cheap DOM-probe helper (e.g. in a new `perception/captcha.ts` or inline in the existing snapshot/perception module) that runs BB's same 8-selector query (`iframe[title*="reCAPTCHA"]`, `iframe[src*="recaptcha"]`, `iframe[src*="hcaptcha"]`, `iframe[src*="turnstile"]`, `.g-recaptcha`, `[data-sitekey]`, `[class*="captcha"]`, `[id*="captcha"]`) against the page and surfaces a `captchaDetected: boolean` flag (plus matched selector) in whatever snapshot/status payload moxxie already returns to the host LLM. This turns "the agent silently fails on a captcha wall" into "the host LLM is told a captcha is present and can decide to stop, ask the human, or try a different site" — a pure keyless heuristic, no solving attempted.
   - keyless_ok: true
   - priority: P1
   - evidence: no captcha code in src/ vs BB GAP_12 Part 1 lines 218-230

7. **Optional: lightweight local session recording for debugging (small, P2)**
   - source_does: BB's recording (Part 6, confirmed via SDK) is rrweb-based DOM-event capture, chosen specifically over video because it's ~1KB/s vs ~500KB/s and supports built-in password-field masking.
   - moxxie_current: absent — no recording of any kind.
   - recommendation: adopt (minimal version) — but this is a nice-to-have, not core to the stealth lens
   - change: If moxxie ever wants session-replay-for-debugging, CDP's `Page.startScreencast` (already reachable since moxxie connects over CDP) is far simpler to implement than shipping rrweb — write frames to a local file under the session dir on an opt-in flag. This is genuinely optional and out of scope for the stealth/proxy/fingerprint lens; noting it only because Part 6 was read in full per the task's module list.
   - keyless_ok: true
   - priority: P2
   - evidence: session.ts (no recording code) vs BB GAP_12 Part 6 lines 768-813

## Skip-cargo-cult (do NOT adopt — flagged explicitly per task's hard rule)

8. **Canvas/AudioContext/WebGL noise injection, Fingerprint.com partnership, per-session unique-but-stable fingerprints** — SKIP. This entire toolkit (BB Part 2, "How Stealth Likely Works" items 5-6, and the Fingerprint.com partnership section) exists to defeat *fleet-scale* behavioral/identity fingerprinting across thousands of concurrent scraping sessions that need to look like distinct-but-plausible human visitors over time. moxxie's threat model is one agent driving one local browser for one task — there's no "session pool" to keep distinct, and injecting synthetic noise into canvas/audio APIs is pure surface area for new bugs (breaks any site that legitimately reads canvas, e.g. banking/verification flows) for a threat that doesn't apply. Recommendation: skip-cargo-cult.

9. **TLS/JA3-JA4 fingerprint pinning via `httpVersion` and browser-engine spoofing (Edge/Firefox/Safari from a Chromium base)** — SKIP. BB itself notes this "can only be defeated at the network level... not via JS injection" and requires either a patched Chromium binary or a private fork (Part 2, "Why Run Stealth Server-Side" #1). This is fundamentally not reachable from a Playwright/Chromium CLI tool without vendoring a custom browser build — far outside moxxie's scope and value. Recommendation: skip-cargo-cult; document as a known, honest limitation instead of attempting a fake mitigation.

10. **Web Bot Auth (Ed25519 HTTP message signatures, IETF draft, Cloudflare-blessed key directory)** — SKIP as a moxxie feature. This requires *registering as an operator*, publishing a public key at a `.well-known/http-message-signatures-directory` URL, and getting Cloudflare/CDN partners to trust it — an operator-identity/infra commitment, not a local browser capability, and adoption outside Cloudflare is still near-zero per the source doc itself ("Most other CDNs/WAFs do not yet honor it"). Recommendation: skip-cargo-cult (re-evaluate only if IETF adoption becomes widespread and moxxie wants to publish its own operator identity — out of scope for now).

11. **Managed residential proxy pool (`proxies: true` / `type:"browserbase"`), geo-targeted proxy billing, per-domain proxy routing arrays** — SKIP as a moxxie-hosted feature (requires a paid proxy backend, violates keyless-100% rule outright). The *plumbing* for BYO external proxy (finding 3) is the keyless-compatible subset; the managed pool itself is not re-expressible as a local heuristic and should not be attempted.

12. **`verified`/`advancedStealth` mode as a routing switch to a "different fleet of Chromium instances"** — SKIP. This is infrastructure orchestration (session routing to different server pools), meaningless for a single local Chromium process. moxxie has no fleet to route to.

## Top recommendation

Ship finding #1 + #2 together as one PR: add `--disable-blink-features=AutomationControlled` to the Chromium launch args in `openSession` (session.ts:96-105) and add a minimal `context.addInitScript` fingerprint patch (navigator.webdriver override + chrome.runtime stub + Permissions.query override) applied in `connect()` (session.ts:202-212). This closes the single largest gap between "the comment says stealth" and "the code does stealth" for near-zero implementation cost and zero new dependencies — the two cheapest, highest-signal checks that trivial bot-detection scripts run first (`navigator.webdriver === true` and missing `chrome.runtime`).
