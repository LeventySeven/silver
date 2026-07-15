# Aside actuation vs moxxie — gap alignment (round 3)

Lens: dropdowns two-step, dialog auto-accept, iframe click, settle constants (asidewright
actuation, `_aside_parts/101_asidewright_actuation.md` + `90_asidewright.md`) vs moxxie's
Playwright-delegated actuation (`skill/agent-browser/src/actuation/{actions,resolve,wait,
pagechange}.ts`).

Moxxie's design choice (stated explicitly in `actuation/actions.ts` header comment, lines 6-8)
is: "Playwright owns ALL actionability ... we hand-roll NO gates and NO timing constants." Aside
cannot make that choice — it drives raw CDP `Input.*` itself, so it had to hand-build
`waitForReady`/`checkHitTarget`/`resolvePointerTarget`/the `[0,100,200]` retry loop/the settle
constant block. Most of section §3/§4 of the source is therefore **correctly inapplicable** —
moxxie gets it for free from `page.locator(...).click()`. The real gaps are the handful of
places where Aside's in-page primitives encode *domain knowledge about broken DOM shapes*
(custom checkboxes, combobox icon-overlay clicks, obscured links, dialogs, iframes) that
Playwright's generic actionability does NOT know about, because Playwright can't see the site's
specific markup patterns the way a hand-tuned heuristic can.

## Findings

### 1. [P0, adopt] No cross-frame (iframe) support in perception or actuation
- **Source:** §2.2/§4.1 — every ref carries a frame prefix (`f1e12`), `#i(ref)` resolves the
  frame via `resolveFrameIdForSnapshotPrefix`, deref runs inside that frame's own injected
  `__aside` world, and `AVt`/`jVt` translate the frame-local click point to root-viewport
  coordinates before dispatching `Input.dispatchMouseEvent` on the root session.
- **Moxxie today:** `perception/walk.ts:245` hardcodes `frameId: 'main'` on every `SnapNode` —
  the AX walk only ever covers the top document (`Accessibility.getFullAXTree` on the page's own
  CDP session). `actuation/resolve.ts`'s `toLocator` calls `page.locator(refSelector(ref))`,
  which only searches the main frame's DOM; Playwright's `page.locator()` does not pierce
  iframes (you need `frame.locator()`/`frameLocator()` explicitly). So today moxxie simply
  cannot snapshot or act on anything inside an `<iframe>`.
- **Change:** In `walk.ts`, iterate `page.frames()` (or `page.mainFrame().childFrames()`
  recursively), run the same AX-walk CDP calls against each frame's own CDP session
  (`page.context().newCDPSession` won't attach to a frame directly — use
  `frame.page().context().newCDPSession(page)` plus `Runtime.callFunctionOn` scoped to the
  frame's execution context, or simpler: use Playwright's own `frame.locator('*')`/DOM APIs per
  frame), and tag `frameId` with a stable index (`f1`, `f2`, ...) instead of the literal string
  `'main'`. In `resolve.ts`, thread the frame identity through `RefEntry` so `toLocator` builds
  the stamped-attribute locator against `page.frame(frameId).locator(...)` (or
  `page.frameLocator(...)`) instead of always `page.locator(...)`. This is wiring work, not CDP
  math — Playwright already has frame-aware locators, moxxie just isn't using them.
- **keyless_ok:** true — zero model calls, pure Playwright/CDP plumbing.
- **Evidence:** source `101_asidewright_actuation.md` §2.2 (`#i(ref)` frame routing), §4.1
  (`AVt`/`jVt` iframe coordinate translation); moxxie `perception/walk.ts:49,86,245`,
  `actuation/resolve.ts:28-141`.

### 2. [P0, adopt] Dialog auto-accept + report is unimplemented
- **Source:** §90 §6 — `AsideBrowser` subscribes to `Page.javascriptDialogOpening` and
  **auto-accepts** every `alert`/`confirm`/`prompt` (OK / default value), then pushes a one-line
  `[system]` message reporting exactly what happened (`"...showed a confirm dialog: \"Delete
  item?\". options: [OK] [Cancel]. auto-accepted (OK)."`) into the next tool result so the model
  can react on its next turn instead of the dialog silently blocking/discarding the action.
- **Moxxie today:** `core/handlers.ts` case `'dialog'` returns `notImplemented()` — there is no
  `page.on('dialog', ...)` listener registered anywhere. `dialog` is already reserved as a
  command name in both `security/registry.ts:76` and `security/confirm.ts:43` (i.e. it was
  planned), but never wired up. Playwright's own default (no listener registered) is to
  **auto-dismiss** dialogs (Cancel / null prompt value) — the opposite of what most agent flows
  want (a confirm-before-delete gets silently cancelled with zero signal back to the host that
  anything happened).
