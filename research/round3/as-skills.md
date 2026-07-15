# ASIDE Skills Engine + Vision Loop → moxxie alignment

Lens: URL-glob site playbooks / progressive disclosure (`99_skills_engine.md`) and
cheap-by-default vision (`98_vision_loop.md`), read against moxxie's actual
`src/core/handlers.ts` (936 lines, read in full).

moxxie is 100% keyless — the host LLM is the brain. Every finding below is
re-expressed as a keyless heuristic/data-file/bundle. Anything that requires
moxxie itself to call a model is tagged `skip` and `keyless_ok:false`.

## What moxxie does today (baseline, from handlers.ts)

- `handleSkill` (line 858) returns a single hardcoded string (`short`/`--full`)
  describing the whole CLI. No per-site content, no matching, no progressive
  disclosure — one blob, always the same regardless of the current page.
- `handleScreenshot` (line 372) is `page.screenshot({fullPage}) → base64`,
  full stop. No resize, no byte cap, no format negotiation, no annotation, no
  coordinate-mapping note. `grep -rn "resize|photon|sharp|jimp" src` = zero
  hits — confirmed no image pipeline exists at all.
- moxxie already has a ref-grounding system that ASIDE's overlay reinvents:
  `refmap`/`groundRef`/`@eN` (imported at top of handlers.ts from
  `../perception/refmap.js`), used by `handleAct`/`handleGet`/`handleIs`/`wait`.
  This is the *same* stable-id concept ASIDE's `annotatedScreenshot` overlays
  onto pixels — moxxie has the id system already, just no visual bridge to it.
- No URL-glob matching anywhere in the codebase (`assertNavigable` in
  `security/egress.ts` does host/scheme denylist matching, not skill routing —
  different subsystem, same "match URL against patterns" primitive available
  to reuse).

## Findings

### 1. Site-glob playbooks as data files, not model calls (P0, adopt)
- **source_does**: ASIDE ships 16 `site-specific/*` `SKILL.md` files gated by
  `autoInject.url` host+path globs, scored by a pure specificity function
  `hat` (`100·hostChars + 10·pathChars − wildcards`, `99_skills_engine.md`
  §1.2). Zero model calls in the matcher — pure string/glob math.
- **moxxie_current**: `handleSkill` (handlers.ts:858) is one static string.
  `moxxie skill` gives no page-aware content at all.
