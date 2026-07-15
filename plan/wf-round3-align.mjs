export const meta = {
  name: 'moxxie-round3-align',
  description: 'Round 3: ~40 gap-alignment agents (5-6 per source incl microsoft/webwright + a moxxie self-audit) compare each source to moxxie\'s ACTUAL code and propose keyless improvements; synthesize an alignment plan; red-team it.',
  phases: [
    { title: 'Align', detail: 'per-source lens agents: gap-analyze source vs moxxie\'s real code -> concrete keyless changes' },
    { title: 'Plan', detail: 'synthesize the prioritized, keyless-verified, cargo-cult-filtered alignment plan' },
    { title: 'RedTeam', detail: 'critical-thinking on the plan: kill re-introduced cargo-cult, verify keyless + eval-earned' },
  ],
}

const REPO = '/Users/seventyleven/Desktop/moxxie'
const SRC = `${REPO}/skill/agent-browser/src`
const OUT = `${REPO}/research/round3`
const REF = `${REPO}/reference`
const RF = '/Users/seventyleven/Desktop/researchfms'
const TD = `${RF}/teardowns`
const AP = `${TD}/_aside_parts`

const GOAL = `PROJECT: "moxxie" — a keyless Node/TS CLI on Playwright giving AI sub-agents browser access (an agent-browser-compatible superset). The host LLM is the brain; moxxie NEVER calls a model (100% keyless). moxxie is ALREADY BUILT and passing its eval gate; your job is ALIGNMENT: find what THIS source does better than moxxie's CURRENT implementation and propose concrete, keyless changes to close the gap or surpass it.`

const TOOLS = `You have FULL tool access (Read, Grep, Glob, Bash). Read moxxie's ACTUAL code under ${SRC} (relevant modules for your lens) AND the source. Do NOT guess moxxie's behavior — read it. Every finding must cite a real anchor in BOTH the source and (where relevant) moxxie.`

const KEYLESS = `HARD RULE: moxxie is 100% KEYLESS. Any recommendation that requires moxxie to call a model/provider is INVALID as a moxxie feature — either re-express it as a keyless heuristic OR a bundle handed to the host to run, or tag it recommendation:"skip". Flag keyless_ok honestly.`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['slug', 'source', 'lens', 'top_recommendation', 'moxxie_gaps', 'digest_path'],
  properties: {
    slug: { type: 'string' }, source: { type: 'string' }, lens: { type: 'string' },
    top_recommendation: { type: 'string', description: 'The single highest-value keyless change moxxie should make from this source.' },
    moxxie_gaps: {
      type: 'array', description: '4-12 concrete gap-alignment findings.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'source_does', 'moxxie_current', 'recommendation', 'change', 'keyless_ok', 'priority', 'evidence'],
        properties: {
          name: { type: 'string' },
          source_does: { type: 'string' },
          moxxie_current: { type: 'string', description: "What moxxie does today (cite a file/function you READ under src/), or 'absent'." },
          recommendation: { type: 'string', enum: ['adopt', 'align', 'skip-cargo-cult'] },
          change: { type: 'string', description: 'The concrete moxxie change: which file/function + what to do. Specific enough to implement.' },
          keyless_ok: { type: 'boolean' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          evidence: { type: 'string', description: 'source anchor (+ moxxie anchor).' },
        },
      },
    },
    digest_path: { type: 'string' },
  },
}

// Each: {slug, source, paths, lens, moxxieModules}
const A = []
const add = (slug, source, paths, lens, moxxieModules) => A.push({ slug, source, paths, lens, moxxieModules })