- **Change:** At page/session attach time, register `page.on('dialog', async d => { const note =
  \`dialog: ${d.type()} "${d.message()}" auto-accepted\`; await d.accept(d.type() === 'prompt' ?
  d.defaultValue() : undefined); pushNote(note) })`, where `pushNote` appends to a small
  per-session ring buffer that the next envelope's `notes`/`warnings` field surfaces to the host
  — mirroring Aside's `[system]` steer line without any model call.
- **keyless_ok:** true.
- **Evidence:** source `90_asidewright.md` §6 (`#P`, `#S` dialog handlers, verbatim message
  templates); moxxie `core/handlers.ts:222-224`, `security/registry.ts:76`,
  `security/confirm.ts:43`.

### 3. [P1, adopt] No retarget-to-visible-label fallback for custom checkbox/radio patterns
- **Source:** §3.3/§3.4 — `retarget(el,'follow-label')` and, more specifically,
  `resolvePointerTarget(element)` explicitly handle the extremely common case where a native
  `<input type=checkbox>` is visually 0-size/hidden and the actual clickable surface is its
  `<label>` (or a Material-style `mat-checkbox` wrapper): it walks `el.labels`, picks the first
  *visible* one, and clicks that instead of the invisible input.
- **Moxxie today:** `actuation/resolve.ts`'s `toLocator` stamps and locates exactly the
  `backendNodeId` recorded at snapshot time (the `<input>` itself, since `walk.ts` marks
  interactive roles ref-eligible directly). There is no fallback path — if that node fails
  Playwright's visibility check (a very common styled-checkbox pattern: `input` positioned
  off-screen/opacity:0 behind a styled `<label>`), the action just throws (mapped to
  `element_obscured`/`timeout`) with no retry.
- **Change:** In `actuation/actions.ts`'s `click`/`check`/`uncheck` dispatch, on a Playwright
  actionability failure (`element_obscured` or `timeout`) where the grounded ref's recorded role
  is `checkbox`/`radio`, retry once against
  `locator.locator('xpath=self::node()[@id]/ancestor-or-self::*/preceding-sibling::label[@for=current()/@id] | ./ancestor::label[1]')`
  — simpler: since Playwright already lets you build `page.locator('label').filter({ has:
  originalLocator })`, or just resolve `label[for="<id>"]` from the stamped id — click the label
  instead. Bounded to one retry, no new timing constants.
- **keyless_ok:** true.
- **Evidence:** source `101_asidewright_actuation.md` §3.4 (verbatim `resolvePointerTarget`);
  moxxie `actuation/resolve.ts:117-141`, `actuation/actions.ts:257-274`.

### 4. [P1, adopt-partial] No combobox-expand verification after a trigger click
- **Source:** §4.2 — after clicking a collapsed combobox trigger, Aside's `DQ` waits 80ms,
  re-probes `aria-expanded`, and if it's still `"false"` (a child icon/span absorbed the pointer
  event without opening the popup), force-opens via DOM activation (`el.click()`) instead of
  coordinate dispatch.
- **Moxxie today:** `click` in `actuation/actions.ts` is a single `locator.click(...)` call with
  no post-condition check; there is no notion of "did the combobox actually open."
- **Change:** This is a genuinely narrow, high-value heuristic worth a small opt-in addition —
  NOT a full retarget/actionability subsystem. In `applyVerb`'s `click` case, if the grounded
  ref's recorded role is `combobox` (or the element has `aria-haspopup`), after the Playwright
  click re-read `aria-expanded` via `locator.getAttribute('aria-expanded')` once; if it's still
  `"false"`, retry with `locator.evaluate(el => el.click())` (DOM activation) once before
  returning success. No new backoff/constant table — one bounded retry.
- **keyless_ok:** true.
- **Evidence:** source `101_asidewright_actuation.md` §4.2 (`c.hasComboboxTarget && c.expanded
  === 'false' && await Ns(80)` block); moxxie `actuation/actions.ts:249-298`.

### 5. [P2, adopt] No DOM-activation fallback for obscured `<a href>` links
- **Source:** §4.2 `bQ`/`prefersDomActivation` — for real `<a href>` links (and native
  checkbox/radio), Aside prefers JS `.click()` (DOM activation) + post-state verification over
  coordinate dispatch specifically because a child icon/span at the click point can absorb the
  event without triggering navigation; on an "obscured" failure it falls back to `xQ` (DOM
  activation) rather than just erroring.
- **Moxxie today:** an obscured click just fails with `element_obscured`, telling the host to
  re-snapshot/scroll/pass `--force` (`core/errors.ts:22-25`) — correct as a *last-resort*
  message, but it costs the host an extra turn for a class of failure that's cheaply
  self-healing.
- **Change:** In `mapActionError`'s obscured path (`actuation/actions.ts:341`), before returning
  the failure envelope, if the grounded ref's role is `link`, retry once via
  `locator.evaluate(el => el.click())` and only fall through to the `element_obscured` envelope
  if that also throws. Bounded, keyless, uses Playwright's own `.evaluate` — no coordinate math.
