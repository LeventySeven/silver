# Aside native security stack vs moxxie security defaults — gap alignment

Source: `_aside_parts/60_native_security.md` (native/daemon/vault security), `_aside_parts/89_guardrails_captcha.md` (captcha, amount extraction, actor-safety lists, `final_confirm`).
Moxxie modules read: `src/security/{confirm.ts,registry.ts,injection.ts,egress.ts,redact.ts}`, wiring in `src/core/handlers.ts` (`handleAct`), flag parsing in `src/core/flags.ts`, error taxonomy in `src/core/errors.ts`.

## Headline: the confirm gate is fail-OPEN by default, not fail-closed

`src/security/confirm.ts`'s own doc comment claims: *"On a NON-TTY... the gate FAILS CLOSED — the action is denied unless the operator pre-approved."* But in `src/core/handlers.ts:396`, `confirmGateDecision()` is only invoked when `flags.confirmActionsProvided` is true (i.e. the operator typed `--confirm-actions` at all, even with an empty list — see `flags.ts:192`). If the operator runs moxxie with only `--enable-actions` (no `--confirm-actions`), **every mutating verb in `MUTATING_VERBS` — click, fill, download, eval, upload — executes immediately with zero confirmation, TTY or not.** The fail-closed logic in `confirm.ts` is real code that is simply never reached on the primary invocation path. This is the single highest-value fix: Aside's `final_confirm` prompt-level gate is unconditionally ON for "externally visible, destructive, paid, or hard-to-reverse" actions; moxxie's equivalent is opt-in and therefore off by default for the common case.

## No audit log exists at all

Aside's daemon persists per-routine `permission_mode`/`system_prompt`/`incognito`/`ephemeral` in SQLite and the native Actor journals every action via `aggregated_journal` (`aggregated_journal_file_serializer.cc`). Moxxie has **zero** append-only record of what actions were taken, what was blocked, or what was confirmed/denied — confirmed by `grep -ril audit src/` returning nothing. There is no file anywhere under `src/` that logs a decision. This means: (a) a host LLM (or its operator) cannot post-hoc reconstruct what an agent run actually did to a page/account, (b) the confirm-gate's own deny/allow decisions vanish the instant they're returned, (c) there's no way to detect "the agent tried 40 mutating actions in a non-TTY run and all were silently fail-open" without re-running with logging bolted on ad hoc.

## `captcha_detected` is a dead error code