// --- microsoft/webwright (NEW source, 6 agents) ---
add('ww-thesis', 'microsoft/webwright', `${REF}/webwright/README.md ${REF}/webwright/src`, 'Core thesis: "a terminal is all you need" + each task = ONE re-runnable Python script + separate-agent-from-browser. Compare to moxxie\'s two-mode design (discrete commands; NO run-mode). Should moxxie ship a re-runnable "session transcript / script export" or a code-run mode? Keep keyless.', `${SRC}/cli.ts ${SRC}/core/handlers.ts`)
add('ww-browser-api', 'microsoft/webwright', `${REF}/webwright/src`, 'The exact browser API/environment webwright exposes to the model (its Playwright wrapper surface, element querying, waits). Compare verb-by-verb to moxxie\'s command surface + actions; find missing/better primitives.', `${SRC}/actuation ${SRC}/core/handlers.ts`)
add('ww-perception', 'microsoft/webwright', `${REF}/webwright/src`, 'How webwright captures + inspects page state/screenshots "only when needed" (its perception + vision-gating). Compare to moxxie snapshot(walk/serialize)+diff+vision gating; find gaps.', `${SRC}/perception`)
add('ww-skill', 'microsoft/webwright', `${REF}/webwright/skills`, 'The skills/webwright/ SKILL packaging for Claude Code/Codex/OpenClaw/Hermes (keyless host-driven form). moxxie has NO SKILL.md yet. Extract exactly how to write moxxie\'s SKILL.md: what it tells the host agent, the loop, examples, progressive disclosure.', `${SRC}/core/handlers.ts`)
add('ww-tests-evals', 'microsoft/webwright', `${REF}/webwright/tests ${REF}/webwright/pyproject.toml`, 'webwright\'s tests + any benchmark/eval harness + how it measures task success. Compare to moxxie/evals; find eval improvements (task sets, scoring).', `${REPO}/evals`)
add('ww-security-keyless', 'microsoft/webwright', `${REF}/webwright/src ${REF}/webwright/SECURITY.md`, 'webwright\'s keyless/backends abstraction, Task2UI mode, and any safety posture. What keyless/security pattern should moxxie adopt? What is model-dependent and must be skipped for keyless moxxie?', `${SRC}/security`)

// --- vercel/agent-browser (real code, 5) ---
add('vc-surface', 'vercel/agent-browser', `${REF}/agent-browser/cli ${REF}/agent-browser/docs`, 'Full verb/flag surface vs moxxie\'s IMPLEMENTED handlers (handlers.ts) — which verbs/flags moxxie is MISSING or stubbed (tab/frame/network/dialog/pdf) and which are worth adding keyless.', `${SRC}/core/handlers.ts ${SRC}/core/flags.ts`)
add('vc-snapshot', 'vercel/agent-browser', `${REF}/agent-browser/cli/src/native/snapshot.rs`, 'snapshot.rs 3-source merge (AX + cursor scan + hidden-input promotion), compact, iframe splice, empty-states vs moxxie walk.ts/serialize.ts. Find fidelity gaps.', `${SRC}/perception/walk.ts ${SRC}/perception/serialize.ts`)
add('vc-session', 'vercel/agent-browser', `${REF}/agent-browser/cli/src`, 'session/restore/worktree-id/idle-timeout/version-check/namespace vs moxxie session.ts (browser-as-daemon). Find robustness gaps.', `${SRC}/core/session.ts`)
add('vc-skill-evals', 'vercel/agent-browser', `${REF}/agent-browser/skills ${REF}/agent-browser/skill-data ${REF}/agent-browser/evals`, 'docs-in-binary two-tier skill + eval structure vs moxxie (no SKILL.md yet). What to adopt for moxxie skill+evals.', `${REPO}/evals ${SRC}/core/handlers.ts`)
add('vc-config', 'vercel/agent-browser', `${REF}/agent-browser/agent-browser.schema.json`, 'The config JSON Schema + plugin/capability model vs moxxie flags.ts. Should moxxie ship a config file + schema? keyless.', `${SRC}/core/flags.ts`)

// --- browser-use (real code, 5) ---
add('bu-dom', 'browser-use', `${REF}/browser-use/browser_use`, 'DOM serializer + selector-map + viewport/visibility filtering vs moxxie walk.ts interactive cascade. Gaps in element detection.', `${SRC}/perception/walk.ts`)
add('bu-controller', 'browser-use', `${REF}/browser-use/browser_use`, 'Action/controller registry (decorator -> schema+dispatch+doc) + multi_act page-change guard vs moxxie actions.ts + pagechange.ts + registry.ts.', `${SRC}/actuation/actions.ts ${SRC}/actuation/pagechange.ts ${SRC}/security/registry.ts`)
add('bu-loop', 'browser-use', `${REF}/browser-use/browser_use`, 'Agent loop, message manager, max_failures/grace, done semantics, loop-detection vs moxxie (host-driven loop). What loop DISCIPLINE should moxxie encode in its SKILL.md + done handling?', `${SRC}/core/handlers.ts`)
add('bu-sensitive', 'browser-use', `${REF}/browser-use/browser_use`, 'sensitive_data handling, %placeholder% substitution, structured output, filesystem/todo vs moxxie security (redact/injection) + extract. Keyless secret handling.', `${SRC}/security ${SRC}/extract`)
add('bu-watchdogs', 'browser-use', `${REF}/browser-use/browser_use`, 'Watchdog architecture (downloads/permissions/crash/dialog) vs moxxie. Which watchdogs are keyless wins for moxxie robustness?', `${SRC}/core/handlers.ts ${SRC}/actuation`)

