# Use-Cases WIDE — a vertical + cross-cutting workflow map for Silver

Extends `research/deepdive/usage-taxonomy.md` (17 mode-keyed categories) and does
NOT repeat it. That file answered *"which shape/mode do I reach for."* This one
answers the orthogonal question: *"for any real-world job, in any vertical, what
is the concrete Silver play?"* — so a host LLM can map "book me a flight" or
"pull every filing" straight to verbs. Every sequence uses only verbs confirmed
in `security/registry.ts` + `core/handlers.ts` (open, read, snapshot -i, click,
fill, select, check, get {text,value,attr,count}, find, extract/extract resolve,
scroll, wait, download, upload, tab, network {requests,route,har}, set
{viewport,geo,offline,timezone,locale,media,colorscheme}, state, cookies,
storage, frame, dialog, eval, clipboard, screenshot, pdf, is, console, errors,
doctor, task {start,exec,checkpoint,resume}, subagent, memory). Modes are the
five from the prior file (quick lean-loop / batch / long-task / parallel /
subagent). "KEYLESS check" = the sequence never asks Silver to reason; the host
LLM supplies every judgement. "Gap" = a capability Silver lacks today.

---

## PART A — VERTICALS

### A1. E-commerce (shop, cart, checkout, order-track, returns)
- **Goal:** find a product, add to cart, check out; or track/return an order.
- **Sequence:** `open <plp>` → `snapshot -i` → `find text "Add to cart" click`
  → `open <cart>` → `click @eCheckout --confirm-actions click`. Order track:
  `state load auth.json` → `open /orders` → `extract --schema orders.json` →
  `extract resolve`. Return: `snapshot -i` → `select @eReason "Damaged"` →
  `click @eSubmit --confirm-actions click`.
- **Mode:** quick lean-loop; long-task if multi-step checkout can crash mid-flow.
- **KEYLESS check:** host picks the product/ref; the paid-gate (`registry.ts`
  `isDestructivePaidName` on buy|checkout|pay|order) forces a conscious
  `--confirm-actions`. `extract` moat keeps order URLs un-fabricable.
- **Gap:** none structural. Coupon/loyalty math is host-side.

### A2. Travel (flights, hotels, cars, itinerary assembly)
- **Goal:** search a date-range, compare fares across sites, book, save PNR.
- **Sequence:** parallel sessions per OTA: `open kayak --session k &`,
  `open google-flights --session g &`; each: `fill @eFrom "SFO"` → `fill @eTo` →
  date-picker via `snapshot -i` + `click` (compound date widgets need
  step-by-step atomic clicks — the Nova Act finding, sota-2026-a §4) →
  `extract --schema fares.json`. Host compares, then books on the winner with
  `--confirm-actions click`, then `pdf confirmation.pdf`.
- **Mode:** parallel (own-session-per-OTA) for the compare; long-task for booking.
- **KEYLESS check:** host ranks fares from the extract bundle; Silver never scores.
- **Gap:** date/calendar widgets are the classic failure class — no compound-
  component synthesis yet (adopt-list C1). Multi-city legs need the host to loop.

### A3. Finance & banking (statements, transfers, portfolio, filings)
- **Goal:** log in, pull transactions/statements, read balances, download PDFs.
- **Sequence:** `state load bank-auth.json` → `open /activity` →
  `extract --schema txns.json --instruction "each transaction w/ date,amt,payee"`
  → `extract resolve`. Statement: `download @eStmtPdf statement.pdf`. SEC/EDGAR
  research: `read https://www.sec.gov/cgi-bin/browse-edgar?...` → `find text` →
  `download @e10K filing.htm`.
- **Mode:** quick + extract; long-task for a year of statements (pagination).
- **KEYLESS check:** amounts come from the DOM via `get text`/extract, never a
  model guess — this is the fact-grounding vertical par excellence.
- **Gap:** transfers/bill-pay trip the paid-gate correctly, but there is no PII/
  card-shape value-gate yet (sota-2026-a §5) — a routing number typed into the
  wrong field is not caught. 2FA is the hard blocker (see X1).

### A4. Research / knowledge synthesis (compare, cite, verify)
- **Goal:** gather facts across N sources and hand the host clean, cited text.
- **Sequence:** subagent fan-out, one child per source, each does
  `open → snapshot -i → get text`; host synthesizes. `memory add` accumulates
  findings; `find text "<claim>"` verifies a specific assertion against the DOM.
- **Mode:** subagent (each source multi-step) or parallel (each source one read).
- **KEYLESS check:** all page text is untrusted-fenced (`presentPageText`,
  `security/injection.ts`) so the host treats sources as data; Silver cites by
  returning real URLs only through `extract resolve`.
