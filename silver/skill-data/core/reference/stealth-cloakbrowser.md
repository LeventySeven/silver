# Anti-detection: stealth without the fragile JS (CloakHQ alignment)

Some sites (Cloudflare, DataDome, PerimeterX, FingerprintJS) block automated
browsers by fingerprinting the browser itself. Silver's stance is **authenticity,
not deception**: run a *real* browser that doesn't advertise automation — never a
brittle JS spoof layer, and never anything that defeats a site's consent controls
on a site you don't own.

## What Silver does by default (free, always on)

- **No `--enable-automation`** and **`--disable-blink-features=AutomationControlled`**
  on every spawned session. This removes the single most common tell:
  `navigator.webdriver` is `false` (not `true`), at the Blink-flag level — a stable
  Chromium flag, not fragile JS. That's the whole of Silver's built-in de-tell; it
  deliberately stops there rather than stacking flags into an arms race.

## Real fingerprint authenticity: launch a stealth binary (opt-in)

The deep fingerprint fixes — canvas, WebGL, audio, fonts, GPU, WebRTC, and
especially **TLS/JA3/JA4** (which lives below JS *and* below CDP, so Silver
structurally cannot fake it) — only exist in a browser whose Chromium was patched
at the C++ source level. Silver does **not** reimplement any of that in JS (that
path is brittle, and inconsistent JS spoofs *increase* detectability). Instead,
point Silver at such a binary — you obtain it yourself; Silver never downloads or
bundles it:

- **Owned session (Silver manages its lifecycle):**
  `silver open <url> --exec-path /path/to/stealth-chromium`
  or set `SILVER_BROWSER_EXECUTABLE=/path/to/stealth-chromium` once (survives an
  auto-respawn). A missing path fails with a clear `browser_execpath_missing`.
- **Attach to one you launched yourself (zero Silver config):** start the stealth
  binary with `--remote-debugging-port=9222`, then `silver connect 9222`. Silver
  drives it over CDP exactly like any session.

Either way Silver's perception/actuation stack is unchanged (standard CDP), and
**every security guard stays intact** — the egress allowlist, redaction, and path
containment are Node-layer checks that run *before* any navigation/fetch/write,
independent of which browser binary is on the other end.

## What Silver will NOT add (kept out on purpose)

- **JS canvas/WebGL/font spoofing** — fragile, arms-race, and self-inconsistent
  with the C++ layer. Belongs in the binary, not in Silver.
- **Human-like mouse/keystroke cadence** — the binary's own opt-in `humanize`
  handles behavioral realism; a stochastic mimicry layer here would only muddy
  Silver's deterministic, reproducible snapshot→act model, and its sole purpose is
  to defeat *behavioral* bot-detection (consent-adjacent).
- **CAPTCHA/Turnstile solving, geoip/WebRTC-IP spoofing as defaults** — fraud- or
  ToS-bypass-adjacent. At most an operator-supplied passthrough on the binary, for
  the user's OWN authorized automation, never defaulted, never advertised as a
  bypass.

## Auth stays keyless

For logged-in sites, drive the user's **own** session — a real `--profile`, or
`--restore` durable cookies — never a minted token. Anti-detection is about not
*advertising* automation, not about forging identity or bypassing a site's rules.