// --- stagehand (real code, 5) ---
add('sh-act', 'browserbase/stagehand', `${REF}/stagehand`, 'act()/observe() method-map + resolution vs moxxie actions.ts/find. Gaps.', `${SRC}/actuation/actions.ts`)
add('sh-extract', 'browserbase/stagehand', `${REF}/stagehand`, 'extract() schema/zod + id-grounding + injectUrls vs moxxie extract (transform/resolve). moxxie is close — find refinements + edge cases.', `${SRC}/extract`)
add('sh-a11y', 'browserbase/stagehand', `${REF}/stagehand`, 'a11y tree build + backendId maps + iframe encoding vs moxxie walk.ts. Gaps in tree fidelity + iframe.', `${SRC}/perception/walk.ts ${SRC}/perception/serialize.ts`)
add('sh-cache', 'browserbase/stagehand', `${REF}/stagehand`, 'action caching + self-heal (cache the decision, replay, repair on drift) vs moxxie (absent). Is a keyless local action-cache worth adding?', `${SRC}/actuation`)
add('sh-prompts', 'browserbase/stagehand', `${REF}/stagehand`, 'Verbatim act/extract/observe prompts + operator patterns vs moxxie extract/prompts.ts + (future) SKILL.md. What prompt fragments should moxxie ship?', `${SRC}/extract/prompts.ts`)

// --- ASIDE (teardown, 5) ---
add('as-actuation', 'ASIDE', `${AP}/101_asidewright_actuation.md ${AP}/90_asidewright.md`, 'asidewright actuation (dropdowns two-step, dialog auto-accept, iframe click, settle constants) vs moxxie (Playwright-delegated). Which patterns does moxxie still need on top of Playwright?', `${SRC}/actuation`)
add('as-perception', 'ASIDE', `${AP}/91_snapshot_builder.md ${AP}/40_perception.md`, 'snapshot builder (readiness gate, downsample/enrich, never-truncate, off-screen keep) vs moxxie walk/serialize. Gaps.', `${SRC}/perception`)
add('as-security', 'ASIDE', `${AP}/60_native_security.md ${AP}/89_guardrails_captcha.md`, 'security stack (untrusted fencing layers, confirm gate, audit log, captcha detect) vs moxxie security defaults. Gaps (esp. audit log, confirm-gate correctness).', `${SRC}/security`)
add('as-skills', 'ASIDE', `${AP}/99_skills_engine.md ${AP}/98_vision_loop.md`, 'skills engine (URL-glob site playbooks, progressive disclosure) + vision loop (cheap-by-default) vs moxxie. Adopt as SKILL.md guidance / v2 site-playbooks? keyless.', `${SRC}/core/handlers.ts`)
add('as-harness', 'ASIDE', `${AP}/95_why_sota.md ${AP}/20_runtime_loop.md ${AP}/96_tool_registry_full.md`, 'why-SOTA harness levers (fixed viewport, lean ~10K loop, recovery/verification discipline, tool registry) vs moxxie. Which levers to encode in moxxie defaults + SKILL.md.', `${SRC}/core/handlers.ts ${SRC}/core/session.ts`)