- **keyless_ok:** true.
- **Evidence:** source `101_asidewright_actuation.md` §4.2 (`prefersDomActivation` comment: "a
  child element (icon span, image) at the click point absorbs the event without triggering
  default navigation"); moxxie `actuation/actions.ts:336-344`, `core/errors.ts:22-25`.

### 6. [P2, align] Settle-fingerprint budget is conservative relative to Aside's tuned window
- **Source:** §101 constants block — Aside's networkidle quiet window for its own settle
  (`sUt`) is `500 ms`; its post-click settle (`cVt`) is a whole layered constant set
  (`uQ=2000,...`) but the *quiet* window specifically is 500ms, empirically tuned.
- **Moxxie today:** `actuation/pagechange.ts`'s `NETWORK_IDLE_BUDGET_MS = 1_200` — a single
  bounded race against `waitForLoadState('networkidle')`, used only for the post-action
  change-fingerprint (not for gating action completion, since Playwright already gates that).
  This is architecturally the right split (moxxie doesn't need to gate click completion — that's
  Playwright's job); the 1200ms figure is just a wider budget than Aside's tuned 500ms.
- **Change:** No structural change needed. Optionally tune `NETWORK_IDLE_BUDGET_MS` down toward
  ~500-800ms if latency profiling shows the fingerprint step is a meaningful tail-latency
  contributor; low priority, evidence-gated.
- **keyless_ok:** true.
- **Evidence:** source `101_asidewright_actuation.md` §1 constants table (`sUt = 500`); moxxie
  `actuation/pagechange.ts:37`.

### 7. [P2, skip-cargo-cult] The `[0,100,200]` daemon-side actionability retry loop (`SQ`)
- **Source:** §3.6 — Aside's `SQ` wraps `waitForReady`+`checkHitTarget` in a 3-attempt loop with
  a `0/100/200ms` presleep backoff, because Aside is the one deciding when to retry a raw CDP
  dispatch.
- **Moxxie current:** `actuation/actions.ts` header (lines 6-8) explicitly and correctly opts
  out of this: "Playwright owns ALL actionability... we hand-roll NO gates and NO timing
  constants." Playwright's own `.click()` already performs an equivalent (better-tested) internal
  actionability-retry loop up to its own timeout.
- **Recommendation:** skip — re-implementing a second retry/backoff layer on top of Playwright's
  own would just double the retry surface for no behavioral gain and reintroduce exactly the
  hand-rolled-timing-constant bloat moxxie deliberately avoided. Recording this explicitly so a
  future round doesn't cargo-cult it back in under the "but Aside does 3 retries" banner.
- **keyless_ok:** n/a (recommendation is to not build it).
- **Evidence:** source §3.6 (`SQ`, `jQ=[0,100,200]`); moxxie `actuation/actions.ts:1-21` (module
  doc stating the delegation policy).

### 8. [P2, skip-cargo-cult] In-page `waitForReady`/`checkHitTarget`/`deref`-by-TreeWalker primitives
- **Source:** §3.1-§3.2, §2.3 — Aside re-implements visibility/stability polling
  (16ms/32ms constants), composed-shadow-DOM occlusion testing (`elementFromPoint` walk), and a
  5000-node TreeWalker re-match keyed on `(role, accessible-name, ordinal)` — all because Aside
  drives raw `Input.*`/`DOM.*` CDP itself and has no higher-level actionability layer to lean on.
- **Moxxie current:** `resolve.ts`'s slow path already does the equivalent ref-recovery idea
  (`rematchByShape`, bounded to `REMATCH_LIMIT = 5000`, keyed on `(role, name, nth)` — directly
  analogous to Aside's `(role, name, nthAmongSameSignature)`), which is good and should stay.
  But visibility/stability/occlusion checking itself is correctly left to Playwright's Locator,
  not reimplemented.
- **Recommendation:** skip building a parallel `waitForReady`/`checkHitTarget` — the one place
  moxxie *should* keep mirroring Aside (the bounded TreeWalker re-match by role+name+ordinal) it
  already does, in `resolve.ts`'s `rematchByShape`. No further action; flagging so this doesn't
  get cargo-culted as "we need our own hit-test primitive too."
- **keyless_ok:** n/a.
- **Evidence:** source §3.1 (`waitForReady`), §3.2 (`checkHitTarget`), §2.3 (`deref`); moxxie
  `actuation/resolve.ts:78-95` (`rematchByShape`, already analogous and sufficient).

## Top recommendation

Ship finding #2 (dialog auto-accept + report) first — it is a fully unimplemented, already-named
command (`dialog` exists in the security registry but is `notImplemented()`), it is a total
functional gap (Playwright's default silently *cancels* dialogs with zero signal), and it is the
cheapest of the P0s to build: one `page.on('dialog', ...)` listener plus a one-line note appended
to the next envelope. Finding #1 (iframe support) is higher-value long-term but is a larger
plumbing change across `walk.ts` + `refmap.ts` + `resolve.ts`.