- **Gap:** no built-in citation/dedupe ledger — host owns synthesis. Covered
  broadly by prior §3/§14; here the vertical framing is the addition.

### A5. Social media & community (post, DM, monitor, harvest)
- **Goal:** publish a post, read a feed, DM, or harvest a thread/comments.
- **Sequence:** `state load social.json` → `open /compose` → `fill @eBody --stdin`
  → `click @ePost --confirm-actions click` (post is host-consented). Harvest an
  infinite feed: see X2 (scroll-harvest). Monitor mentions: X5 (price/change
  watch) pattern against a search URL.
- **Mode:** quick for post/DM; long-task + scroll-harvest for bulk thread pull.
- **KEYLESS check:** feed text fenced; host decides what to post.
- **Gap:** aggressive anti-bot walls (login-required feeds, rate limits) — no
  stealth beyond static JS defaults (E6); no residential proxy by design.

### A6. Dev / QA / test automation
- **Goal:** drive a local app, assert state, catch console/network regressions,
  check responsive layout, inject faults.
- **Sequence:** `batch "open localhost:3000" "is visible @e2" "get count .row"
  "console" "errors" --bail --session qa`; responsive: `set viewport 375 812`
  → `screenshot m.png`; fault: `network route "**/api/*" --abort`; a11y snapshot
  IS the DOM assertion surface.
- **Mode:** batch (scripted) or quick (exploratory).
- **KEYLESS check:** `is`/`get count`/`console`/`errors` are pure DOM/CDP reads.
- **Gap:** no assertion DSL / expect-retry — host loops `wait` + `is`. No
  `--verify` post-action flag yet (sota-2026-a §3) to fold assert into the act.

### A7. Data extraction / ETL (scrape to dataset)
- **Goal:** turn listings/tables across many pages into one clean dataset.
- **Sequence:** `task start "scrape catalog"` → loop `task exec -- open $url` +
  `task exec -- extract --schema @s.json` + `task exec -- extract resolve` +
  `task checkpoint`; shard URLs across `--session` names or subagents.
- **Mode:** long-task + parallel shards.
- **KEYLESS check:** ID-grounded extract makes fabricated rows structurally
  impossible (`extract/transform.ts`); host owns disk persistence.
- **Gap:** no verb-sequence/DOM-hash replay cache yet (sota-2026-a §2) — every
  page re-snapshots even on identical templates. Biggest throughput win pending.

### A8. Ops / IT / internal-admin dashboards
- **Goal:** drive an admin console (CI, cloud, CRM, ticketing) — read status,
  toggle flags, run a runbook step.
- **Sequence:** `state load admin.json` → `open /dashboard` → `snapshot -i` →
  `get text @eStatus` → `click @eDeploy --confirm-actions click`. Wrap a runbook
  in long-task so a crash mid-runbook resumes (`task resume`).
- **Mode:** long-task (runbook durability) + quick per step.
- **KEYLESS check:** status read from DOM; destructive toggles gated.
- **Gap:** no scheduler — an external cron/loop drives recurring ops. `doctor`
  gives a self-check but no health-probe verb chain.

### A9. Legal / compliance (contracts, dockets, e-discovery, policy diff)
- **Goal:** pull documents from a portal, extract clauses/metadata, diff a policy
  version-over-version, log an audit trail.
- **Sequence:** `open <docket>` → `extract --schema case.json` →
  `download @ePdf filing.pdf`; policy diff: `open v1` → `get text` →
  `memory add`; `open v2` → the diff-aware `snapshot`/`observe`
  (`perception/diff.ts`) returns a unified diff for change detection.
  `network har start/stop` captures a full audit trace.
- **Mode:** long-task (durable audit trail = the run folder) + extract.
- **KEYLESS check:** clause text is DOM-grounded, never summarized by Silver;
  HAR + action_log.jsonl are the tamper-evident record.
- **Gap:** no text-region diff at sub-page granularity beyond snapshot diff; PDF
  content is downloaded, not parsed (host/OCR does that).

### A10. Healthcare / patient portals (records, appointments, results)
- **Goal:** log into a portal, read results, book/reschedule an appointment.
- **Sequence:** `state load portal.json` → `open /results` →
  `extract --schema labs.json` → `extract resolve`; booking:
  `select @eSlot` → `click @eConfirm --confirm-actions click`.