- **recommendation**: adopt. Add `skill/agent-browser/site-playbooks/*.md`
  (flat markdown cheat-sheets: canonical URLs, selectors, quirks — like
  ASIDE's `amazon`/`github`/`jira` sheets) plus a pure-JS matcher
  (`hostGlob + pathGlob`, minimatch-style, no deps needed beyond a tiny glob
  regexer) that scores playbooks against the *current session URL* (already
  known via `page.url()` in every handler). Wire it into `handleSkill` as
  `moxxie skill site` (uses the live session's URL) and into `handleOpen`'s
  envelope as an optional `playbook_hint: "<name>"` field so the host knows
  one exists without moxxie forcing it into context.
- **keyless_ok**: true — string matching only.
- **evidence**: `99_skills_engine.md` §1.2 (`hat`), §4 (table of 16 globs);
  moxxie `handleSkill` handlers.ts:858-879, `handleOpen` handlers.ts:234-265.

### 2. Progressive disclosure: keep the always-on surface tiny, push detail to files (P0, adopt)
- **source_does**: `<skills_instructions>` block lists only name+description+
  path; the model must `read_file` the body itself (`99_skills_engine.md`
  §1.6). Site-specific skills are excluded even from that list — they only
  surface when the URL matches.
- **moxxie_current**: `handleSkill --full` (handlers.ts:867-878) inlines
  *everything* (security posture, full workflow) into one string returned
  from a CLI call — there's no notion of "here's a name/description, go read
  the file yourself" for anything beyond the single monolithic skill.
- **recommendation**: adopt the shape, not the machinery. Split
  `handleSkill`'s `--full` output into: (a) the existing short blob always
  returned, (b) a `moxxie skill list` verb enumerating site-playbook
  filenames + one-line descriptions (parsed from a `---\ndescription: ...\n---`
  frontmatter line in each `.md`), (c) `moxxie skill show <name>` that cats
  one playbook file. This is the same value ASIDE gets (host self-serves
  detail, base prompt stays cheap) without any daemon/VM/bundle machinery.
- **keyless_ok**: true.
- **evidence**: `99_skills_engine.md` §1.6 verbatim builder; moxxie
  `handleSkill` handlers.ts:858-879.

### 3. Cap screenshot bytes before they hit the host's context (P0, adopt)
- **source_does**: every screenshot is run through `L3`, a resize pipeline
  that downscales to ≤2000×2000 / ≤4.5MB, tries PNG vs JPEG and keeps the
  smaller, walks a quality/scale ladder if still over budget
  (`98_vision_loop.md` §4.2). This is a pure image-processing function — no
  model involved.
- **moxxie_current**: `handleScreenshot` (handlers.ts:372-381) returns raw
  `page.screenshot()` bytes as base64 with zero size control. A `fullPage`
  screenshot of a long page can be several MB of base64 dumped straight into
  the envelope the host has to read — this is a real context-budget risk
  moxxie currently has no guard against, unlike its own `capOutput`/
  `maxOutput` discipline for text (`presentPageText`, handlers.ts:148-151).
- **recommendation**: add a keyless resize step (e.g. `sharp`, which is a
  thin native binding, not a model — or reuse Playwright's own `quality`/
  `type` options as a cheaper first cut: default `type:'jpeg', quality:80`
  and clamp `fullPage` capture dimensions) in `handleScreenshot` before
  base64-encoding. Emit a `resized: {originalW,H, w,h}` field in the envelope
  analogous to ASIDE's `[Image: original WxH...]` note — useful metadata for
  the host even without a coordinate-click primitive.
- **keyless_ok**: true (image resize is not a model call).
- **evidence**: `98_vision_loop.md` §4.2 (`L3`/`a0t` verbatim); moxxie
  `handleScreenshot` handlers.ts:372-381; `presentPageText`
  handlers.ts:148-151 for the text-side precedent moxxie already applies.

### 4. Annotated screenshot bridging pixels to moxxie's existing @eN refs (P1, adopt)
- **source_does**: `annotatedScreenshot` (`98_vision_loop.md` §2) takes an
  interactive snapshot, then in-page injects a DOM overlay (red boxes +
  labels) using the *same ref ids* as the text tree, screenshots, tears the
  overlay down. This gives the model a picture whose labels are directly
  cross-referencable with the text snapshot it already read.
- **moxxie_current**: moxxie already computes exactly the ref ids ASIDE's
  overlay borrows (`refmap`/`@eN`, `perception/refmap.ts`, used throughout
  handlers.ts e.g. `groundRef` at handlers.ts:541). But `handleScreenshot`
  has no annotate mode — screenshots are pixels-only, disconnected from the
  ref system.
- **recommendation**: add `moxxie screenshot --annotate`: reuse
  `snapshotNodes`/`render` (already imported, handlers.ts:41-42) to get the
  current refmap, then `page.evaluate()` a small in-page script (same
  `getBoundingClientRect()` + absolutely-positioned `<div>` trick, no CDP
  overlay class needed — Playwright's `page.evaluate` suffices) to draw boxes
  labeled with the existing `eN` numbers, screenshot, remove. This is
  strictly DOM + CDP, zero model calls, and it's high-leverage precisely
  *because* moxxie's ref system already exists — this is less new machinery
  for moxxie than it was for ASIDE.
- **keyless_ok**: true.
- **evidence**: `98_vision_loop.md` §2.1–2.2 (`annotatedScreenshot`/`LHt`
  verbatim); moxxie `perception/refmap` import handlers.ts:40, `groundRef`
  handlers.ts:541, `handleScreenshot` handlers.ts:372-381 (no annotate path).

### 5. Document (not build) the reading-escalation ladder in the skill text (P1, adopt)
- **source_does**: ASIDE's system prompt hard-codes an escalation order —
  interactive snapshot → full snapshot → wait+resnapshot → annotated
  screenshot → raw screenshot — framing screenshots as "visual confirmation,"
  never primary reading (`98_vision_loop.md` §1). Empirically this holds:
  89.3% of 300 real tasks never touched vision at all (§8).
  screenshot APIs return *inert* bytes requiring an explicit `display()` call
  — friction is deliberate.
- **moxxie_current**: `handleSkill`'s short blob (handlers.ts:860-866) does
  document the `open → snapshot -i → act → snapshot` loop, but never mentions
  screenshot at all or where it fits, and there's no "screenshot is a last
  resort" guidance for the host to inherit.
  moxxie's design already matches the friction property — `handleScreenshot`
  requires the host to explicitly issue a separate `moxxie screenshot`
  command, nothing auto-fires vision — so this finding is purely about
  *documenting* the existing good default, not code.
- **recommendation**: append one line to the short skill blob (and the full
  one) explicitly stating the escalation order and that screenshot is a
  fallback for canvas/visual-only tasks, matching ASIDE's empirically-
  validated split. Zero code change beyond the string in
  `handleSkill`.
- **keyless_ok**: true.
- **evidence**: `98_vision_loop.md` §1 + §8 (10.7%/89.3% empirical split);
  moxxie `handleSkill` handlers.ts:858-879.

### 6. URL/path glob specificity scorer as a reusable primitive (P2, adopt)
- **source_does**: `hat`'s scoring formula (`100·host + 10·path − wildcards`)
  is a small, self-contained, well-tested idea for "which of N competing
  glob patterns best matches this URL" — used for both skill routing and
  (implicitly) could disambiguate overlapping site playbooks (e.g.
  `docs.google.com/document/**` vs `docs.google.com/forms/**`).
- **moxxie_current**: `security/egress.ts`'s `assertNavigable` (imported
  handlers.ts:44) does allow/deny host-suffix matching for a different
  purpose (egress control), but there's no shared "score competing glob
  patterns" utility moxxie could reuse for playbook routing (finding #1).
- **recommendation**: implement `hat`'s scoring function once as a small
  utility (e.g. `perception/urlmatch.ts`) and use it both for finding #1's
  playbook selection and, if ever needed, to allow multiple candidate
  playbooks per host without ambiguity. Low cost, reusable.
- **keyless_ok**: true.
- **evidence**: `99_skills_engine.md` §1.2 verbatim `hat`; moxxie
  `security/egress.ts` import handlers.ts:44 (comparable but distinct
  host-matching code, not glob-scored).

### 7. Captcha OCR via a "visual model category" — HARD SKIP (P0, skip-cargo-cult)
- **source_does**: `captcha.readText()` makes a *separate* one-shot
  completion call against a dedicated `visual` model category
  (`98_vision_loop.md` §6) to OCR distorted captcha text.
- **moxxie_current**: absent, and must stay absent — moxxie is 100% keyless,
  this would require moxxie itself to hold and call a model/API key.
- **recommendation**: skip as a moxxie feature. If captcha handling is ever
  wanted, the correct keyless shape is: `handleScreenshot` returns the
  cropped captcha region bytes to the host, and the *host* (which already has
  a model) does the OCR/solve — moxxie stays a dumb pixel-out/click-in
  channel, exactly how `cua` in ASIDE is "dumb pixels-in/mouse-out" even
  though captcha OCR specifically is not (`98_vision_loop.md` §6, "no model
  call inside `cua` itself").
- **keyless_ok**: false as designed in source; **true** if re-expressed as
  "moxxie hands the host a cropped image, host's own model reads it" — that
  reframing needs no moxxie code at all beyond an optional `--clip` on
  screenshot, which moxxie doesn't have yet either (see #8).
- **evidence**: `98_vision_loop.md` §6, §7 (`resolveByCategory('visual')`,
  throws if unset); HARD RULE (task prompt).

### 8. Screenshot `clip` option — small adjacent gap worth taking (P2, adopt)
- **source_does**: `page.screenshot({clip:{x,y,width,height}})` lets the
  agent crop to just the region of interest (a chart, a captcha box) instead
  of the whole viewport (`98_vision_loop.md` §3), which is both cheaper and
  more precise than full-page captures.
- **moxxie_current**: `handleScreenshot` (handlers.ts:372-381) only exposes
  `fullPage`/`path` — no `clip`, even though Playwright's `page.screenshot`
  (already the underlying call) supports it directly.
- **recommendation**: add a `--clip x,y,w,h` (or `--ref @eN` to clip to a
  grounded element's bounding box, reusing `toLocator`/CDP box lookups
  already present in `actuation/resolve.js`) flag to the `screenshot` verb.
  Trivial plumbing — the Playwright API already accepts it.
- **keyless_ok**: true.
- **evidence**: `98_vision_loop.md` §3 (`clip` in `page.screenshot`); moxxie
  `handleScreenshot` handlers.ts:372-381 (no clip param passed through).

### 9. Bootstrap-manifest / content-addressed sync of a 414-file skill tree — SKIP (cargo-cult)
- **source_does**: sha256-manifested per-agent sync of hundreds of builtin
  skill files on every daemon boot (`99_skills_engine.md` §5).
- **moxxie_current**: absent, correctly — moxxie is a small keyless CLI with
  (at most, per finding #1) a couple dozen flat playbook files shipped in the
  repo/package itself. There is no multi-agent fleet, no daemon, no
  hot-reload requirement.
- **recommendation**: skip entirely. If playbooks are added (finding #1),
  they ship as ordinary package files versioned with the CLI release — no
  runtime sync/integrity system needed at moxxie's scale.
- **keyless_ok**: n/a (infra, not a model concern).
- **evidence**: `99_skills_engine.md` §5; moxxie has no daemon/agent-fleet
  concept anywhere in handlers.ts.

### 10. `node:vm` skill-library runtime / REPL global injection — SKIP (cargo-cult)
- **source_does**: skills can ship a `library: ./x.js` CJS bundle that's
  `runInContext`'d into a locked-down REPL VM and attached/detached as the
  active tab URL changes (`99_skills_engine.md` §2).
- **moxxie_current**: absent, correctly — moxxie has no REPL/VM execution
  model at all; it's a stateless-per-invocation CLI (`withConnection`,
  handlers.ts:131-141) driven entirely by the host process, not by injecting
  code into a sandboxed JS context. Building a `node:vm` loader for moxxie
  would be adding an entire subsystem with no host-controlled equivalent need
  — the host already runs its own code, it doesn't need moxxie to host a
  second sandboxed runtime.
- **recommendation**: skip entirely.
- **keyless_ok**: n/a.
- **evidence**: `99_skills_engine.md` §2.1-2.3; moxxie `withConnection`
  handlers.ts:130-141 (per-call connect/close, no persistent VM).

## Top recommendation

Ship keyless site-playbook files + a pure URL-glob matcher (findings #1, #2,
#6) as `moxxie skill site`/`skill list`/`skill show`, and add a byte-capped,
optionally-clipped, optionally-@eN-annotated screenshot path (findings #3,
#4, #8) to `handleScreenshot`. Both are direct ports of ASIDE's *mechanism*
(glob scoring, resize-before-context, DOM overlay reusing existing ref ids)
onto moxxie's existing primitives (`refmap`/`@eN`, `presentPageText`'s
cap-then-neutralize precedent, `page.screenshot`) — no model call, no daemon,
no VM sandbox required anywhere in the chain.
