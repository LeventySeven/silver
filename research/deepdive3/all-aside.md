# All-Aside deep dive round 3 — beyond the prior four digests

Read exhaustively this round: `_aside_parts/30_tools.md` (full 19-tool registry), `60_native_security.md`
(daemon/vault/crypto), `99_skills_engine.md` (skill matcher + library runtime + verbatim skill bodies),
`89_guardrails_captcha.md` (captcha, amount-extraction, actor-safety lists, notification/heartbeat).
Cross-checked against Silver source (`security/egress.ts`, `core/handlers.ts`, `memory/`, and a repo-wide
grep confirming Silver has **no** skill-matching system, **no** captcha primitive, **no** rate-limiter,
**no** navigation denylist, **no** cookie-authenticated fetch verb, **no** secret-blind fill). Prior
digests (`aside-engine`, `aside-longhorizon`, `aside-perception`, `aside-top5dx`) already covered `repl`,
memory/subagents, the snapshot builder, and the headline guardrail/actionability items — this round does
NOT repeat those; everything below is new surface.

## 1. Skill auto-injection matcher (`hat`/`gat`) — a portable scoring algorithm Silver lacks entirely
Aside resolves which of ~44 skills apply to the current URL/message via two scorers: `hat` (host-glob ×
path-glob, `score = 100·hostNonWildcardChars + 10·pathNonWildcardChars − wildcardCount`, minimatch-based,
case-insensitive) and `gat` (keyword-in-URL, word-boundary, scored by keyword length) — `99_skills_engine.md`
§1.2-1.3. Non-`siteSpecific` skills go into an always-on `<skills_instructions>` block (name+description+path
only, progressive disclosure); `siteSpecific` skills are hidden until a URL/message match fires. Silver has
no skill directory (`find . -iname "*skill*"` → empty) and no equivalent of Silver's own skill-design doc
(`research/synthesis/skill-design.md`) implementing a *runtime* matcher — it's currently a static list, if
anything. **Silver change:** a `skills/index.ts` that loads `SKILL.md` frontmatter (`autoInject.keywords[]`,
`autoInject.url[]`, `siteSpecific`), and a `silver skills resolve --url <u>` / `--message <text>` verb
implementing the identical `hat`/`gat` scoring formula — pure string/regex math, zero model calls.
**KEYLESS:** yes, no model in the matcher itself (the host LLM still authors skill bodies). **Priority: HIGH**
— this is a concrete, cheap, well-specified algorithm and Silver's skill system doc exists but nothing
implements auto-injection yet.