- **Mode:** quick + extract; long-task if multi-step scheduling.
- **KEYLESS check:** results read from DOM; Silver never interprets a lab value.
- **Gap:** PHI handling is the operator's responsibility — Silver has redaction
  for secrets (`security/redact.ts`) but no PHI-aware value-gate; no consent
  layer. High-sensitivity vertical: keep read-only unless explicitly tasked.

### A11. Real-estate (listings, alerts, applications)
- **Goal:** search MLS/portals by criteria, extract comps, set an alert, apply.
- **Sequence:** parallel sessions per portal → `fill` filters → `extract --schema
  listings.json` (price, beds, url) → host ranks. Alert = X5 watch pattern.
  Application = multi-field wizard (X3).
- **Mode:** parallel compare + long-task application.
- **KEYLESS check:** listing URLs grounded via resolve; host ranks comps.
- **Gap:** map-based/canvas search UIs fall back to `screenshot` handback (host
  vision) — AX tree is thin on map pins.

### A12. Jobs / recruiting (search, apply, ATS, sourcing)
- **Goal:** search postings, tailor+submit applications, or source candidates.
- **Sequence:** `open <board>` → `extract --schema jobs.json` → host filters;
  apply: `open <posting>` → `snapshot -i` → `fill` fields →
  `upload @eResume ./resume.pdf` → `click @eApply --confirm-actions click`.
  Multi-page ATS (Workday/Greenhouse) = wizard (X3) wrapped in long-task.
- **Mode:** long-task (multi-page ATS) + upload pipeline (X4).
- **KEYLESS check:** host writes cover text; Silver types it; apply is gated.
- **Gap:** ATS session timeouts mid-wizard — long-task resume helps but re-auth
  needs X1. No resume-tailoring (host job).

### A13. Government / civic (permits, filings, records, benefits)
- **Goal:** file a form, look up a record, check application status on a .gov.
- **Sequence:** `open <gov-portal>` → wizard (X3) → `upload` supporting docs →
  `click @eSubmit --confirm-actions click` → `pdf receipt.pdf`. Record lookup:
  `read`/`open` → `find text` → `download`.
- **Mode:** long-task (slow, multi-page, must not lose progress) + upload.
- **KEYLESS check:** all field values host-supplied; submit gated + receipt saved.
- **Gap:** legacy .gov sites use framesets/iframes heavily — `frame` verb exists
  but deep nested frames + session-cookie fragility are the risk. CAPTCHA common
  (X6 handback). No accessibility-fallback for image-only PDFs.

---

## PART B — CROSS-CUTTING WORKFLOWS

### X1. Auth + 2FA / MFA flows
- **Goal:** log in past a second factor and reuse the session thereafter.
- **Sequence:** `open /login` → `fill @eUser` → `fill @ePass --stdin` →
  `click @eSubmit` → (2FA screen) `snapshot -i` → host reads OTP from the user /
  authenticator → `fill @eOtp "123456"` → `click @eVerify` →
  `state save auth.json`. Reuse everywhere via `state load` / daemon session.
- **Mode:** quick once; then session-reuse (prior §17) across all runs.
- **KEYLESS check:** password via `--stdin` (never argv), rendered `[redacted]`.
- **Gap (real):** Silver has **no TOTP generator and no email/SMS reader** — the
  OTP must come from the host/user out-of-band. This is the single biggest
  automation blocker across A3/A10/A12/A13. Candidate keyless feature: a
  `totp <secret>` helper (pure RFC-6238, no model) so the host can complete
  MFA without a third-party. Also: `state save` does NOT replay localStorage in
  v1 — token-in-localStorage auth won't persist; only cookie auth does.

### X2. Pagination & infinite-scroll harvest
- **Goal:** collect every item across "Load more" / numbered pages / infinite feed.
- **Sequence — infinite scroll:** loop { `scroll --down` (or `scroll @eSentinel
  scrollintoview`) → `wait --fn "document.querySelectorAll('.item').length > N"`
  → `get count .item` }; stop when count stops growing; then one `extract`.
  **Numbered:** loop `click @eNext` → `snapshot -i` → `extract` per page.
- **Mode:** long-task (durable, many iterations) + memory for the running count.
- **KEYLESS check:** host decides the stop condition; `wait --fn` is a DOM
  predicate, not a model call; `get count` is a pure query.
- **Gap:** no built-in "auto-scroll until stable" verb — host writes the loop.
  Virtualized lists (windowed DOM) drop off-screen nodes: must extract per
  scroll-tick, not once at the end. No scroll-harvest helper yet.