// --- browserbase (teardown, 4; mostly note-v2) ---
add('bb-sessions', 'BROWSERBASE', `${RF}/browserbase`, 'Session lifecycle vs moxxie session.ts — any keyless-local robustness (not cloud fleet) worth adopting.', `${SRC}/core/session.ts`)
add('bb-stealth', 'BROWSERBASE', `${RF}/browserbase`, 'Stealth/proxy/fingerprint (local, keyless subset only) vs moxxie. What LOCAL stealth is a keyless win; flag cloud/paid as skip.', `${SRC}/core/session.ts`)
add('bb-cua', 'BROWSERBASE', `${RF}/browserbase`, 'CUA/computer-use client patterns — mostly model-dependent; extract only keyless-relevant bits, skip the rest.', `${SRC}/perception`)
add('bb-recording', 'BROWSERBASE', `${RF}/browserbase`, 'Recording/observability — is a keyless local session log/replay worth it for moxxie debugging? (aligns w/ webwright "logs are the artifact").', `${SRC}/core/handlers.ts`)

// --- perplexity (teardown, 4) ---
add('px-browsesafe', 'PERPLEXITY', `${TD}/PERPLEXITY_COMPUTER.md`, 'BrowseSafe / injection defense (async classifier, replace-not-append, egress) — keyless subset vs moxxie injection.ts/egress.ts. Adopt keyless parts.', `${SRC}/security/injection.ts ${SRC}/security/egress.ts`)
add('px-decompose', 'PERPLEXITY', `${TD}/PERPLEXITY_COMPUTER.md`, 'Task decomposition / planning — mostly host-side; what SKILL.md guidance should moxxie encode. Skip model-dependent CLI features.', `${SRC}/core/handlers.ts`)
add('px-verify', 'PERPLEXITY', `${TD}/PERPLEXITY_COMPUTER.md`, 'Verification / done-checking patterns vs moxxie done semantics + eval judge. Keyless verification.', `${REPO}/evals`)
add('px-vision', 'PERPLEXITY', `${TD}/PERPLEXITY_COMPUTER.md`, 'Pixel/vision vs a11y tradeoffs + when vision is needed vs moxxie screenshot handling. Keyless vision-gating.', `${SRC}/perception ${SRC}/core/handlers.ts`)

// --- agentql (teardown, 3) ---
add('aq-query', 'AGENTQL', `${RF}/agentql`, 'Query/locator resolution (resilient element finding) vs moxxie find/resolve. Any keyless locator improvement (without a full DSL — that was flagged anti-pattern).', `${SRC}/actuation/resolve.ts ${SRC}/actuation/actions.ts`)
add('aq-cache', 'AGENTQL', `${RF}/agentql`, 'Caching resolved queries + deterministic-before-model fallbacks vs moxxie. Keyless caching.', `${SRC}/actuation`)
add('aq-fleet', 'AGENTQL', `${RF}/agentql`, 'Browser fleet / parallel sessions vs moxxie single-session model. Should moxxie support multiple named sessions better? keyless.', `${SRC}/core/session.ts`)

// --- skills/self-audit (3) ---
add('sk-playwright-skill', 'skills(playwright+core-agent-browser)', `/Users/seventyleven/Desktop/best-rust-patterns-skills/skills/core-agent-browser/SKILL.md`, 'The existing agent-browser SKILL.md + Playwright-MCP skill patterns — SKILL.md design lessons for moxxie (command tables, examples, loop, phase-scoping).', `${SRC}/core/handlers.ts`)
add('self-audit', 'moxxie-self', `${SRC} ${REPO}/evals`, 'MOXXIE SELF-AUDIT: read ALL of moxxie\'s src + evals and list moxxie\'s OWN bugs, weaknesses, missing edge-cases, and inconsistencies (e.g. the known "get value @passwordRef leaks the raw value" bug; the confirm-gate non-TTY behavior; state-load localStorage gap; incognito unimplemented). Be adversarial about correctness + keyless + security.', `${SRC}`)
add('self-keyless', 'moxxie-self', `${SRC}`, 'KEYLESS + no-leak AUDIT: grep all of moxxie src for ANY model/provider call, network egress, or path/secret leak into error/warning strings. Confirm 100% keyless. List any violation + a keyless-verification test moxxie should add.', `${SRC}`)