## 2. Cookie-authenticated direct-API fetch — Silver has cookie *storage* but no cookie-authenticated *fetch* verb
Aside's biggest practical differentiator isn't the browser at all — it's that `gmail`, `slack`, `notion`,
`linkedin`, `twitter` are native REPL globals that hit each site's **internal API directly over the user's
existing cookies/localStorage token**, never opening a tab (`99_skills_engine.md` §3.3-3.7): Gmail's sync
API, Slack's `xoxc-` token pulled from localStorage then fed to the real `@slack/web-api`, Notion's
`token_v2`, LinkedIn's Voyager API, X's GraphQL. This collapses "click through 5 pages to search email" into
one authenticated HTTP call. Silver already has `cookies set --curl <file>` (`core/handlers.ts:1324-1338`)
and `context.addCookies`, but no `webfetch --use-cookies` verb comparable to Aside's `webfetch(url,{useCookies})`
(`30_tools.md` §4.5) — a grep for `webfetch` in Silver's registry returns nothing. **Silver change:** add a
`fetch` verb that does `context.request.get(url, {headers: {Cookie: <serialized-cookie-jar-for-origin>}})`
and returns raw text/JSON (optionally markdown-converted like Aside's), so the host LLM can drive read-heavy
API calls (search, list, read-thread) without spinning up a tab per query — order-of-magnitude cheaper than
snapshot+click for read-only site operations. **KEYLESS:** yes — this is plain HTTP, no model call; the host
LLM supplies the URL/params exactly as it already does for `snapshot`. **Priority: HIGH** — directly portable,
big latency/cost win, doesn't require reverse-engineering each site's private API (host LLM can still fall
back to snapshot-driven UI automation; this is an accelerant, not a replacement).

## 3. Secret-blind form fill — Silver's `fill` verb always puts the plaintext value in the tool call
Aside's password-manager contract is deliberately secret-blind: `generatePassword()` returns an opaque
`GeneratedPasswordRef` (a `Symbol`, never resolved to plaintext outside the native layer), and
`fillPassword(page, fieldRef, ref)` / `autofillItem(page, itemId)` fill the DOM **without the LLM ever seeing
the value** (`99_skills_engine.md` §3.8, `60_native_security.md` §6.3 `agentAccessPolicy`). Silver has no
credential vault (correctly out of scope per prior digests) but the *pattern* — never let a secret transit
the LLM's context — is adoptable without a vault: Silver already has `core/state-crypto.ts` (AES-256-GCM) and
env-var-driven config. **Silver change:** a `fill --secret-env <VAR_NAME>` mode that reads the value from an
env var / OS keychain entry server-side and fills the resolved locator directly, returning only
`{filled: true, length: N}` in the envelope — the value never appears in stdout, logs, or the LLM's tool
result. **KEYLESS:** yes, pure IPC/env-var mechanics. **Priority: MEDIUM** — real security win for login/API-key
entry flows (common agent task: "log into X using my saved password") without building a vault.

## 4. Navigation-layer denylist (regulated-goods + credential-page block) — Aside's second, harder-to-bypass gate
`ActorSafetyLists` ships 512 `navigation_blocked` hosts (`{from:"*",to:host}`) split into (a) Google
credential/account surfaces (`accounts.google.com`, `myaccount.google.com`, `passwords.google.com`,
`chromewebstore.google.com`) and (b) ~508 regulated-goods merchants (firearms, vape/cannabis, alcohol,
gambling) — enforced at the **native browser navigation throttle**, below any driving API, so it still binds
even when the agent's own CDP path bypasses the native Actor's separate allowlist (`89_guardrails_captcha.md`
§3, confirmed a genuine two-layer design, not redundant). Silver's `security/egress.ts` denylist is
scheme+host only and opt-in (`--allowed-domains`) — there is no shipped baseline denylist for credential-
management pages or regulated categories. **Silver change:** ship a small bundled `blocklist.json`
(credential-management hosts: `accounts.google.com`, `myaccount.google.com`, `*.okta.com/login`, password-
reset pages generically by path pattern; optionally an opt-in regulated-merchant category list) enforced in
`security/egress.ts` **unconditionally** (not behind `--allowed-domains`), so it survives regardless of which
verb drives navigation. **KEYLESS:** yes, static JSON + host-match, no model. **Priority: MEDIUM** — cheap,
addresses a real gap the top5dx digest flagged as "not confirmed present," and now the concrete host list and
enforcement layer to copy exist.

## 5. Lookalike/typosquat domain rejection — a check Silver has zero equivalent of
Chromium's native `site_policy.cc MayActOnUrl` includes a `"Lookalike domain"` reject reason
(`89_guardrails_captcha.md` §3.3) — i.e. before acting, the reject list checks whether the destination is a
typosquat of a known-trusted domain (homoglyph/edit-distance against a reference set). Silver has no
domain-similarity check anywhere. **Silver change:** an optional `--warn-lookalike` mode on `open`/`click`-
that-navigates: compute Levenshtein/confusable-character distance against a small reference list (top
retail/bank/SSO domains, or a user-supplied `--trusted-domains` list) and return a `{warning:
"lookalike_domain", target, closestMatch}` field in the envelope instead of silently navigating — the host
LLM decides whether to proceed. **KEYLESS:** yes, pure string algorithm. **Priority: LOW-MEDIUM** — real
phishing-defense value for agentic checkout/login flows, cheap to implement, but narrower blast radius than
items 1-4.

## 6. Per-site action rate-limiting — the LinkedIn skill's throttling table is a portable pattern, not just content
`99_skills_engine.md` §4.1 documents LinkedIn-specific safe defaults baked into the skill body (invitations
≤15/day 2-5min apart, cold messages ≤20/day, `429`→exponential backoff honoring `Retry-After`, `999`→WAF
block, checkpoint-redirect→stop writes 24-48h, "slide & spike" account-age multiplier). This is host-LLM-
readable prose today in Aside, but Silver could make the *mechanical* half (the token-bucket enforcement, not
the judgment) a first-class primitive: currently nothing in Silver tracks call frequency per (verb, domain).
**Silver change:** a lightweight `security/ratelimit.ts` — a per-`(verb,hostname)` sliding-window counter
persisted in `~/.silver/<ns>/ratelimit.json`, configurable via a `ratelimit.json` policy file (domain →
{verb: maxPerWindow}), enforced as a soft block (`rate_limited` envelope field) before actor verbs run against
matched domains. The host LLM (or a bundled default policy for known bot-sensitive sites: LinkedIn, X,
Instagram) supplies the numbers; Silver just enforces the counter. **KEYLESS:** yes. **Priority: MEDIUM** —
this is the single most concrete "don't get the user's account banned" mechanism in the whole corpus and
nothing in Silver enforces call cadence today.

## 7. CAPTCHA-solving primitives (CDP-mouse + host-vision OCR loop) — zero external solver dependency, fully keyless
Aside's `captcha` global (`89_guardrails_captcha.md` §1) is three primitives: `click(bounds)` (synthetic
mouse click at `x+width*0.15, y+height/2` — the reCAPTCHA-checkbox sweet spot — then wait 3s, re-snapshot),
`drag(from,to,{steps=20})` (20-step interpolated mouse-down/move/up for slider puzzles), and `readText(bounds)`
(screenshot the region, send to the model for OCR, `maxTokens:64`, "read left to right, characters only").
Critically there is **no third-party solver API** anywhere in the daemon — it's CDP input events + the
agent's own vision capability. This maps almost perfectly onto Silver's keyless model: Silver already has
mouse-level actuation (`actuation/actions.ts`) and screenshot (`capture.ts`); it's missing only the
*primitives shaped for this exact pattern*. **Silver change:** add `dragPath(from,to,{steps})` (interpolated
multi-step drag, not just Playwright's atomic `dragTo`) and a `region-screenshot --clip <x,y,w,h>` verb
returning base64 for the host LLM to OCR itself (Silver never calls a model — the host does the reading, same
division of labor as everything else in Silver). **KEYLESS:** yes — Silver supplies the mechanical primitives,
host supplies vision. **Priority: HIGH** — this is a fully-specified, novel capability with zero licensing/API
dependency, directly implementable, and closes a real functional gap (Silver currently has no first-class way
to solve a slider/checkbox captcha at all).

## 8. Content-addressed, self-healing config/policy sync — a distribution pattern worth borrowing narrowly
Aside's skill tree (414 files) syncs via a sha256 manifest (`.bootstrap-manifest.json`) that rewrites only
changed files and deletes orphans on every boot (`99_skills_engine.md` §5) — hand-edits to a builtin file get
reverted next boot (anti-tamper + self-heal). Aside's `ActorSafetyLists`/`CaptchaProviders`/
`AmountExtractionHeuristicRegexes` are signed, remotely-updatable Chromium components (`89_guardrails_captcha.md`
§1.3, §2.1, §3.1) — the denylists/regexes update without a full app release. **Silver change (narrow,
optional):** apply the same content-addressed sync idea to Silver's *own* bundled policy files (item 4's
blocklist, item 6's default rate-limit table) — ship a sha256 manifest so `silver update-policies --from
<url-or-file>` can refresh them without a version bump, and detect+warn on local hand-edits rather than silently
diverging. **KEYLESS:** yes. **Priority: LOW** — nice-to-have distribution hygiene, not a functional gap.

## 9. Verbatim amount-extraction regex — directly portable, not just a recommendation
Prior digests (top5dx) recommended porting Aside's amount-extraction guardrail but didn't have the regex.
This round extracted it verbatim (`89_guardrails_captcha.md` §2.1): `amount_pattern` =
`(?:US\$|USD|\$)\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?...` and a 24-label `keyword_pattern` anchored on
`Order Total|Total|Flight total|Reservation Deposit Amount Due|...` scanning the 6 lines following a label
match. **Silver change:** drop these two regexes into `security/confirm.ts` as `extractCheckoutAmount(text)`,
run against the current snapshot/DOM text before a destructive/paid actor verb fires, and surface the matched
amount in the confirm-gate preview (extends the P1 item from `aside-top5dx.md` with the exact pattern instead
of "port the regex list"). **KEYLESS:** yes. **Priority: HIGH** (now trivial to implement — no design work
left, just paste the regex and wire it into the existing confirm gate).

## Priority summary
**HIGH, ship first:** #1 skill auto-inject matcher (algorithm ready to port), #2 cookie-authenticated fetch
verb (biggest latency/capability win of this round), #7 CAPTCHA primitives (novel, fully specified,
zero-dependency), #9 verbatim amount-extraction regex (trivial, extends existing top5dx P1).
**MEDIUM:** #3 secret-blind fill (security), #4 navigation denylist (security, now has concrete host list),
#6 per-site rate limiting (account-safety, addresses a failure mode nothing else in the corpus covers).
**LOW/LOW-MEDIUM:** #5 lookalike-domain check, #8 content-addressed policy sync (distribution hygiene only).