### X3. Multi-step wizards (checkout, onboarding, ATS, gov forms)
- **Goal:** complete an N-page form where each step gates the next.
- **Sequence:** wrap in `task start`; per step: `snapshot -i` → `fill`/`select`/
  `check` each field → `click @eNext` → `wait --fn "<next-step marker>"` →
  `task checkpoint --note "step k done"`. On crash: `task resume`.
- **Mode:** long-task (the durability primitive is the whole point).
- **KEYLESS check:** re-snapshot after each `page_changed:true`; refs are
  generation-scoped so a stale ref fails loud (`perception/refmap.ts`).
- **Gap:** no `--verify` flag to confirm a field stuck before advancing
  (sota-2026-a §3) — host must `get value` to check. Session Recovery on an
  unexpected mid-wizard redirect is mostly-covered but unverified (sota §7).

### X4. File up/download pipelines
- **Goal:** pull generated exports (CSV/PDF) or push files into inputs, at volume.
- **Sequence — download:** `download @eExport data.csv --enable-actions` (arms
  listener BEFORE click) or `download --wait file.pdf` (await next download w/o
  click). **Upload:** `upload @eInput ./doc.pdf` (path must resolve in cwd or
  refuses `path_denied`). Batch: loop inside long-task, `task checkpoint` per file.
- **Mode:** quick per file; long-task for a batch pipeline.
- **KEYLESS check:** contained paths (`assertContainedPath`); server filename
  neutralized; both are actor verbs behind `--enable-actions`.
- **Gap:** no multi-file/zip-expand handling; no download-progress polling for
  huge files; upload sets input but can't drive OS-native file dialogs (Playwright
  filechooser only).

### X5. Price / availability / change monitoring
- **Goal:** re-check a page on a schedule; alert when a value crosses a threshold.
- **Sequence per tick:** `open <url> --session watch` → the diff-aware `snapshot`
  returns "No changes detected" or a unified diff (near-free change detection) →
  or `get text @ePrice`; `memory search "baseline <url>"` → host compares →
  `memory add "<url> now $38"`.
- **Mode:** quick per tick, external scheduler; session-reuse keeps auth.
- **KEYLESS check:** host owns the threshold logic; diff/get are pure reads.
- **Gap (real):** **no built-in scheduler by design** — needs OS cron / the
  `loop`/`schedule` host harness. No alert transport (email/webhook) — host sends.

### X6. CAPTCHA / challenge handback
- **Goal:** get past a CAPTCHA/interstitial without Silver solving it.
- **Sequence:** on detecting a challenge, `screenshot challenge.png` (or base64
  to `data.image`) → hand to host/human → host returns the solution →
  `fill @eCaptcha "<answer>"` → `click @eVerify`. For slider/behavioral: host
  drives via `mouse move`/`drag` from the screenshot.
- **Mode:** quick, vision-handback (screenshot is the bridge).
- **KEYLESS check:** Silver captures pixels; the host's vision model reads them —
  Silver never OCRs or solves. Correct keyless divergence (sota-2026-a §8).
- **Gap:** no CAPTCHA-solver integration by design (paid infra, excluded). No
  auto-detect-and-pause-for-human signal — host must notice the challenge.

### X7. Form automation (bulk, templated, data-driven)
- **Goal:** fill the same form N times from a data file (lead entry, bulk apply).
- **Sequence:** loop over rows: `find role textbox --name "Email" fill "$e"`
  (locate+fill in one call, no snapshot) → ... → `click @eSubmit
  --confirm-actions click`; run under `batch` for setup or long-task for volume.
- **Mode:** batch (per-command pass/fail) or long-task (durable at volume).
- **KEYLESS check:** `find … fill` binds by role+accessible-name, not a guessed
  selector; every row's data is host-supplied.
- **Gap:** no CSV/data driver — host iterates. `--verify` would confirm each row
  submitted (sota §3, pending).

### X8. Competitive intelligence
- **Goal:** systematically pull public competitor catalog/pricing/feature data.
- **Sequence:** `--allowed-domains competitor.com` pins egress (suffix allowlist,
  `security/egress.ts`) → `task start` → subagent shards per category →
  `extract` per page → `network har start/stop` for an audit trace.