`src/core/errors.ts:37` declares `captcha_detected` with the message *"a CAPTCHA was detected; human action is required — this agent does not solve CAPTCHAs."* Good keyless design decision (matches Aside's own stated non-goal — Aside's `captcha-solver` skill only exists because Aside is agentic-loop-native with a vision model on tap; a keyless CLI correctly refuses to solve). But nothing in the codebase ever *throws* it — `grep -rn "captcha_detected"` outside `errors.ts` returns nothing, and there is no captcha-provider detection logic anywhere (no equivalent of Aside's `CaptchaProviders` component: `*google.com/recaptcha/api2/*`, `*hcaptcha.com/captcha/*`, `*challenges.cloudflare.com/*` glob list). The error exists but can never fire.

## Findings

1. **[P0, adopt] Confirm gate must default-engage, not require `--confirm-actions` to be present at all.**
   - Source: `89_guardrails_captcha.md` §5.1 — `final_confirm` is unconditionally injected into the system prompt whenever the agent has action capability; it is not an opt-in flag the operator must separately enable.
   - moxxie current: `src/core/handlers.ts:396` — `if (flags.confirmActionsProvided && requiresConfirm(verb))`. Without the flag, `confirmGateDecision` is never called, so `MUTATING_VERBS` run unconditionally once `--enable-actions` is set.
   - Change: in `handleAct` (`src/core/handlers.ts`), call `confirmGateDecision` whenever `requiresConfirm(verb)` is true and `flags.enableActions` is set — regardless of whether `--confirm-actions` was passed. Keep `--confirm-actions <verb,...>` as the pre-approval allowlist (its current semantics in `confirmGateDecision` are correct), but stop gating the *call* itself behind `confirmActionsProvided`. This makes non-TTY runs fail-closed for mutating verbs by default, matching the doc comment's stated intent and Aside's default-on posture.
   - keyless_ok: true (pure control-flow change, no model call).
   - Evidence: `src/core/handlers.ts:392-403`, `src/security/confirm.ts:83-100`, `src/core/flags.ts:138-192`; Aside `89_guardrails_captcha.md` §5.1.

2. **[P0, adopt] Add a minimal append-only audit log for every security-relevant decision.**
   - Source: `60_native_security.md` §3.2 (daemon SQLite `permission_mode`/routine persistence) + `89_guardrails_captcha.md` §3.2 (`Actor.NavigationGating` parse-result histograms / `aggregated_journal`) — every gate decision and every navigation allow/block is durably recorded, not just returned once.
   - moxxie current: absent. `confirmGateDecision`, `assertNavigable`, and the (currently-dead) `captcha_detected` path all return a decision that is used once and discarded; no file records it.
   - Change: add `src/security/audit.ts` exporting `logAuditEvent(event: {ts, verb, ref?, decision, reason, code?})` that appends one JSON line to a session-scoped file (e.g. `<session-dir>/audit.jsonl`, reusing whatever path `src/core/session.ts` already resolves for session state — keep it colocated with existing session artifacts rather than inventing a new global path). Wire it into `handlers.ts` at three points: (a) the confirm-gate decision (allow/deny + reason), (b) `assertNavigable` deny in `handleRead`/navigation handlers, (c) the captcha-detection throw from finding 3. Pure local file I/O, no model call, no network.
   - keyless_ok: true.
   - Evidence: `src/core/handlers.ts` (no logging calls anywhere), `src/security/confirm.ts`, `src/security/egress.ts`; Aside daemon SQLite columns `routine_id, permission_mode, incognito, ephemeral` (`60_native_security.md` §3.2).

3. **[P1, adopt] Wire the dead `captcha_detected` error code to a real keyless detector.**
   - Source: `89_guardrails_captcha.md` §1.3 — Aside's `CaptchaProviders` component is a pure URL-glob detector (`*google.com/recaptcha/api2/*`, `*hcaptcha.com/captcha/*`, `*challenges.cloudflare.com/*`) used only to *flag* captcha presence, completely separate from (and simpler than) their vision-OCR solver. This detection half is 100% keyless and directly portable.
   - moxxie current: `src/core/errors.ts:37` declares `captcha_detected` with message "this agent does not solve CAPTCHAs" (correct keyless posture) but nothing throws it — confirmed via repo-wide grep.
   - Change: add a small detector (e.g. in `src/perception/` alongside the snapshot walk, or a new `src/security/captcha.ts`) that checks iframe `src` / frame URLs collected during snapshot against a short static glob list (recaptcha `/recaptcha/api2/`, `/recaptcha/enterprise/`, hcaptcha `hcaptcha.com/captcha/`, Cloudflare `challenges.cloudflare.com`, funcaptcha `funcaptcha.com`/`arkoselabs.com`), and returns `fail('captcha_detected')` from the relevant handler (snapshot/act) when matched. No mouse-CDP solving, no vision OCR — moxxie should stay a pure detector and hand off to the human/host, consistent with its own error message.
   - keyless_ok: true (string/glob match only — explicitly do NOT adopt Aside's vision-OCR `readText`/`click`/`drag` solver, that requires a model call and is out of scope for a keyless CLI).
   - Evidence: `src/core/errors.ts:37-41`; Aside `89_guardrails_captcha.md` §1.3 (`captcha_providers.json` verbatim glob list).

4. **[P1, adopt] Stamp a locally-extracted checkout amount onto the confirm context for `paid` actions.**
   - Source: `89_guardrails_captcha.md` §2 — Aside's `amount_pattern`/`keyword_pattern` regex pair scans the 6 lines after a "Total"/"Order Total"/"Amount to pay" label to extract the checkout total *before* the purchase-confirm gate fires, so the confirmation can name the dollar amount and re-fire if it changes.
   - moxxie current: `src/security/confirm.ts` `ConfirmContext` already has a `paid?: boolean` flag (`confirm.ts:47`) but nothing populates it with an amount, and nothing extracts one — the host has to know the price out-of-band.
   - Change: add a small local regex extractor (reuse the two regex shapes verbatim from `89_guardrails_captcha.md` §2.1 — they're public Chromium/BNPL patterns, not proprietary) that runs over page text when a `paid`-flagged act is requested, and include the matched amount string in the `ConfirmGateDecision`/audit-log reason (e.g. `reason: "confirmation required: paid action, detected total $42.00"`). This doesn't add a re-confirm *enforcement* mechanism (that's the host's job per finding 5) — it just surfaces the amount so the host's own re-confirm logic has something concrete to compare against.
   - keyless_ok: true (regex only).
   - Evidence: `src/security/confirm.ts:46-49`; Aside `89_guardrails_captcha.md` §2.1 (verbatim `amount_pattern`/`keyword_pattern`).

5. **[P2, align] Document + lightly enforce "material change invalidates a prior confirm" using the existing fingerprint, not new machinery.**
   - Source: `89_guardrails_captcha.md` §5.1 — *"If the page, recipient, amount, body, or visible consequence materially changes, ask again."*
   - moxxie current: `confirm.ts`'s doc comment already states this as a *host* contract ("the host must treat a retry... as a fresh consequential action") but nothing in moxxie enforces it — it's prose only. Separately, `handleAct` already computes `fingerprint`/`page_changed`/`stale_refs` per action (`handlers.ts:424-435`).
   - Change: no new detection system — just have the confirm-gate deny path (finding 1) additionally check `stale_refs`/`page_changed` if the caller passes the *previous* fingerprint alongside a pre-approved verb, and force a deny (re-confirm) when it doesn't match. This reuses infrastructure moxxie already built for a different purpose rather than importing Aside's amount/recipient/body diffing (which needs semantic understanding moxxie can't do keylessly).
   - keyless_ok: true (fingerprint comparison, already computed).
   - Evidence: `src/core/handlers.ts:424-435`; `src/security/confirm.ts` doc comment lines 12-14.

6. **[P2, align] Add 2-3 more identity-provider hosts to the egress denylist; do not adopt Aside's 512-host regulated-goods list.**
   - Source: `60_native_security.md` §2.2 / `89_guardrails_captcha.md` §3.1 — `navigation_blocked` covers Google account/password/webstore pages *plus* ~508 regulated-goods merchant domains (alcohol/firearms/vape/cannabis/gambling).
   - moxxie current: `src/security/egress.ts:42-51` `KNOWN_DANGEROUS_HOSTS` has 8 entries — Google account family, Microsoft/Live login, Apple ID, addons.mozilla.org. Missing peers like `github.com/login`-class SSO hosts are debatable; the identity-provider cluster is the part worth extending (cheap, high value: credential pages an agent should never autonomously touch).
   - Change: extend `KNOWN_DANGEROUS_HOSTS` with a handful more identity/account-recovery hosts (e.g. `id.atlassian.com`, `secure.login.gov`, `okta.com` suffix) if/when a concrete incident motivates it — keep the list short and exact-or-suffix matched as today.
   - keyless_ok: true.
   - Evidence: `src/security/egress.ts:42-51`.
   - **Explicitly skip-cargo-cult**: do NOT import Aside's 508-entry regulated-goods merchant denylist. That list requires an externally-updated, versioned component (`ActorSafetyLists`, Omaha-delivered) to stay current — moxxie has no update channel, and a stale hardcoded 500-domain blocklist is worse than no list (false sense of coverage, maintenance burden, scope creep for a browser-automation CLI that isn't a general commerce guardrail product).

7. **[skip-cargo-cult] Do not adopt Aside's subagent tool-gate / destructive-bash-regex hook.**
   - Source: `89_guardrails_captcha.md` §5.3 — `M4t` hook blocking `request_action_confirmation`/`ask_user_question`/write-tools/destructive-bash-regex for spawned subagents.
   - moxxie current: n/a — moxxie has no subagent-spawning concept; it's a single-process CLI driven by a host LLM, not a multi-agent daemon.
   - Change: none. This guardrail exists because Aside's daemon spawns and needs to sandbox *other agent sessions*; moxxie's threat model (one host LLM issuing shell-style verb commands) doesn't have that surface. Re-introducing it would be premature machinery for a problem moxxie doesn't have.
   - keyless_ok: n/a.

8. **[skip-cargo-cult] Do not adopt Aside's notification/heartbeat wake system or the vault `agentAccessPolicy` credential gate.**
   - Source: `60_native_security.md` §6.3, `89_guardrails_captcha.md` §4.
   - moxxie current: n/a — no password manager, no long-running daemon session to wake, no push-notification surface.
   - Change: none. Both are real security mechanisms for Aside's always-on daemon + vault architecture; moxxie is a synchronous CLI invoked per-command by a host LLM and has neither a credential store nor a persistent session to protect this way. Importing either would be scope creep unrelated to moxxie's actual attack surface (page content → host LLM, and host LLM → page actions).
   - keyless_ok: n/a.

9. **[P1, adopt] `neutralize()` boundary markers are good; extend the forged-tag list using Aside's own observed injection surface (page-title/notification spoofing), not new mechanism.**
   - Source: `89_guardrails_captcha.md` §4.5 — `Aside.showNotification` bridge accepts arbitrary `title`/`message`/`buttons` strings that ultimately surface to the human; a hostile page manipulating DOM text nodes that end up serialized as "notification-like" content is a related spoofing vector to the `<system>`/`<assistant>` tag forgery moxxie already strips.
   - moxxie current: `src/security/injection.ts:34-35` strips `<system|user|tool|assistant>` and `<untrusted...>` tags only.
   - Change: low-cost extension — also strip/neutralize common instruction-injection phrasings that don't use XML tags at all (e.g. literal strings `"ignore previous instructions"`, `"### system"`, markdown-fenced fake tool-call blocks) is a much larger and fuzzier surface; rather than chase phrasing, the concrete, bounded win is to ensure `neutralize()` is actually called on **every** page-derived string that reaches the host, including alt-text/aria-label/title attributes surfaced by the snapshot serializer, not just the free-text dumps — verify `redact.ts`'s serializer choke point and `injection.ts`'s neutralize choke point are both actually wired to the *same* set of emission paths (this needs a follow-up read of `src/perception/` to confirm; flagging as a check, not a confirmed gap).
   - keyless_ok: true.
   - Evidence: `src/security/injection.ts:34-46`; Aside `89_guardrails_captcha.md` §4.5 (tangential).

## Top recommendation

Fix finding 1 first: flip the confirm gate from "only engages if `--confirm-actions` was typed" to "engages whenever `--enable-actions` + a mutating verb, using `--confirm-actions` only as the pre-approval allowlist." This is a ~5-line change in `src/core/handlers.ts:396` and closes the gap between moxxie's documented fail-closed design and its actual fail-open behavior on the default non-TTY agent-driving path — the exact scenario the doc comment in `confirm.ts` claims is covered. Pair it with finding 2 (audit log) so the gate's decisions are durable evidence, not a one-shot return value.