phase('Align')
const digests = await parallel(A.map((a) => () =>
  agent(
    `${TOOLS}\n\n${GOAL}\n\n${KEYLESS}\n\nSOURCE: ${a.source}\nLENS: ${a.lens}\nSOURCE PATHS: ${a.paths}\nMOXXIE MODULES TO COMPARE AGAINST (read these): ${a.moxxieModules}\n\nTASK:\n1. Read the moxxie modules above (its ACTUAL current behavior) and the source through your lens.\n2. Produce concrete GAP-ALIGNMENT findings: what the source does that moxxie should adopt/align to (or explicitly skip as cargo-cult). Each finding names the exact moxxie file/function to change and what to do, tagged keyless_ok + priority.\n3. Write a grounded digest to ${OUT}/${a.slug}.md.\n4. Return the structured summary; digest_path = the file.\n\nBe concrete and honest. Prefer 6-10 high-signal findings over noise. Mark cargo-cult (things a big system had that keyless moxxie does NOT need) as skip-cargo-cult so we don't re-introduce bloat.`,
    { label: `align:${a.slug}`, phase: 'Align', schema: SCHEMA, model: 'sonnet', effort: 'medium' }
  ).then((r) => ({ ...r, label: a.slug })).catch(() => null)
))
const ok = digests.filter(Boolean)
log(`Round 3: ${ok.length}/${A.length} alignment agents done.`)

phase('Plan')
const planPath = `${REPO}/research/synthesis/alignment-plan.md`
const planSummary = await agent(
  `You have FULL tool access. You are the ALIGNMENT lead for moxxie (keyless browser CLI on Playwright). ${ok.length} gap-alignment agents each wrote a digest under ${OUT}/ comparing a source (webwright, vercel, browser-use, stagehand, ASIDE, browserbase, perplexity, agentql, skills) to moxxie's ACTUAL code, plus a moxxie self-audit and a keyless audit.\n\nREAD ALL digests under ${OUT}/ (ls then read every .md). Also skim moxxie's src (${SRC}) to sanity-check current state.\n\nWrite ${planPath} — the prioritized, keyless-verified, cargo-cult-filtered ALIGNMENT PLAN of concrete moxxie changes. Structure:\n1. **P0 — must-fix now** (correctness/security bugs from the self-audit: e.g. get-value password leak, confirm-gate non-TTY, keyless-verification test; plus any high-value fidelity gap).\n2. **P1 — alignment wins** (adopt from sources: webwright's SKILL.md + re-runnable-script/log-artifact idea; missing verbs/robustness; snapshot fidelity; action-cache/self-heal IF it earns its place; iframe; watchdogs).\n3. **P2 — later/v2** (site playbooks, local stealth, recording, fleet).\n4. **SKIP — cargo-cult NOT to build** (anything model-dependent → violates keyless; cloud fleet; DSLs; etc.). Merge every skip-cargo-cult flag.\n5. **The moxxie SKILL.md spec** — synthesized from webwright + vercel + core-agent-browser skill lessons: exactly what moxxie's SKILL.md must contain.\nEach change: moxxie file/function + concrete edit + keyless_ok + which source(s) motivate it. Be decisive; this drives implementation. Group by moxxie module. Return a <=400-word exec summary + the path.`,
  { label: 'align:plan', phase: 'Plan', effort: 'high' }
)

phase('RedTeam')
const rtPath = `${REPO}/research/synthesis/alignment-redteam.md`
const redTeam = await agent(
  `You have FULL tool access. Adversarial critic (Compound-V critical-thinking). Read ${planPath} and moxxie's src (${SRC}) + evals.\n\nAttack the alignment plan BEFORE we implement:\n- Which P0/P1 items are CARGO-CULT re-introductions (a source had it but keyless moxxie driven by a smart host does NOT need it)? Kill them.\n- Which items secretly need a MODEL CALL (violating the 100% keyless invariant)? Flag + demand host-delegation or cut.\n- Which items are NOT justified by the eval gate (would add code/surface without moving pass_k or closing a real security hole)? Demote.\n- Are the P0 bugs REAL (verify against the actual code, e.g. does get-value truly leak)? Confirm or refute each.\n- Is the SKILL.md spec complete + honest (matches the real command surface)?\nWrite ${rtPath}: (a) CONFIRMED P0 bugs (verified real), (b) KILL list (cargo-cult / non-keyless / not-eval-earned), (c) the DEFENSIBLE alignment set to actually implement, (d) any keyless violation found. Blunt, specific, no praise-padding. Return a summary + the path.`,
  { label: 'align:redteam', phase: 'RedTeam', effort: 'high' }
)

return { aligned: ok.length, of: A.length, planPath, planSummary, rtPath, redTeam }
