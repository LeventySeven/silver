# Aside — Security & Guardrails Digest (source: aside:security+guardrails)

Mined from:
- `_aside_parts/60_native_security.md` (Chromium fork, daemon, password manager, E2E crypto)
- `_aside_parts/89_guardrails_captcha.md` (captcha solving, amount extraction, actor-safety lists, notifications, final_confirm, subagent tool gate)
- `_aside_parts/100_agent_errors_modes.md` (retry/compaction/error paths, fs-jail, completion/verification loop)

All facts below are labeled KNOWN (verbatim/carved from binary or bundle) or INFERRED (reasoned) as in the source. No lethal-trifecta *naming* appears verbatim in Aside's own material — Part 60 §7.4 constructs the framing itself ("Aside's agent has all three legs of the lethal trifecta") — this is the teardown author's analysis, not a quoted Aside document. Likewise there is no `<untrusted_repl_output>` fencing or explicit "tool output is DATA not INSTRUCTIONS" prompt clause found in these three parts — flagged as a **gap**, not fabricated.

---

## Killer Insight

Aside's security model is not one mechanism but a **stack of independently-owned gates at different layers**, each blind to the others, and the teardown explicitly shows where that stacking has a real bypass: the CDP-driving agent **escapes the native Chromium Actor allowlist** (`site_policy.MayActOnUrl`) because it never routes through the Actor tool-invocation path — but it is **still hard-blocked by the browser-native navigation denylist** (`ActorSafetyLists.navigation_blocked`, enforced below CDP) and **soft-blocked by a prompt-level gate** (`final_confirm` / `request_action_confirmation`). The lesson for the ultimate agent-browser CLI: **don't rely on any single layer.** Put a hard deny-list at the lowest possible layer (network/navigation throttle, outside the agent's own driving surface, so a compromised or injected agent loop cannot route around it), a narrower allow/consent gate at the tool-invocation layer, and a typed, un-bypassable "confirm before consequential action" contract at the prompt/orchestration layer — and assume each layer will be partially bypassable, so the guarantee has to come from the *intersection*, not any one gate.

---

## Patterns

### 1. `final_confirm` — verbatim confirm-before-consequential-action prompt block (CORE)
**What:** A system-prompt-injected block (daemon const `BJt`, appended via `VJt = e => \`${e.trimEnd()}\n\n${BJt}\``) that forces the model to call a `request_action_confirmation` tool before any "externally visible, destructive, paid, or hard-to-reverse" action, and to treat that tool call as the sole content of its turn.
**Why:** This is the actual load-bearing guardrail for agentic commerce/destructive actions — cheaper and more portable than native browser gating, works regardless of driving transport (CDP vs Actor vs anything else).
**How to implement:** Ship this exact prompt fragment (or a close adaptation) appended to every agent system prompt when "confirm mode" is on:
```
<final_confirm>
Final confirm mode is enabled.
Before any externally visible, destructive, paid, or hard-to-reverse web action, you MUST call
request_action_confirmation and wait for the user's decision. Covered actions include sending messages or
email, posting or publishing, purchases or subscriptions, deletions, account/security/privacy changes,
invitations, connection requests, and final form submissions.
You may still navigate, read, draft, fill forms before submit, and make reversible local changes without confirmation.
The confirmation tool call MUST be the only tool call in that assistant turn and MUST include:
- a short title and a concise message explaining upfront what you want to do and why,
- a review artifact matching the destination when possible (gmail-draft, linkedin-message-draft,
  slack-message-draft, calendar-event-draft, x-tweet-draft, linkedin-post-draft),
- or a screenshot fallback artifact with a session-relative local image path.
After confirmation, perform only the approved action. If the page, recipient, amount, body, or visible
consequence materially changes, ask again. If the user cancels or revises, follow that instruction instead.
</final_confirm>
```
Enforce mechanically at the tool-dispatch layer too, not just via prompt: reject a turn that both calls `request_action_confirmation` and any other tool. Re-arm the gate ("materially changes → ask again") by diffing the confirmed target (amount/recipient/body) against the state right before execution.
**Evidence:** `89_guardrails_captcha.md` §5.1 (verbatim block, daemon const `BJt`).
**Tier:** core.

### 2. `agentAccessPolicy` — per-credential three-state agent gate (CORE)
**What:** Every saved credential (password, passkey) carries `agentAccessPolicy ∈ {"always","while-unlocked","never"}`, enforced by the vault worker before releasing a secret to the agent.
**Why:** Gives the human granular, per-site control over what an autonomous agent can authenticate as, independent of whether the vault itself is unlocked for the human. This is the credential-scoping primitive a browser-agent CLI needs before it can safely autofill/authenticate anywhere.
**How to implement:** Store a per-credential enum alongside every stored secret (password, API token, cookie jar entry, session token). Default conservatively at import time (`while-unlocked`, not `always`). Enforce the check in the single component that actually reads secrets out of storage — never let the agent-facing tool layer read raw secrets directly. Pair with a separate boolean **`reprompt`** flag (Bitwarden-style: force a fresh confirm/master-password check before using this specific credential even if policy allows it).
**Evidence:** `60_native_security.md` §6.3 (`agentAccessPolicy` enum + default-at-import + per-item editable), §7.4 table.
**Tier:** core.

### 3. Single-`externally_connectable`-id trust boundary (CORE)
**What:** The password-manager extension's manifest whitelists exactly **one** extension id (`fjdhphbdlfjogobdofoaagnlnkoibdge`, the agent) in `externally_connectable.ids`. No web page, no other extension, can message the vault.
**Why:** This is the entire agent↔secret-store trust boundary in one manifest line — dead simple, no runtime logic to get wrong, verifiable by inspection.
**How to implement:** If the agent-browser CLI has any local secret store / credential manager component, expose it only over a narrow authenticated local channel (unix socket / named pipe with peer-credential check, or an explicit allowlisted client-id handshake) — never a shared IPC bus reachable by page-injected content or other processes.
**Evidence:** `60_native_security.md` §5.1 (manifest excerpt, "This one line is the entire agent↔vault trust boundary").
**Tier:** core.

### 4. Cryptographic daemon-auth handshake — browser signs, extension never holds the key (IMPORTANT)
**What:** `asideAccount.signDaemonAuthChallenge(challenge)`: the **browser process** (not the extension) signs a daemon-issued challenge using account/device key material held in a Secure-Enclave-backed keychain group; the extension only relays the challenge and the signed response. The browser also mediates daemon lifecycle (can authorize/deny shutdown).
**Why:** Prevents any extension-side compromise (malicious content script, supply-chain compromise of the extension bundle) from directly minting daemon sessions — the signing key never touches extension-accessible memory.
**How to implement:** For a CLI with a local automation daemon, separate "holds the auth key" from "drives automation" into different privilege domains; require a signed challenge-response handshake to open a daemon session, with the signer being the most-trusted, least-code component in the stack (ideally OS-keychain/hardware-backed).
**Evidence:** `60_native_security.md` §4.2 (flow) + §1.4 (API schema).
**Tier:** important — high engineering cost, appropriate only once the CLI has a persistent local daemon and real secrets to protect.

### 5. Amount-extraction guardrail — regex + AI fallback feeding the confirm gate (CORE)
**What:** A checkout-total extractor: local regex stage (`keyword_pattern` matches 24 label variants like "Order Total", "Flight total", "Total Due Now"; scans the next `number_of_lines_to_check=6` lines for `amount_pattern`, a USD-sigil'd decimal regex), with an AI ("APC" = amount-from-page-content) server fallback when regex fails.
**Why:** This is *how the agent knows the price before it asks for confirmation* — without it, `final_confirm` can only say "I want to buy something" not "I want to spend $47.99." Amount is one of the fields (with recipient/body) that must be re-confirmed if it changes.
**How to implement:** Ship a small library of checkout-total label regexes (generalize the verbatim label list below) + a decimal-currency regex; scan N lines after a label match; if it fails, fall back to a cheap vision/LLM extraction pass on a screenshot/DOM snippet of the checkout region. Feed the extracted amount directly into the confirmation artifact so the human sees a concrete number, and re-run extraction right before submit to catch late total changes (tax, shipping, promo removal).
**Evidence:** `89_guardrails_captcha.md` §2.1 (verbatim regexes), §2.3 (tie to final_confirm).
**Tier:** core for any agent-browser doing commerce/checkout flows.

### 6. Captcha solving — CDP mouse + own-vision-model OCR, no third-party solver (IMPORTANT)
**What:** A `captcha` REPL global with three methods: `click(bounds)` (synthetic mouse click at `x+width*0.15, y+height/2`, wait 3s, re-snapshot), `drag(from,to,{steps:20})` (20-step interpolated mouse move+down+up, wait 2s, re-snapshot), `readText(bounds)` (screenshot region as JPEG→base64, feed to a dedicated `visual` model slot with a terse OCR system prompt, `maxTokens:64`). No 2Captcha/AntiCaptcha/CapMonster/DeathByCaptcha integration anywhere — confirmed by zero string hits.
**Why:** Removes a whole class of third-party dependency/cost/reliability risk and keeps captcha-solving auditable (it's just vision + mouse, the same primitives the agent already has). Detection (not solving) is separately handled by a small glob-list component so the skill can auto-inject.
**How to implement:**
- Detection: maintain a URL-glob list for known captcha iframe hosts (reCAPTCHA anchor/bframe both v2 and Enterprise, hCaptcha, Cloudflare Turnstile) to trigger the captcha-handling skill/prompt.
- Solving: implement `click`/`drag`/`readText` as literal Playwright/CDP primitives against real coordinates, not a special "solve" API. For text captchas, crop-to-region, base64-encode, send to a small dedicated vision model call with a minimal, constrained system prompt ("read left to right, only the characters, no explanation") and a small `maxTokens` cap to keep it cheap and deterministic-shaped.
- Have headless/HTTP-only fetchers (non-interactive scraping paths) **hard-fail on detected captcha markers** and surface a clear error back to the orchestrator/interactive agent rather than attempting to solve blind — captcha solving should only run in a real, visually-driven browser session.
**Evidence:** `89_guardrails_captcha.md` §1.1–1.4 (verbatim class body, verbatim SKILL.md front-matter, verbatim glob list, product-side hard-fail examples).
**Tier:** important — high value for any browser agent that will hit real consumer sites, but not "day one" required.

### 7. `CaptchaProviders` glob-list as a remotely-updatable component, decoupled from the solver logic (NICE)
**What:** The captcha-detection glob list ships as a signed, independently-versioned component (Chromium component-updater / Omaha channel equivalent), separate from the solving code.
**Why:** Captcha vendor URL patterns change; shipping the detection list as hot-updatable data (not baked into agent binary/prompt) means new captcha providers can be added without a full release.
**How to implement:** For a CLI tool, this maps to: keep the captcha-detector glob/regex list in a small versioned JSON file fetched/cached separately from the CLI binary (or vendored but easily diffable/PR-able), not hardcoded deep in solving logic.
**Evidence:** `89_guardrails_captcha.md` §1.3 (component manifest, signed `_metadata/verified_contents.json`).
**Tier:** nice-to-have.

### 8. Two-tier navigation gating: allowlist (bypassable) vs denylist (native, unbypassable) (CORE)
**What:** `ActorSafetyLists` component ships two JSON arrays: `navigation_blocked` (512 entries, `{from:"*", to:host}` — Google account/credential pages + ~508 regulated-goods merchants: alcohol/firearms/vape/cannabis/gambling) and `navigation_allowed` (21,005 explicit SSO cross-origin redirect pairs). Native `site_policy.cc` `MayActOnUrl` also independently gates the native Actor tool path (allowlist/safebrowsing/lookalike-domain/enterprise-policy checks) — but the teardown proves the CDP-driven agent bypasses this allowlist gate entirely (never invokes the Actor tool), while the `navigation_blocked` denylist is enforced at a lower browser-navigation-throttle layer that the CDP agent **cannot** bypass.
**Why:** This is the single most important architectural lesson in the corpus: an allowlist gate tied to a specific tool-invocation path is trivially bypassed by any alternate driving mechanism (CDP, direct protocol commands, a different automation library). A denylist enforced at the actual navigation/network layer, below any specific driving API, is not.
**How to implement:** Build the "you may never navigate here" denylist as a hook on the actual `Page.navigate`-equivalent primitive at the lowest layer your CLI controls (e.g., intercept in the CDP/automation-library wrapper itself, or via a network-layer proxy/DNS block), not as a check inside a higher-level "tool" abstraction that a differently-shaped call could route around. Seed the denylist with: identity/credential management pages of major providers (accounts.google.com, passwords.google.com, extension stores) and known regulated-goods merchant domains if the CLI is meant to be safe-by-default for autonomous purchases. Ship an allowlist only for explicit redirect exceptions (SSO chains), never as the primary gate.
**Evidence:** `89_guardrails_captcha.md` §3.1 (verbatim JSON samples), §3.3 (verbatim reject-reason strings), §3.5 ("Verdict" — the bypass analysis).
**Tier:** core.

### 9. `site_policy.cc` `MayActOnUrl` reject-reason taxonomy (NICE, reference)
**What:** Verbatim reject reasons for native-actor URL gating: `"Tab is an error document"`, `"Blocked by safebrowsing"`, `"Reject"`, `"Wrong scheme"`, `"IP address"`, `"Safebrowsing unavailable"`, `"Internal: Non-dogfood client"`, `"No Google groups"`, `"Allowlist is empty"`, `"URL not in allowlist"`, `"Enterprise policy block"`, `"Lookalike domain"`, `"Allow"`.
**Why:** A reasonable checklist of URL-safety checks worth replicating even without Chromium's specific machinery — especially "raw IP address," "wrong scheme," and "lookalike/typosquat domain" which catch classic phishing/redirect-abuse vectors an LLM agent won't reliably notice itself.
**How to implement:** Before any agent-initiated navigation, run: scheme check (http/https only unless explicitly permitted), reject raw-IP targets, run a lightweight typosquat/lookalike-domain heuristic (edit-distance against a small set of high-value brand domains, or against domains already visited in-session), and consult a safe-browsing-style reputation API if available. Treat "empty allowlist" as fail-closed only if you actually intend an allowlist-first posture — otherwise this becomes a footgun (see #8).
**Evidence:** `89_guardrails_captcha.md` §3.3.
**Tier:** nice — a defense-in-depth extra, not the core denylist mechanism itself.

### 10. Subagent tool gate + destructive-bash regex (CORE)
**What:** A hook (`M4t`) enforced on `tool.execute.before` and `file.access` that restricts **subagents** (never the top-level agent): a hard-blocked tool set (`request_action_confirmation`, `ask_user_question`, `subagent`, `fork_subagent` — subagents can never escalate confirmation or spawn further agents), an additional read-only-subagent blocked set (`write_file`, `edit_file`, `repl`), a `background-consult` subagent profile that gets **zero tools at all**, and a destructive-bash-command regex applied to any `bash` tool call from a read-only subagent.
**Why:** Prevents privilege escalation and confirmation-bypass through the sub-agent delegation pattern — a classic hole where the top-level agent has guardrails but a spawned helper doesn't. Also stops read-only research subagents from quietly mutating state via shell.
**How to implement (verbatim regex, generalize as needed):**
```js
// never allowed in ANY subagent:
['ask_user_question','request_action_confirmation','subagent','fork_subagent']
// blocked additionally for READ-ONLY subagents:
['write_file','edit_file','repl']
// destructive-bash detector (blocks these verbs for read-only subagents):
/(^|[;&|]\s*)(mkdir|touch|rm|cp|mv|chmod|chown|install|tee|npm|yarn|pnpm\s+(add|install|remove)
  |bun\s+(add|install|remove)|git\s+(add|commit|checkout|reset|clean|push|pull|merge|rebase|mv|rm|apply)
  |sed\s+-i)\b|<<|(^|[^<])>>?/
```
Also: give a `background-consult`-style profile (fire-and-forget informational subagent) literally no tool access at all, and hard-cap its runtime ("conclude the result after 10 minutes").
**Evidence:** `89_guardrails_captcha.md` §5.3 (verbatim code + regex + subagent brief quote).
**Tier:** core — directly applicable to any multi-agent/subagent orchestration in the CLI.

### 11. Retry classifier: allow-list + deny-list beats a blanket "retry on error" policy (CORE)
**What:** LLM-call failures are routed through a classifier (`#ne`) before any retry: a **deny-list** (billing/quota — `RateLimitError`, "Monthly usage limit reached", "available balance", `insufficient_quota`, "out of budget", "quota exceeded", "billing") short-circuits to a hard stop with zero retries; an **allow-list** of transient-error regex (`overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|...|timed?\s*out|timeout|...`) triggers exponential backoff retry (`2000·2^(n-1)` ms → 2s/4s/8s, `maxRetries:3`); the failed assistant turn is **dropped from history** before retrying so the model doesn't see its own broken output; the sleep is abortable.
**Why:** Naive retry-on-any-error either wastes money/time hammering a billing wall, or fails to retry genuinely transient network blips. Separating "will never succeed no matter how many times you retry" (billing/quota) from "will probably succeed on retry" (5xx/network/timeout) is the right shape.
**How to implement:** Maintain two regex/string lists exactly like this — a short deny-list for account/quota-exhaustion signals (fail fast, surface to user/orchestrator immediately, no retry) and a broader allow-list for transport/server transience (retry with exponential backoff, cap at 3 attempts, drop the failed turn from context before retry, make the backoff sleep cancellable via an AbortController-equivalent).
**Evidence:** `100_agent_errors_modes.md` §2a (verbatim classifier code, verbatim deny/allow strings), §1 (verbatim Zod config: `{maxRetries:3, baseDelayMs:2000, maxDelayMs:60000}`).
**Tier:** core.

### 12. Two-layer filesystem jail: hard path-resolve jail + separate policy-driven sandbox (CORE)
**What:** Layer 1 — a REPL `fs`/`path` global hard-jailed by literal path-resolve check: `path.resolve(cwd, p)` must `startsWith(agentRoot + sep)` or `=== agentRoot`, else throw `"Path escapes agent root: " + p"`; unconditional, no policy lookup. Layer 2 — a separate, richer sandbox policy object (`{readableRoots[], writableRoots[], outsideRead:"ask", outsideWrite:"ask"}`) that governs the daemon's own `read_file`/`write_file`/`bash` tools and is what user-granted "working directories" (e.g., Downloads, Documents) actually widen. Every Layer-1 access *also* fires a `file.access` permission hook that consults Layer 2 on top.
**Why:** A single-layer jail is either too restrictive (agent can never touch user-picked folders) or too permissive (any widening of scope widens *everything*, including the low-level REPL sandbox). Splitting "structurally impossible to escape" (hard resolve-check, no policy, no ask) from "policy-gated, user-widenable, ask-on-outside" gives you both safety and flexibility.
**How to implement:** Implement the REPL/sandboxed-code execution path's filesystem access with a hardcoded, un-configurable jail root (e.g., `~/.<cli>/agent-home/`) enforced by string-prefix check on the *resolved* absolute path (resolve symlinks too — the source doesn't show symlink handling explicitly, treat as a gap to close). Separately, give the CLI's own file tools (the ones the agent calls directly, not code it writes) a richer per-session policy object with explicit readable/writable root lists and an "ask" fallback for anything outside — and let the user's explicit folder-grants (e.g., a picked working directory) append only to *this* policy, never to the REPL's hard jail.
**Evidence:** `100_agent_errors_modes.md` §0c, §4a (verbatim guard code), §4b (`workingDirs` widening), §4d (on-disk layout: agent home read-only, session dir + granted folders writable).
**Tier:** core.

### 13. Output-too-large spill to file (context overflow valve, not a security control per se) (NICE)
**What:** A `console.log` output over 50KB is written to a `.txt` file under the session dir and only a 4KB preview enters model context; the model is nudged to `grep` the spilled file instead.
**Why:** Prevents a single noisy tool call (huge DOM dump, huge API response) from blowing the context budget, while still making the full data available on disk for follow-up inspection.
**How to implement:** Any tool-result serialization path should cap what enters the LLM context (e.g., 4KB), spill the full payload to a session-scoped temp/artifact file, and tell the model the path + a hint to grep/search it rather than silently truncating with no recovery path.
**Evidence:** `100_agent_errors_modes.md` §4c (`yUt=50KB`/`C$=4KB`).
**Tier:** nice — a UX/reliability pattern more than a security guardrail, but directly reusable.

### 14. Independent read-only verifier subagent as a completion gate (IMPORTANT)
**What:** Under "proactive mode," before the agent's final answer is accepted: (1) a criteria-generator LLM call (cheap `standard` model, `maxTokens:600`) writes ≤3 verification criteria **before seeing the answer** ("do NOT include a guessed final answer"); (2) a **read-only** verifier subagent reads the compacted trajectory + final answer + criteria and must output `VERDICT: PASS`/`VERDICT: FAIL` plus the concrete gap; it may call `open_tool_result(toolCallId)` and `webfetch` to check claims, but cannot redo the task; (3) on FAIL, under a continuation cap of 2, the agent is forced to continue with an injected system message.
**Why:** This is a genuinely different guardrail category from "confirm before acting" — it catches the agent silently fabricating or under-delivering, using an adversarial-ish self-check with pre-committed criteria (reduces post-hoc rationalization) and tool access limited to *verification*, not re-execution.
**How to implement:** For any long-horizon/proactive agent mode, add an optional verification pass: generate acceptance criteria from the task *before* the final answer is produced (or blind the criteria-generator to the answer), spawn a separate model call/subagent with read-only tool access (can inspect prior tool results and fetch URLs to check claims, cannot write/act), require a structured PASS/FAIL + gap explanation, and cap forced-continuation loops (e.g., 2) to avoid infinite self-correction loops.
**Evidence:** `100_agent_errors_modes.md` §5b (verbatim mechanism + prompt fragments, `I6=2` continuation cap).
**Tier:** important — high value for quality/trust, but a real engineering investment (extra LLM calls, criteria generation).

### 15. Native dialogs are auto-accepted, never allowed to deadlock the agent (CORE)
**What:** `window.confirm`/`alert`/`prompt` and similar blocking browser dialogs are auto-accepted (confirm→OK, prompt→default value, alert→dismissed) and converted into a `[system]` steering message telling the model what happened, rather than left to hang the automation.
**Why:** A blocking native dialog would otherwise deadlock a CDP/Playwright-style automation loop forever (nothing dispatches the click). Auto-accept-and-report converts a hard failure mode into a recoverable, model-visible signal — important because a stuck agent silently timing out is worse for debuggability than one that acted (possibly wrongly) and told you about it.
**How to implement:** Register dialog handlers at the automation-driver layer that always auto-accept with sane defaults, and push a synthesized `[system]` note into the tool-result/event stream describing exactly what dialog fired and what default value was used, so the agent (and a human reviewing logs) can catch a case where auto-accepting was the wrong call and course-correct.
**Evidence:** `100_agent_errors_modes.md` §2f (verbatim `[system]` message templates).
**Tier:** core — directly solves a real reliability failure mode any CDP/Playwright-based agent will hit.

### 16. Stale-reference errors are self-describing and drive model-level recovery, not silent retry (IMPORTANT)
**What:** When a stored element reference (`ref`) no longer resolves because the DOM changed, the locator throws a `RefStaleError` whose message is literally engineered as an instruction: `Ref "eN" is stale — the element was removed or the page changed. Take a new snapshot and retry.` This is *not* counted against the LLM-API retry budget — it's an ordinary tool result the model reacts to on its next turn.
**Why:** Prevents the single most dangerous failure mode in DOM automation — silently clicking the *wrong* element because a stale reference happened to still resolve to something. Making the ref system fail loudly and instructively, rather than either erroring cryptically or (worse) resolving to a different element, is a correctness/safety guardrail as much as a UX one.
**How to implement:** Any element-reference/handle system in the CLI should invalidate all refs on every fresh snapshot/accessibility-tree read, and throw an error whose message explicitly tells the model the corrective action ("take a new snapshot"), rather than either failing silently or letting a stale handle resolve to a different element.
**Evidence:** `100_agent_errors_modes.md` §2d (verbatim error string + real recovery trajectory).
**Tier:** important — core to DOM-automation correctness, adjacent to but not itself a "security" guardrail.

### 17. Actionability gate absorbs most failures below the model (`waitForReady`/`checkHitTarget`/`retarget`) (IMPORTANT)
**What:** Before every click/fill: `scrollIntoViewIfNeeded()`, `waitForReady([...])` (attached+visible+stable+receives-events), `checkHitTarget(point)` (verify the element under the click point is actually the intended element, not an overlay/cookie-banner), `retarget('follow-label')` (label→control resolution), with in-verb retry backoff `[0,100,200]` ms, and a DOM-activation fallback for checkboxes/radios that *verifies the state actually flipped*.
**Why:** Layered "absorb-then-warn-then-throw" handling of DOM flakiness is credited (in the source) with a 99% pass rate on the Mind2Web benchmark — most of what looks like "agent failure" is actually transient DOM state that a well-built actionability layer resolves without ever bothering the LLM.
**How to implement:** Before any synthetic click/fill in the CLI's browser driver: scroll target into view, wait for a composite "ready" condition (attached, visible, not animating, receives pointer events), hit-test the actual point being clicked against the intended element (catches cookie-banner/overlay misclicks — a real security-relevant failure mode, since a misclick could hit an unintended consequential button), retry with short backoff, and for state-toggle controls verify the resulting state actually changed rather than assuming the click succeeded.
**Evidence:** `100_agent_errors_modes.md` §2e (mechanism list + "obscured" hit-target rationale + 99% pass-rate claim).
**Tier:** important — reliability-critical, and the `checkHitTarget` piece is specifically security-relevant (prevents clickjacking-style misclicks on overlays).

### 18. Component-updater-delivered, signed guardrail data (denylists, captcha detectors, amount regexes) as hot-updatable, not baked into the agent/prompt (NICE)
**What:** All three guardrail-relevant data sets — `ActorSafetyLists` (navigation allow/deny), `CaptchaProviders` (detection globs), `AmountExtractionHeuristicRegexes` — ship as independently versioned, signed components via the browser's own component-updater/Omaha channel, decoupled from both the extension code and the LLM prompt.
**Why:** Guardrail data (regulated-merchant lists, captcha vendor patterns, checkout-label regexes) needs to update faster than the agent binary/prompt release cycle, and shipping it as data (not code, not prompt text) makes it auditable/diffable and reduces the blast radius of an update.
**How to implement:** For a CLI tool, this is lower-fidelity but the principle holds: keep denylists/regex-lists/label-lists as versioned config files (in the CLI's own repo or a small fetched manifest), not embedded in the system prompt or hardcoded deep in solving logic — makes them independently reviewable, and updatable without a full CLI release if fetched at runtime with signature/hash verification.
**Evidence:** `60_native_security.md` §1.6; `89_guardrails_captcha.md` §1.3, §2.1, §3.1 (all three components' manifest/versioning).
**Tier:** nice-to-have — good engineering hygiene, not a blocking requirement for v1.

### 19. Incognito / ephemeral session flags as independent booleans (NICE)
**What:** Session table carries two independent flags: `incognito` (agent runs against an off-the-record browser context — no history/cookies persisted) and `ephemeral` (session/agent state itself isn't durably retained). Both default `false`. Sync logic explicitly excludes incognito sessions (`WHERE COALESCE(s.incognito,0)=0`).
**Why:** Separating "don't persist browsing artifacts" from "don't persist agent memory/transcript" lets a caller ask for either or both independently — useful for privacy-sensitive one-off tasks (e.g., checking a personal account) without polluting long-term agent memory, or vice versa (test runs that shouldn't leave cookies but whose reasoning trace should still be logged for debugging).
**How to implement:** Expose two independent flags on session/task creation in the CLI: one that spins up a throwaway browser profile/context (no cookie/history persistence), one that skips writing the task's transcript/memory to durable storage. Make sure downstream sync/logging/analytics code explicitly excludes incognito-flagged sessions rather than relying on the flag being noticed ad hoc.
**Evidence:** `60_native_security.md` (session persistence context via §3.2); `100_agent_errors_modes.md` — flags referenced at daemon offset ~14,529,581, `incognito`/`ephemeral` both `.default(false)`.
**Tier:** nice.

### 20. Per-origin notification-grant model with independent revocation (NICE)
**What:** Enabling agent-visible push notifications from a site requires two mandatory, separately-tracked steps: browser-level permission grant ("Allow for AI") **and** the site's own notification opt-in toggle — recorded per-origin in a durable grant store (`listNotificationGrants`/`getNotificationGrant`/`revokeNotificationGrant`), independently revocable, and checked for revocation on every inbound event before it's allowed to wake a session.
**Why:** A push-notification-driven wake mechanism is itself an attack surface (arbitrary external events resuming an agent session) — per-origin, independently revocable grants with an explicit revocation check on every inbound event is the right shape to keep that surface bounded and auditable.
**How to implement:** If the CLI supports any "wake agent on external event" mechanism (webhook, push, polling), gate it behind a per-source/per-origin grant record stored durably, checked and honored (`revokedAt`) on every inbound event before it's allowed to resume/spawn a session, and exposed to the user as independently revocable.
**Evidence:** `89_guardrails_captcha.md` §4.1, §4.3, §4.4 (verbatim tRPC surface + revocation check code).
**Tier:** nice — relevant only once the CLI has a long-horizon/event-driven wake feature.

---

## Command Surface (verbatim / near-verbatim)

Retry config (Zod, verbatim constants):
```js
Zu = R({ enabled: dl().default(!0), maxRetries: L().default(3), baseDelayMs: L().default(2e3), maxDelayMs: L().default(6e4) })
```

Compaction config (Zod, verbatim constants):
```js
Xu = R({ enabled: dl().default(!0), reserveTokens: L().default(16384), keepRecentTokens: L().default(2e4) })
```
Proactive-compaction trigger: `usedTokens > contextWindow - reserveTokens(16384)`.

fs-jail guard (verbatim shape):
```js
resolved = path.resolve(cwd, p)
if (!resolved.startsWith(agentRoot + sep) && resolved !== agentRoot) throw Error("Path escapes agent root: " + p)
```

Daemon sandbox policy shape (verbatim JSON):
```json
"files": {
  "readableRoots": [".../agents/main", ".../Downloads", ".../Documents", ".../sessions/<id>", ".../.aside/runtime"],
  "writableRoots": [".../Downloads", ".../Documents", ".../sessions/<id>", ".../.aside/runtime"],
  "outsideRead": "ask",
  "outsideWrite": "ask"
}
```

Subagent tool-gate sets (verbatim):
```js
k4t = new Set(['ask_user_question','request_action_confirmation','subagent','fork_subagent']);
A4t = new Set(['write_file','edit_file','repl']);
j4t = /(^|[;&|]\s*)(mkdir|touch|rm|cp|mv|chmod|chown|install|tee|npm|yarn|pnpm\s+(add|install|remove)|bun\s+(add|install|remove)|git\s+(add|commit|checkout|reset|clean|push|pull|merge|rebase|mv|rm|apply)|sed\s+-i)\b|<<|(^|[^<])>>?/
```

Retry classifier deny/allow lists (verbatim):
```
DENY: RateLimitError | Monthly usage limit reached | available balance | insufficient_quota | out of budget | quota exceeded | billing
ALLOW: overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|
       provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|
       other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed?\s*out|timeout|
       terminated|websocket.?closed|websocket.?error
```

Amount-extraction regexes (verbatim):
```
amount_pattern: (?:US\$|USD|\$)\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?(?:\s*)(?:USD|US\$|\$)?|(?:USD|US\$|\$)?\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*(?:USD|US\$|\$)
keyword_pattern: ^(?:\s*)(Due now \(USD\)|(Estimated )?(?:Order Total|Total:?)|TOTAL CHARGED TODAY \*|Final Total Price:|Flight total|grand total:?|Order Total(?: \(USD\))?:?|Price|Total(?:(?: \(USD\))?| Due| for Stay| Price| to be paid:| to pay|:)?|(Your )?(?:Payment Today|total(\s)price|Total:)|Show Order Summary:|Reservation Deposit Amount Due|Payment Due Now|Your Price|Total Due Now|Amount to pay|Total amount due|You pay today|Order Summary|TOTAL PAYMENT DUE|Payable Amount)(?:\s*)$
```

Captcha-detection globs (verbatim):
```
*google.com/recaptcha/api2/anchor  *google.com/recaptcha/api2/bframe
*google.com/recaptcha/enterprise/anchor  *google.com/recaptcha/enterprise/bframe
*recaptcha.net/recaptcha/api2/anchor  *recaptcha.net/recaptcha/api2/bframe
*recaptcha.net/recaptcha/enterprise/anchor  *recaptcha.net/recaptcha/enterprise/bframe
*hcaptcha.com/captcha/*  *challenges.cloudflare.com/*
```

`agentAccessPolicy` enum: `always | while-unlocked | never`

Actionability actor-safety reject reasons (verbatim): `"Tab is an error document" | "Blocked by safebrowsing" | "Reject" | "Wrong scheme" | "IP address" | "Safebrowsing unavailable" | "Internal: Non-dogfood client" | "No Google groups" | "Allowlist is empty" | "URL not in allowlist" | "Enterprise policy block" | "Lookalike domain" | "Allow"`

RefStaleError message shape: `Ref "eN" is stale — the element was removed or the page changed. Take a new snapshot and retry.`

`[system]` dialog-steer templates (verbatim):
```
prompt:  `[system] `${a}` showed a prompt dialog: "${msg}" (default: "${def}") … auto-accepted with default value.`
confirm: `[system] `${a}` showed a confirm dialog: "${msg}" … auto-accepted (OK).`
alert:   `[system] `${a}` showed an alert: "${msg}". auto-accepted.`
```

Recovery prompt block (verbatim):
```
## Recovery
- Dismiss blocking popups, modals, and cookie banners first.
- If an action fails, take a fresh snapshot before retrying.
- If the same path fails 2-3 times, switch strategy.
- If a click fails as "obscured", inspect the real hit target before retrying.
- If you encounter a CAPTCHA, solve it before retrying.
```

Completion/verification prompt block (verbatim):
```
# Completion and Verification
- Treat the task as incomplete until every requested deliverable is done or explicitly marked `[blocked]` with what is missing.
- If a lookup returns empty, partial, or suspiciously narrow results, retry with a different strategy before concluding no result exists.
- Earlier snapshots are supporting evidence only. Never present them as current page state unless re-verified.
- Before reporting completion, verify that:
  - You actually accomplished the request, not just attempted it.
  - Extracted data came from inspected evidence, not memory or assumption.
  - Requested criteria such as count, format, filters, and source boundaries were met.
  - The final response matches the requested format.
  - Any external side effect was confirmed when confirmation was required.
```

---

## Anti-patterns (what NOT to copy)

1. **Native-actor allowlist as the primary security boundary.** Aside's own teardown proves it: the `MayActOnUrl` allowlist gate is tied to one specific tool-invocation path (the native Actor mojo surface) and is silently bypassed by driving the browser a different way (CDP). Any gate that lives inside a specific tool wrapper rather than the lowest-level primitive (actual navigation/network call) is not a real boundary — it's a speed bump for the one code path that calls it.

2. **`maxDelayMs` as a declared-but-vestigial constant.** The retry config declares `maxDelayMs:60000` but the actual backoff (`2000·2^(n-1)`, capped at 3 retries) never reaches 60s within budget — so the cap is dead code that looks load-bearing in the schema but isn't. Don't ship config fields that imply a behavior the runtime never actually exercises; either wire the cap in or remove the field.

3. **Relying on default `agentAccessPolicy` at import time without user awareness.** The teardown explicitly flags this as the actual risk: a permissive default (`always`/`while-unlocked`) combined with prompt-injectable page content (the agent reads arbitrary DOM) is "the classic exfiltration path." Don't ship a granular per-credential policy system and then undermine it with a permissive default nobody reviews.

4. **No visible `<untrusted_repl_output>`-style fencing or explicit "page content is data not instructions" prompt clause in these three parts.** This is a **gap** in Aside's own materials as captured here, not a pattern to copy — the corpus shows guardrails for *actions* (confirm, denylist, credential policy) but nothing here shows explicit prompt-injection framing/fencing for *page content itself*. Don't assume "we have guardrails" covers prompt injection just because other guardrails exist — they are a different threat model (agent doing something bad on its own initiative vs. agent being manipulated by adversarial page content) and need their own explicit defense (this corpus doesn't demonstrate one).

5. **Auto-accepting native dialogs is a deliberate tradeoff, not a free lunch.** It avoids deadlock but means the agent can unwittingly click through an "Are you sure you want to delete this?" `confirm()` on a page that isn't gated by `final_confirm` (since native JS dialogs are a different code path from the agent's own action-confirmation tool calls). Copy the "don't deadlock" behavior, but make sure any known-destructive dialog patterns are still routed through the higher-level confirm gate rather than silently OK'd.

6. **Cheap token estimate (`ceil(chars/4)`) drives a security-adjacent threshold (proactive compaction).** It's explicitly a heuristic, not a real tokenizer — fine for compaction timing, but don't reuse this style of approximation anywhere a hard security/cost boundary depends on precise counting (e.g., don't estimate a rate-limit or spend-cap this way).

7. **No client-side/agent-side re-implementation of the navigation denylist.** The teardown notes `navigation_blocked` strings appear only in the browser framework, never the daemon — "the daemon never re-implements the list, confirming enforcement is native/browser-side." This is *correct* architecture (single source of truth, enforced below the agent's control) — the anti-pattern to avoid is the *inverse*: don't let the agent-side code carry its own copy of a security list that the lower layer is supposed to own, since copies drift and the agent-side copy is exactly what a compromised agent loop could ignore.

---

## Evidence / gaps note

- No verbatim "lethal trifecta" phrase found in Aside's own strings/prompts — it's the teardown author's analytical framing (§7.4 of Part 60), applied to Aside's observed capabilities (reads page content + can use credentials + operates where money is spent). Treat the *framing* as reusable analysis methodology, not a quoted Aside artifact.
- No `system_message authoritative only from user` / `<untrusted_repl_output>` fencing / explicit "stop-on-suspected-injection" mechanism was found in these three parts. If the orchestrator wants that pattern grounded, it needs a different source — do not assume Aside has it just because other guardrails are present.
- "Guard mode" as a named concept was not found verbatim in these parts; the closest analogues are `final_confirm` / `permissionMode` (per-routine permission mode column in daemon SQLite, referenced but not fully detailed in the three read parts) and the read-only-subagent restriction set (`M4t`).