- **Mode:** long-task + subagent shards + egress hardening.
- **KEYLESS check:** extract grounds every URL; egress allowlist stops a runaway
  scrape wandering off-domain. (ToS/consent is the operator's call.)
- **Gap:** no rate-limiter/politeness-delay verb — host must pace; no robots.txt
  awareness.

### X9. Document extraction (structured pull from doc-heavy pages)
- **Goal:** turn a rendered doc/report page into typed records (tables, clauses,
  line-items).
- **Sequence:** `open <doc>` → `extract --schema doc.json --instruction "each
  line item w/ qty, price"` → `extract resolve`; object schemas auto-wrap to
  `list[T]` (`ensureContainer`) so N rows don't collapse to 1.
- **Mode:** quick + extract handshake.
- **KEYLESS check:** host runs inference over the ID-bundle; resolve maps IDs to
  real values — no fabricated fields.
- **Gap:** binary PDFs/scans need download + host OCR — Silver extracts from
  rendered DOM only, not embedded-PDF text.

### X10. A/B test / variant & experiment validation
- **Goal:** verify which variant renders, or force a variant, and assert layout.
- **Sequence:** `cookies set --curl "ab_bucket=B"` (or `storage set` for
  localStorage flags, actor-gated) → `reload` → `snapshot -i` →
  `is visible @eVariantB` → `screenshot b.png`; compare across
  `set viewport`/`set colorscheme dark` states.
- **Mode:** batch (deterministic variant sweep).
- **KEYLESS check:** cookie/storage writes are explicit host actions; `is`/
  `screenshot` are the assertions.
- **Gap:** no visual-diff/pixel-compare verb — host diffs screenshots. `storage
  set` writes localStorage but `state save` won't persist it (X1 caveat).

### X11. Iframe / embedded-widget & cross-frame flows
- **Goal:** interact with content inside an iframe (payment widget, embedded map,
  SSO popup, chat widget).
- **Sequence:** `frame list` → `frame <name/url>` to scope → `snapshot -i`
  within frame → `fill`/`click`; return with `frame --main`. SSO popup: `tab
  list` → `tab <popup>` → drive → `tab <main>`.
- **Mode:** quick lean-loop; long-task if the SSO bounce is part of a wizard.
- **KEYLESS check:** frame scoping is explicit; refs re-derive per frame.
- **Gap:** deeply nested / cross-origin frames can restrict AX access; no
  auto-frame-discovery for a target element (host must know the frame).

### X12. Dialog / native-popup handling
- **Goal:** handle `alert`/`confirm`/`prompt`/`beforeunload` native dialogs.
- **Sequence:** pre-arm `dialog accept "text"` or `dialog dismiss` before the
  triggering `click`; the handler catches the dialog so the page doesn't hang.
- **Mode:** quick; part of any actor flow that pops a native dialog.
- **KEYLESS check:** host decides accept/dismiss + prompt text.
- **Gap:** none notable; must be armed before the trigger (event-timing).

### X13. Clipboard-mediated & keyboard-heavy apps
- **Goal:** copy/paste flows, keyboard shortcuts, canvas/editor apps.
- **Sequence:** `clipboard write "text"` (actor) → focus target → `keyboard press
  "Meta+V"`; shortcut-driven UI: `keyboard press "g i"` sequences; `mouse
  move/click` + `drag` for canvas.
- **Mode:** quick lean-loop.
- **KEYLESS check:** all keys/coords host-chosen; clipboard write is actor-gated.
- **Gap:** canvas apps have no AX surface → screenshot handback for perception.

---

## Cross-cutting capability gaps (ranked, keyless-fixable first)
1. **TOTP helper (X1)** — a pure RFC-6238 `totp <secret>` verb unblocks MFA
   across finance/health/jobs/gov. Highest leverage, fully keyless.
2. **Scroll-harvest helper (X2)** — a `scroll --until-stable` / auto-paginate
   primitive; today every host re-writes the loop.
3. **`--verify` post-action flag (X3/X6/X7)** — sota-2026-a §3; folds assertion
   into the act, closes a Webwright gap with code not prose.
4. **Verb-sequence/DOM-hash replay cache (A7/X8)** — sota-2026-a §2; the biggest
   ETL throughput win, still unbuilt.
5. **PII/card-shape value-gate (A3/A10)** — sota-2026-a §5; confirm-gate on
   Luhn/SSN-shaped values typed into forms.
6. **localStorage in `state save` (X1/X10)** — token-in-localStorage auth and AB
   flags don't persist; a known v1 limitation, not a design choice.
7. **Alert/transport + scheduler (X5/A8)** — deliberately external; document the
   cron/`loop`/`schedule` handoff clearly so hosts don't expect it built-in.

**Verticals cleanly covered today, no gap:** e-commerce (A1), dev/QA (A6),
research (A4), competitive intel (X8). **Verticals blocked mainly by X1 (2FA):**
finance, healthcare, jobs, gov. **Verticals needing vision-handback (X6):**
real-estate maps, canvas apps, CAPTCHA-walled social.
