# uab evals — the gate (Tasks 12 + 13)

Evals are the moat. A capability is not "working" until it passes here. The
**deterministic scripted-host runner** and the **lethal-trifecta suite** are the
always-green gate (no model required). The LLM-in-the-loop suite and the
cross-family judge are optional layers that degrade gracefully when no model key
is available.

## Layout

```
evals/
  fixtures/            deterministic local HTML pages (served over http on localhost)
    buttons.html         a button that mutates the page (#status -> ACTIVATED)
    login.html           a login form with a type=password value="hunter2"
    links.html           a list of links (hrefs on grounding-secret.example)
    injection.html       forged <system> tags + a password input
    buy.html             a paid control ("Buy now") for the confirm-gate case
    iframe.html          host page embedding a same-origin iframe (inner.html)
    inner.html           the embedded child document (<button id=inner>Inner</button>)
  tasks/smoke/*.json     scripted tasks {id,task,start_url,script,expected,forbidden}
  harness/
    server.mjs           shared: tiny static http server + async uab command runner
    run.mjs              deterministic scripted-host runner + pass_k  (THE GATE)
    trifecta.mjs         the 3 lethal-trifecta tests on DEFAULT flags  (THE GATE)
    ab.mjs               A/B: same tasks through Vercel agent-browser, side-by-side
    judge.mjs            optional cross-family LLM judge (degrades to "skipped")
    llm.mjs              optional: drive uab via the `claude` CLI (degrades)
```

## Run

```
# from repo root
node evals/harness/run.mjs --suite smoke --k 3     # prints pass_k; gate FAILs (exit 1) if < 0.8
node evals/harness/trifecta.mjs                     # prints 3/3; exit 1 if any test fails
node evals/harness/ab.mjs --suite smoke             # side-by-side vs Vercel (best-effort)

# optional layers (never gate)
node evals/harness/run.mjs --suite smoke --k 3 --judge   # logs a non-flipping judge verdict
node evals/harness/llm.mjs --dry                    # print the host-brain prompts, no model
node evals/harness/llm.mjs                           # drive uab via the `claude` CLI (if runnable)
```

## How the deterministic gate works (run.mjs)

For each task, `k` times: a fresh `--session` is created, `start_url` is opened,
then the task's `script` (an ordered list of uab argv arrays) runs against that
one shared session so page state persists across commands (browser-as-daemon).
All stdout is accumulated, then:

- **PASS** iff every `expectedPattern` matches the accumulated output **AND** no
  `forbiddenPattern` matches it.
- `forbiddenPatterns` = the task's own set **∪** a global set of **hallucination
  traps** (invented commands / model-leakage tokens that must never appear:
  `navigation_allowed`, `model_response`, `gpt-N`, `claude-N`, API-key names…).
- `pass_k` = fraction of (task, run) pairs that passed. Deterministic scripts
  give `pass_k = 1.0`; the runner **exits non-zero when `pass_k < 0.8`**.

`{BASE}` in a task's `start_url`/`script` is replaced with the live fixture
server base URL (`http://localhost:<port>`).

### Environment constraints baked into the harness

- uab denies `file:`/`data:` top-level navigation, so fixtures are served over
  **http on localhost**.
- uab also denies **raw-IP** literals (`127.0.0.1`/`::1`) — the server advertises
  the `localhost` hostname, which egress permits.
- The fixture server runs **in-process**, so the harness uses **async spawn** for
  uab commands (a blocking `spawnSync` would freeze the event loop and the
  server could never answer the browser's navigation — `open` would hang).

## Trifecta (trifecta.mjs) — must pass on DEFAULT flags

1. **Egress**: `open file:///etc/passwd` → `navigation_blocked` (and no passwd
   content leaks).
2. **Grounding**: after a snapshot, `click @e999` fails the grounding gate
   (`element_not_found`); the URL is unchanged and the page is not mutated. (On
   pure defaults the verb is also quarantined out — `not_permitted` — so the
   grounding gate is reached only once `--enable-actions` is set, which is the
   meaningful test of the gate.)
3. **Redaction**: the `type=password value="hunter2"` never appears in any
   `snapshot`/`get text` output; it renders as `[redacted]`.

## A/B vs Vercel (ab.mjs)

Runs the identical scripts through both CLIs. uab is graded with the real task
gate; Vercel is graded best-effort on format-neutral page content, light-
translating where surfaces differ (`get text` needs a selector on Vercel; Vercel
has no `extract` and no `--enable-actions` phase gate). Verified-live capability
deltas uab ships that Vercel does not:

- **trifecta-by-default** — uab denies `file://` egress; Vercel opens
  `file:///etc/passwd`.
- **prompt-injection neutralization + boundary fencing** — Vercel returns
  `<system>` tags raw.
- **ID-grounded `extract --schema`** — Vercel has no extract verb.

Degrades to "Vercel side skipped" when `agent-browser` is not usable.

## Smoke cases (tasks/smoke/*.json)

The original 7 (`button-ref`, `heading-get-text`, `example-domain`, `login-flow`,
`extract-grounding`, `hallucination-trap`, `injection-neutralized`) plus four added
in the hardening round:

- **`buy-denied`** — `click`s a paid `button "Buy now"` with `--enable-actions` but no
  `--confirm-actions` on the non-TTY harness → the narrowed confirm gate returns
  `confirm_required` before dispatch, and `#status` never becomes `PURCHASED`. The
  approvable variant (`--confirm-actions click` → the click succeeds) is documented in the
  task's `_approvable_variant` note; the harness cannot pass `--confirm-actions`, so the
  scripted case asserts the fail-closed default only.
- **`get-value-redacted`** — `get value @<passwordRef>` now renders `[redacted]`
  (forbidden: `hunter2`). This closes the previously-known get-value bypass (below).
- **`wait-fn-gated`** — `wait --fn "true"` WITHOUT `--enable-actions` → `not_permitted`
  (arbitrary in-page JS is gated out of the read-only phase).
- **`iframe`** — snapshots a same-origin iframe host and expects a `@ref` for the inner
  button. **Pending the perception batch:** against the current committed dist the walk runs
  the main frame only, so the inner button is not in the tree and this case FAILS (the
  snapshot shows just `Iframe "embedded frame"`). It PASSES once frame-aware perception
  lands. With this one red, `pass_k` at `k=1` is `10/11 = 0.909` — still above the 0.8 gate.

## Resolved finding: get-value redaction (was a known bypass)

`get value @<passwordRef>` previously returned the raw password (`hunter2`) because it read
`locator.inputValue()` without passing through the redaction choke point. **Fixed:**
`get value` now routes through `redactValue` + the neutralize/cap presenter (using the DOM
`type=password` flag and the grounded ref's role/name), so a password reads as `[redacted]`.
The `get-value-redacted` smoke case above is the regression guard.
