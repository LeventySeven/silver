# Source: Aside — Models, Streaming, Routing, Custom-Agent/Skill Authoring

**Mined from:**
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/102_model_streaming_routing.md` (daemon-side: 4-slot router `NKt`, per-provider SSE/stream parsers, thinking-level clamp, cache breakpoints, retry/abort)
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/103_custom_agents_onboarding.md` (multi-agent runtime, skill authoring `create_custom_skill` + settings-UI router, onboarding state machine)
- `/Users/seventyleven/Desktop/researchfms/teardowns/_aside_parts/50_models_gateway.md` (extension-side: 981-entry model registry, provider catalog, direct-to-vendor dispatch, thinkingLevel→param mapping, fastMode/Ultrabrowse)

**Framing note.** Aside is a *product* — a Chrome-extension + local daemon that itself holds API keys, manages billing, runs a background daemon process, and serves multiple concurrent human users. The target we're building (agent-browser) is a **keyless CLI/skill where the HOST model is the brain** — no daemon, no billing, no provider abstraction (the host already has one model, already streaming, already thinking). Most of Aside's model-routing and streaming-protocol machinery is therefore **product infrastructure to explicitly NOT rebuild**. What DOES transfer: (a) the *pattern* of delegating sub-tasks to a different "capability tier" (even if in our world that's just "ask the host to use a subagent or a cheaper turn" rather than literally switching model weights), (b) the skill-authoring/frontmatter/dedup conventions, which are directly reusable for how agent-browser structures its own SKILL.md and any auto-generated site-specific playbooks, and (c) a few defensive engineering patterns (error-as-data-frame, retry/abort discipline, clamp-to-nearest) that generalize to any tool-calling loop regardless of who owns the model.

---

## Killer Insight

**Aside never lets a raw provider error reach the agent loop — every failure is normalized into an in-band `{type:"error"}` frame carrying a fully-formed, zero-usage assistant message** (`Gke`, 102 §0), and **every stream, regardless of vendor, is decoded into one identical internal event vocabulary** (`start / text_*/thinking_*/toolcall_* / done / error`, each carrying the *entire in-flight message* as `partial`, not just a delta) (102 §2). This is the one idea worth stealing wholesale even in a keyless single-model CLI: **treat every tool call and every sub-task result as a normalized "frame" the agent loop can render/inspect uniformly, and never let an exception propagate raw into the ReAct loop** — always convert failures (dead page, timeout, captcha, detached DOM node, network error) into a structured, inspectable result object with the same shape as a success, so the calling logic doesn't need a parallel error-handling path. The corollary insight for skill design: Aside's skill system treats **"where a file lives" as its own type system** — `creator` (builtin vs user) is inferred purely from *path location* (`/builtin/` vs manifest membership), never a stored flag (103 §2.2) — a directory-convention-as-schema trick that keeps skill precedence resolvable by `ls`, no DB required. That maps directly onto how agent-browser should structure any learned/generated site-specific playbooks on disk.

---

## Patterns

### 1. Uniform internal event vocabulary across every "stream" (CORE — but reframed)
**What:** Every provider adapter, regardless of wire format, normalizes into: `start → {text|thinking|toolcall}_{start,delta,end} → done|error`, where every single frame carries the *whole* live assistant message (`partial`), not a bare delta (102 §2).
**Why:** A UI (or a supervising agent) can render/inspect the in-flight state off *any* frame without accumulating deltas itself — it's stateless from the consumer's side.
**How to implement (for agent-browser):** agent-browser has no multi-vendor streaming to normalize (the host model already streams natively). But apply the *shape*, not the wire protocol: every tool invocation (click, navigate, extract, screenshot) should return a self-contained result object that includes enough state to be independently useful — not just `{ok:true}` but `{ok, action, target, resultingUrl, snapshot?, error?}` — so a supervising/reviewing pass never needs to replay history to understand what happened.
**Evidence:** `102_model_streaming_routing.md` §2, lines 217-261 (event vocabulary + shared `i` object).
**Tier:** CORE (as a design principle for tool-result shape, not as literal streaming code).

### 2. Errors become data, never exceptions, at the tool/model boundary (CORE)
**What:** `Gke(model, err)` converts any thrown provider error into a well-formed assistant message with `stopReason:"error"`, zeroed usage, and `errorMessage` — pushed into the same event stream as a success would be (102 §0).
**Why:** The agent loop (`aX`) has exactly one code path for "turn ended" — it doesn't need try/catch around the model call; it inspects `stopReason` on the returned frame. Retry logic (`#re`, §5.2) hooks purely off that field.
**How to implement:** In agent-browser, every browser action (click/type/nav/screenshot) that can fail (element not found, timeout, navigation blocked, captcha, detached frame) should return a structured failure object rather than throwing past the tool boundary — `{ok:false, reason:"element_not_found", selector, attempted_at}` — so the agent's next decision is "read the reason field," not "catch and interpret a stack trace." This is the single most reusable idea from this source for a CLI harness.
**Evidence:** 102 §0 lines 67-78 (`Gke` verbatim), §5.2 lines 609-625 (retry loop keys off `stopReason==="error"`).
**Tier:** CORE.

### 3. Clean, non-throwing abort as a first-class terminal state (IMPORTANT)
**What:** Abort is not treated as a failure. `AbortController.signal` threads through every call; on abort the adapter emits `{type:"error", reason:"aborted"}` but the retry loop explicitly treats this as `Retry cancelled` — a clean stop, not a failure to recover from — and skips compaction (102 §5.3).
**Why:** Distinguishing "user/system cancelled this" from "this broke" prevents wasted retries and lets downstream logic (e.g. "should I compact context now?") make the right call.
**How to implement:** In agent-browser, a user-interrupted or timeout-killed browser action should set a distinct `reason:"aborted"` on its result, distinct from `reason:"error"` — the harness's retry/backoff logic should treat abort as terminal, not retryable.
**Evidence:** 102 §5.3, lines 627-634.
**Tier:** IMPORTANT.

### 4. Retry lives in the agent loop, not the transport SDK (IMPORTANT)
**What:** Every provider adapter passes `maxRetries:0` to the vendor's own SDK — vendor-level retry is explicitly disabled. All retry happens in the daemon's own agent-loop error handler (`#re`, `maxRetries:3`, linear backoff), which decides retryability by inspecting the errored *message*, not the exception (102 §5.2).
**Why:** Centralizing retry policy at one layer (the loop) rather than scattering it across N provider SDKs means one place to tune backoff/circuit-breaking and one place that understands "is this worth retrying" semantically (e.g. a 429 vs a captcha vs a malformed tool call).
**How to implement:** agent-browser's shell-level retry (e.g. "page didn't load, retry navigation once") should live in the skill/harness logic that drives Playwright/CDP, not be delegated ad hoc inside individual command wrappers — one retry policy, one place, driven by inspecting the structured failure object from Pattern #2.
**Evidence:** 102 §5.2, lines 609-625.
**Tier:** IMPORTANT.

### 5. Tolerant/partial JSON parsing for streaming tool-call arguments (NICE-TO-HAVE, situational)
**What:** Tool-call arguments arrive as a raw JSON fragment stream; every adapter re-parses the accumulated buffer with a *tolerant* partial-JSON parser (`C_`, bundled `partial-json` lib with an `Allow` bitmask `STR|NUM|ARR|OBJ|NULL|BOOL|NAN|INF`) on **every delta**, so a consumer sees a progressively-more-complete object, never a hard parse error mid-stream (102 §2, lines 249-252).
**Why:** Lets a UI show "arguments so far" live without waiting for the full JSON to close.
**How to implement:** Irrelevant if the host model already delivers complete tool_use blocks (Anthropic tool-use is already atomic per block in the Claude API/Agent SDK). Only relevant if agent-browser ever streams its OWN nested sub-agent tool calls to a live display and wants partial rendering. Low priority — skip unless building a live TUI.
**Evidence:** 102 §2, `_Ae`/`C_` offset 96,124,800.
**Tier:** NICE (situational; skip for a keyless CLI skill with no live-render requirement).

### 6. Clamp-to-nearest-available for any capability ladder (NICE — generalize the *pattern*, not the levels)
**What:** `thinkingLevel` clamp: given a requested level on a 6-rung ladder `[off,minimal,low,medium,high,xhigh]` and a model's advertised subset, if the exact level isn't supported, walk **up** first, then **down**, landing on `available[0]` as the ultimate fallback (102 §3.1, `v_`/`sAe`).
**Why:** Silent degrade-gracefully instead of hard error when a requested capability doesn't exist on the current resource.
**How to implement:** Not directly applicable (agent-browser has one model, no capability ladder to clamp). The transferable shape: any agent-browser config knob that names a *tier* (e.g. `--wait-strategy=aggressive|normal|patient`) should clamp to the nearest supported value rather than erroring, if the CLI ever grows environment-dependent tiers (headless vs headed, sandboxed vs full).
**Evidence:** 102 §1.2 (`Ame`) and §3.1 (`v_`, `sAe`), 50 §1.1.
**Tier:** NICE.

### 7. The 4-slot category router: fast/standard/deep/visual (ANTI-PATTERN for us — but the *concept* of task-tiering is worth keeping in reduced form)
**What:** Aside routes different *kinds of internal work* to different model tiers via an explicit slot enum `Hu = [fast, standard, deep, visual]`, each with an ordered provider/model fallback list (`Uu`), resolved by `resolveByCategory(slot)` → master resolver `NKt` (102 §1, 50 §1.3). `deep` = the main session agent; `standard` = compaction/title generation; `visual` = captcha OCR / screenshot interpretation; `fast` = cheap one-shot selection Q&A. If the session's chosen model is itself a member of a slot's candidate table, that slot resolves to the session model at its clamped thinking level; otherwise it falls to a cheaper table default (102 §1.1, the `NKt` branch logic, lines 100-121).
**Why (for Aside):** Cost control across N concurrent users on N different subscription tiers, with dozens of provider integrations to route across.
**Why this is infra we should NOT rebuild:** agent-browser is keyless — the HOST model is the ONLY model. There is no "swap the compaction pass to a cheaper vendor" decision to make; the host harness (Claude Code, etc.) already owns model selection, context compaction, and any sub-agent dispatch policy. Rebuilding a 4-slot router inside a skill would be duplicating a decision the *harness*, not the *skill*, is responsible for.
**What DOES transfer:** the underlying *task taxonomy* — "cheap bounded side-work" (fast) vs "durable background work / compaction" (standard) vs "hard reasoning / planning / judging" (deep) vs "image/screenshot/CAPTCHA interpretation" (visual) — is a genuinely useful mental model for **when agent-browser's skill instructions should suggest the host spawn a subagent** (e.g. "for CAPTCHA-solving or dense visual-layout reasoning, consider a vision-capable subagent call; for routine click-sequences, don't"). Keep the *taxonomy as prose guidance in the skill*, discard the *router as code*.
**Evidence:** 102 §1 (full `NKt` verbatim), 102 §1.3 table (slot→purpose→defaults), 50 §1.3 (fallback lists verbatim).
**Tier:** ANTI-PATTERN (as infrastructure) / NICE (as a prose taxonomy for subagent-dispatch guidance in the skill doc).

### 8. Direct-to-vendor dispatch, no inference proxy for BYO keys (ANTI-PATTERN for us — confirms our own architecture is right)
**What:** For every provider except Aside's own managed plan, the extension calls the vendor's API directly from the browser with `dangerouslyAllowBrowser:true`; `api.aside.com`/`api.asidehq.com` is purely a control-plane (accounts/settings/credentials), never an inference proxy (50 §0, §5).
**Why relevant:** Confirms that "hold your own keys, talk directly to the vendor, no middleman gateway" is a legitimate, battle-tested architecture — validates that agent-browser (keyless, using the HOST's already-authenticated model) needs **zero** provider-gateway code at all. We are even simpler than Aside's BYO path: we never hold or route any API key ourselves.
**Evidence:** 50 §0 lines 17-32, §5 lines 413-437.
**Tier:** ANTI-PATTERN to rebuild (nothing to build — confirms omission is correct).

### 9. Subscription-provider spoofing (impersonating vendor first-party clients) (ANTI-PATTERN, explicitly avoid)
**What:** To reuse a user's Claude Pro/Max or ChatGPT Plus subscription instead of API billing, Aside's OAuth-connected paths send the vendor's own first-party client fingerprint: `anthropic-beta: claude-code-20250219,oauth-2025-04-20`, `user-agent: claude-cli/<ver>`, `x-app: cli`, and the literal system-prompt preamble `"You are Claude Code, Anthropic's official CLI for Claude."` prepended as `system[0]` — required for the OAuth path to be accepted at all (50 §6.1, §9; 102 §4.2 item 1). Similarly `openai-codex` hits `chatgpt.com/backend-api/codex/responses` with `originator:"pi"`, `User-Agent:"pi (browser)"`, spoofing ChatGPT's internal client.
**Why this is an anti-pattern for us:** This is a ToS-risk, ban-vector pattern used purely for cost arbitrage (get subscription-tier usage instead of paying API rates) — it's orthogonal to (and actively hostile toward) a "keyless, host-model-is-the-brain" design where there is no separate API relationship to arbitrage in the first place. agent-browser has no reason to impersonate any client.
**Evidence:** 50 §6.1 lines 443-464, §9 line 592-595; 102 §4.2.
**Tier:** ANTI-PATTERN — explicitly do not copy.

### 10. Cost/usage metering with per-lane pricing (ANTI-PATTERN — not our problem)
**What:** `__(model, usage)` computes USD cost per turn from four lanes (input/output/cacheRead/cacheWrite) at per-1M-token rates, with the 1-hour cache-write lane billed at 2× the input rate (102 §2, lines 253-265); OpenAI Responses additionally multiplies by a service-tier factor (flex=0.5×, priority=2× or 2.5× for gpt-5.5) (102 §2.6).
**Why irrelevant to us:** agent-browser never sees token usage or billing — that's entirely the host harness's concern. No cost-metering code belongs in the skill.
**Evidence:** 102 §2 lines 253-265, §2.6 lines 401-411.
**Tier:** ANTI-PATTERN to rebuild.

### 11. Prompt-cache breakpoint placement discipline (NICE-TO-HAVE, only if agent-browser ever emits raw Anthropic API calls itself)
**What:** Anthropic allows ≤4 `cache_control` breakpoints; Aside places them at up to 4 specific spots: `system[0]` (OAuth preamble, if present), the real system prompt, the **last** tool in the tools array only (caching the whole tool block as one prefix), and the last content block of the last user message (102 §4.2).
**Why:** Maximizes cache-hit surface within the hard 4-breakpoint budget by putting boundaries at the *stablest* prefix points (system+tools rarely change; message tail changes every turn but everything before it is now cached).
**How to implement:** Not applicable if agent-browser is a skill running inside an existing host session (the host's own harness manages its own prompt caching). Only relevant if agent-browser ever makes raw API calls on its own behalf (e.g., a standalone daemon mode) — then this placement recipe (system-tail, tools-tail, message-tail) is a good default to copy verbatim.
**Evidence:** 102 §4.1-4.2, lines 528-560.
**Tier:** NICE (conditional on architecture never becoming true — flag as "if we ever go multi-turn-standalone").

### 12. Two doors into one skill directory: in-conversation authoring tool + settings-UI router, converging on identical output (CORE for skill design)
**What:** Aside has two paths that both write `agents/<id>/skills/user/<slug>/SKILL.md`: (a) an in-conversation tool `create_custom_skill` that the agent itself calls, fuzzy-dedups against existing skills (≥70 similarity threshold) to decide update-in-place vs builtin-override vs new-create, and **pauses for explicit user confirmation** before writing (103 §2.1); (b) a settings-UI CRUD router (`agents.createSkill/updateSkill/importSkill`) that does hard `CONFLICT` checks instead of fuzzy dedup + confirmation, because the UI interaction *is* the confirmation (103 §2.2).
**Why:** Same artifact, same directory convention, same frontmatter validator, two different trust/authoring contexts — conversational (needs confirmation gate, since the agent is unsupervised) vs UI-driven (user is already in the loop).
**How to implement:** If agent-browser ever lets the host model "save a learned site-specific playbook as a reusable skill," borrow this exact shape: (1) slugify the name (`trim→lowercase→NFKC→[^\p{L}\p{N}]+→"-"`, reject empty/reserved names like `node_modules`) (103 §2.2, `s7`/`lsn`); (2) fuzzy-match against existing skill names/descriptions before creating a duplicate; (3) if a similar skill exists, update in place rather than proliferating near-duplicates; (4) require an explicit confirmation step before the write actually lands, since this is the agent editing its own future instructions unsupervised — treat it like a `git commit` that needs a review diff, not a silent side-effect.
**Evidence:** 103 §2.1 (tool description + params verbatim, lines 216-239), §2.2 (`createSkill` router logic verbatim, lines 241-269).
**Tier:** CORE (for any "learn and remember" skill-authoring capability agent-browser adds).

### 13. Skill frontmatter schema: description-as-discovery-metadata, optional auto-injection keywords/urlPatterns (CORE)
**What:** A skill's `description` field is explicitly the *primary metadata used for discovery* (not just documentation) — the system prompt tells the authoring agent: *"description: clear about when the skill should be used"* (103 §2.1). Optional `keywords` (stable phrases that should auto-trigger consideration) and `urlPatterns` (scheme-less site patterns like `app.example.com` or `*.example.com/path/**`) are auto-injection signals, explicitly optional — *"omit them when manual use is enough"* (103 §2.1).
**Why:** Keeps the skill index cheap to scan (description alone should be enough to decide relevance) while allowing an escape hatch for skills that should fire automatically on specific sites/keywords without the model needing to reason about it every time.
**How to implement:** agent-browser's own SKILL.md (and any site-specific sub-skills it generates) should follow this exact split: a terse, trigger-focused `description` (this is literally what routes skill selection in Claude Code's own harness already), optional `urlPatterns` for site-specific browser playbooks so a "gmail.com login flow" skill can auto-trigger on `mail.google.com/**` without the model having to remember it exists.
**Evidence:** 103 §2.1, `Srn` parameter descriptions verbatim, lines 231-237.
**Tier:** CORE.

### 14. Creator identity by path location, not stored flag (CORE, cheap trick worth stealing)
**What:** Whether a skill is `builtin` or `user`-authored is determined purely by *where it lives on disk* — any path under `/builtin/` or listed in a `.bootstrap-manifest.json` content-addressed manifest is `builtin`; everything else is `user` (103 §2.2, `esn`). Precedence when names collide: `user`(3) > `builtin`(2) (`nsn`).
<br>**Why:** No database, no metadata flag to get out of sync — the filesystem IS the source of truth, and precedence is a pure function of directory structure.
**How to implement:** If agent-browser ships built-in playbooks (e.g. `skills/builtin/gmail-login/SKILL.md`) alongside user/agent-learned ones (`skills/user/<slug>/SKILL.md`), use the exact same convention: a skill in `user/` silently overrides a same-named skill in `builtin/`, determined by directory, not a flag in the file itself.
**Evidence:** 103 §2.2, lines 273-277.
**Tier:** CORE.

### 15. Skill sync is content-addressed and idempotent (IMPORTANT)
**What:** Builtin skills are synced against a `.bootstrap-manifest.json` (`zM`) on every boot; the daemon logs `[Skills] Synced +412 ~0 -0` on first run, `+2 ~5 -0` on subsequent incremental runs — added/updated/deleted counts from a content-address diff, self-healing (103 §3.5).
**Why:** Lets the built-in skill library ship updates without clobbering user customizations, and makes "did the skill set change" an observable, loggable event.
**How to implement:** If agent-browser ships and updates a bundle of built-in browser playbooks, a simple content-hash manifest diff (added/changed/removed counts) on install/update is a cheap, debuggable sync mechanism — much simpler than a real package manager, and directly loggable for troubleshooting ("why did my custom login flow disappear" → check the sync log).
**Evidence:** 103 §3.5, lines 408, `[Skills] Synced` log lines in §3.1.
**Tier:** IMPORTANT (only if agent-browser ships/updates a builtin playbook library — skip for a single-file skill).

### 16. Per-agent directory isolation as the unit of persona/memory/skill scoping (IMPORTANT, generalizable to per-site or per-session scoping)
**What:** Every agent gets a fully isolated directory (`agents/<id>/{skills,memory/{,episodic,routines},AGENTS.md,SOUL.md,memory/MEMORY.md,memory/USER.md,memory/TAXONOMY.md}`), scaffolded idempotently by `RM(agentId, accountId)` on creation, with sessions nested under their owning agent's directory (`agents/<id>/sessions/<date>_<sessionId>/`) (103 §1.4).
**Why:** Filesystem-level isolation means "does agent B see agent A's learned skills/memory" is answered by directory boundaries, not application logic that could leak.
**How to implement:** Loosely applicable if agent-browser ever supports per-site or per-project learned-skill scoping — e.g. skills learned while automating `site-a.com` shouldn't silently apply to `site-b.com` unless explicitly generalized. A directory-per-scope convention (`skills/sites/<domain>/` vs `skills/global/`) mirrors this cleanly. Low priority unless multi-tenancy/multi-project is a real requirement.
**Evidence:** 103 §1.4, lines 122-165 (`hs`, `gs`, `RM`, `Oat` scaffold verbatim).
**Tier:** IMPORTANT (conditional on scope — nice pattern to have in back pocket for multi-project agent-browser installs).

### 17. Onboarding/auth crypto (AUK derivation, recovery-key sealing) (ANTI-PATTERN — entirely out of scope)
**What:** Fresh-install flow: installation key → DB migration → email-code signup → `setupLocalBootstrap` derives an Account Unlock Key via **argon2id (64 MiB memory, 3 iterations, parallelism 4)** from the user's password, seals it under a UI-generated 12-word/128-bit recovery mnemonic via ChaCha20-Poly1305 keyed by HKDF-SHA256, then derives a password-manager key (PMK) and Chrome-sync key (CSK) via further HKDF (103 §3.1-3.4).
**Why irrelevant:** agent-browser is keyless and stateless with respect to user accounts — there is no account, no password, no vault, no cross-device sync to secure. This entire subsystem (and its ~150 lines of crypto detail) has zero applicability.
**Evidence:** 103 §3, full section.
**Tier:** ANTI-PATTERN — do not rebuild, do not reference.

### 18. Session-scoped LRU + idle-TTL + replay buffer for a running agent runtime (NICE-TO-HAVE, only for a long-lived daemon)
**What:** The session runtime `Gon` is keyed by `accountId:sessionId`, capped at a 20-entry LRU, 10-minute idle TTL, 15s keep-alive, with a 512-event replay buffer for reconnecting clients (102 §5.1, lines 589-601 context + 103 §1.6 line 201).
**Why:** Lets a UI reconnect mid-session and replay recent events without re-running anything.
**How to implement:** Only relevant if agent-browser grows a persistent daemon mode with multiple concurrent browser sessions that a client can attach/detach from. For a single-shot CLI invocation (the current target shape), this is pure overkill — skip.
**Evidence:** 102 §5.1, 103 §1.6.
**Tier:** NICE (explicitly flagged as likely-never-needed for the current target shape).

---

## Command Surface (verbatim, for reference — mostly NOT to be copied, cited for completeness)

These are Aside's actual tRPC/API shapes. None of these are commands agent-browser should expose (no accounts, no daemon, no multi-agent CRUD) — reproduced only so the "what NOT to build" boundary is concrete and traceable.

```
# Custom-agent CRUD (103 §1.1) — NOT applicable, no multi-agent product surface in agent-browser
agents.list
agents.get({agentId})
agents.create({id, name, icon?, description?, settings?})
agents.update({agentId, name?, icon?, description?, settings?})
agents.archive({agentId})
agents.delete({agentId})   // hard-rejects agentId==='main'
agents.readFile({agentId, fileName: AGENTS.md|SOUL.md|memory/MEMORY.md|memory/USER.md|memory/TAXONOMY.md})
agents.writeFile({agentId, fileName, content})

# Skill authoring — settings-UI router (103 §2.2) — the SHAPE is worth copying for a "save skill" CLI subcommand
agents.getSkillsDirectory({agentId})
agents.listSkills({agentId})
agents.listSkillsForSettings({agentId})
agents.createSkill({agentId, name, description, body, enabled?, keywords?, urlPatterns?})
   → {path: "user/<slug>", definitionPath: "user/<slug>/SKILL.md", name, overridesBuiltin, overriddenSkillPath}
agents.updateSkill({agentId, skillPath, ...})
skills.importSkill({sourcePath})   // cp's a whole folder in, requires SKILL.md w/ valid frontmatter

# In-conversation skill tool (103 §2.1) — the PROMPT/PARAM SHAPE is directly reusable
create_custom_skill({name, description, body, enabled?, keywords?, urlPatterns?})
  # pauses for user confirmation (action-confirmation type "skill-draft") before writing

# Model category resolution (102 §1, 50 §1.3) — the SLOT NAMES are useful vocabulary, the resolver is not
resolveByCategory(slot: "fast"|"standard"|"deep"|"visual") → {provider, modelId, thinkingLevel, fastMode}

# thinkingLevel ladder (50 §1.1, 102 §3.1) — vocabulary only, no model to apply it to in our target
thinkingLevel ∈ ["off","minimal","low","medium","high","xhigh"]
```

**Skill slug algorithm (worth copying verbatim, 103 §2.2 `s7`/`lsn`):**
```
slug(name) = name.trim().toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '-')
# reject: empty string, reserved names (e.g. "node_modules"), leading "."
```

---

## Anti-patterns (explicit — do NOT copy into agent-browser)

1. **Building a 4-slot model router.** agent-browser has exactly one model — the host. There is nothing to route between. (Pattern #7.)
2. **Building any inference gateway/proxy code.** We never hold or route API keys; the host already talks to its provider. (Pattern #8.)
3. **Vendor-client impersonation (`user-agent: claude-cli/...`, spoofed system-prompt preambles) to arbitrage subscription pricing.** ToS-risk, irrelevant to a keyless design, actively the wrong instinct to copy. (Pattern #9.)
4. **Cost/usage metering, per-lane token pricing, service-tier multipliers.** Not our concern — the host harness owns billing. (Pattern #10.)
5. **Full onboarding/auth/crypto stack (argon2id AUK, recovery mnemonics, vault sync).** Zero applicability to a stateless CLI skill. (Pattern #17.)
6. **A hand-rolled SSE/WebSocket parser mimicking N different vendor stream formats.** We consume zero vendor streams directly — the host model's own tool-calling loop already handles this. (102 §2.1-2.5 in full — none of it transfers.)
7. **Session LRU/replay-buffer/keep-alive daemon machinery** unless/until agent-browser actually grows a persistent multi-session daemon mode — premature to build for a single-shot CLI invocation. (Pattern #18.)

---

## Evidence Index (for follow-up verification)

| # | Claim | File | Section/lines |
|---|---|---|---|
| 1 | No Vercel AI SDK; custom `a_`/`s_`/`c_` stream runtime; universal error-frame factory `Gke` | 102 | §0, lines 18-78 |
| 2 | 4-slot router `NKt` full resolution logic, slot purposes | 102 | §1, lines 82-214 |
| 3 | Uniform internal event vocabulary across 4 providers | 102 | §2, lines 217-261 |
| 4 | Per-provider SSE/Responses/Chat/Gemini stream mapping detail | 102 | §2.1-2.5, lines 267-399 |
| 5 | thinkingLevel clamp algorithm (`v_`/`sAe`), per-provider param translation | 102 | §3, lines 415-519 |
| 6 | ≤4 cache_control breakpoint placement | 102 | §4, lines 523-583 |
| 7 | Retry (agent-loop, not SDK) + abort semantics | 102 | §5, lines 587-634 |
| 8 | Multi-agent tRPC router `agents.*`, `oL` registry, `U7` scoping | 103 | §1.1-1.3, lines 12-121 |
| 9 | Per-agent directory scaffold (`RM`, `Oat`, `hs`/`gs` paths) | 103 | §1.4, lines 122-165 |
| 10 | Per-agent settings schema `IF` (permission/channels/defaultModel) | 103 | §1.5, lines 167-187 |
| 11 | `create_custom_skill` tool: verbatim prompt, params, confirmation flow | 103 | §2.1, lines 216-239 |
| 12 | Settings-UI skill router `fsn`: createSkill/updateSkill/import | 103 | §2.2, lines 241-277 |
| 13 | Onboarding state machine, AUK/recovery-key crypto | 103 | §3, lines 281-419 |
| 14 | Model registry (981 entries), provider catalog (23 providers), fallback tables | 50 | §1-3, lines 49-380 |
| 15 | Direct-to-vendor dispatch verdict (no inference proxy for BYO) | 50 | §0, §5, lines 15-46, 413-437 |
| 16 | Subscription-provider spoofing (claude-cli, pi originator) headers | 50 | §6.1, §6.4, §9, lines 443-604 |
| 17 | fastMode / Ultrabrowse — UI-label-only, not a request param | 50 | §8, lines 554-583 |

---

## Digest metadata
- **Source:** aside:models+streaming (parts 102, 103, 50)
- **Mined for:** ultimate-agent-browser CLI/skill (keyless, host-model-is-the-brain design)
- **Net verdict:** ~70% of this source is product infrastructure (billing, multi-provider gateway, accounts/crypto, daemon session management) that should be explicitly excluded from agent-browser's scope. The transferable core is: (1) normalize every tool/action result into a self-contained, uniform "frame" shape and never let raw exceptions reach the agent loop; (2) treat abort as a distinct clean-terminal state, not a failure; (3) copy the skill-authoring conventions almost verbatim — frontmatter with discovery-first `description` + optional `keywords`/`urlPatterns`, slug algorithm, path-based builtin/user precedence, fuzzy-dedup-before-create with a confirmation gate for anything the agent writes to its own future instructions unsupervised.
