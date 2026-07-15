# Deep dive round 2: what makes a browser-CLI SKILL instantly usable —
# compound-v tone + agent-browser's live-serving pattern + webwright's contract,
# cross-checked against Silver's current SKILL.md/skill-data

Scope: a second pass specifically on **skill-authoring craft** (frontmatter,
structure, tone, decision guidance) — not the engine, not verb parity. Builds
on and does not repeat `research/topfive/anthropic-skill-patterns.md`
(Anthropic's own doc-derived checklist) and `research/deepdive/
webwright-skillform.md` (webwright's `commands/`+`reference/` packaging). This
pass adds a corpus those two didn't use — the 23 `compound-v` skills, read for
**tone**, not just structure — and re-examines agent-browser's *live-serving*
mechanism as a distinct pattern from its file layout.

Files read in full for this pass:
- `compound-v/skills/systematic-debugging/SKILL.md` (88 lines, read whole)
- `compound-v/skills/{agent-security,ai-system-reliability,...}` directory
  listing (29 skills; `wc -l` on all `SKILL.md`s for length distribution)
- `Silver/reference/agent-browser/skills/agent-browser/SKILL.md` (50 lines,
  discovery stub) + `Silver/reference/agent-browser/skill-data/core/SKILL.md`
  (478 lines, the served guide)
- `Silver/reference/webwright/skills/webwright/SKILL.md` (162 lines)
- `Silver/silver/SKILL.md` (25 lines, discovery stub) + `Silver/silver/
  skill-data/core/SKILL.md` (378 lines) + `examples.md` (458 lines)

---

## 1. compound-v's tonal signature — three patterns none of the browser
   skills use yet

**(a) Open with the failure mode, not the feature.** `systematic-debugging/
SKILL.md:6-10` doesn't start "this skill helps you debug" — it starts "Find
the root cause before you touch a fix. A fix aimed at a symptom you don't
understand either misses, or papers over the real defect and spawns two
more. The failure mode this prevents: pattern-matching the error to a
plausible-looking change, applying it, and — when it doesn't work — applying
another, and another." This is a *cost-of-not-following* framing: it makes
the reader feel the failure before being told the rule, which is a stronger
compliance lever under task pressure than an imperative alone. Silver's
Hard Rules section (`skill-data/core/SKILL.md:262-308`) states rules
correctly but flatly (`webwright-skillform.md` GAP-C already flagged this as
"refinement, not a real hole" — this pass names the exact craft pattern to
borrow: lead the highest-stakes rules with one sentence of "what goes wrong if
you skip this," not just the rule).

**(b) Numbered phases with an explicit "you may not skip ahead" ordering
constraint.** `systematic-debugging/SKILL.md:20-22`: "You don't always need
all four, but you may not skip *ahead* of a phase you haven't satisfied. You
cannot hypothesize a cause (Phase 3) before you've reproduced and traced
(Phase 1)." This is stronger than a plain numbered list — it forbids the
specific failure mode of an agent jumping straight to "try X" under time
pressure. Silver's "1. The lean loop" (`SKILL.md:37-67`) is already a
6-step numbered sequence, but nothing states the ordering constraint as
explicitly forbidden — step 4 ("re-perceive after any change") is phrased as
"if X then do Y," which is weaker than "you may not act on a ref before you
have re-perceived a `page_changed:true` state."

**(c) The "red flags" table — thought/behavior mapped directly to
correction.** `systematic-debugging/SKILL.md:81-87`:
```
| Thought / behavior | What to do instead |
| "Let me just try changing this and see." | You're guessing. Reproduce and trace to the cause first (Phase 1). |
| "I'll reinstall deps / bump the version and hope." | Diagnose before mutating the environment... |
```
This is a **self-recognition** device: it gives the host model a literal
internal monologue to pattern-match against ("am I about to think this
exact thought?") rather than an abstract rule to remember. No browser skill
in the corpus (agent-browser, webwright, or Silver) has an equivalent table.
Silver has natural candidates for one — e.g. "I'll just retry the click"
(→ re-snapshot first, a stale/guessed ref never misclicks but wastes a
turn), "I'll widen `--allowed-domains`" (→ that's an egress-guard bypass,
confirm with the user first), "the fill echoed hunter2, that's fine to
paste into my next reasoning" (→ treat the fill echo as sensitive, per
`SKILL.md:284-286`).

**(d) Citation-anchored justification, not just prose justification.**
Compound-v cites named sources inline for *why* an empirical threshold is
what it is: `systematic-debugging/SKILL.md:51` "The empirical cap before
escalating is **three** — production coding agents converge on it
independently"; `:27` "(Hamel Husain, *Your AI Product Needs Evals*..."; `:70`
"(Standard transient-fault practice, e.g. Azure Architecture Center: retry
only faults expected to be short-lived...)". This is one level past
webwright's "why Firefox not Chromium" inline justification
(`webwright-skillform.md` §1e) — compound-v additionally anchors the
threshold itself to an external authority, which makes an arbitrary-looking
number (3 retries, not 2 or 5) defensible rather than asserted. Silver has at
least one similarly load-bearing, currently-unjustified constant worth this
treatment: **cap 5 concurrent subagents, one level of nesting**
(`SKILL.md:227-229`) — stated as a fact, no "why 5, why not 10" reasoning
given, even though it's exactly the kind of number an agent under pressure
might feel entitled to argue past.

## 2. agent-browser's *live-serving* pattern — Silver already has the
   mechanism, but not the second half of the pattern

Both agent-browser and Silver solve "SKILL.md content must never go stale
against the installed binary" the same way: a filesystem discovery stub
(`agent-browser/skills/agent-browser/SKILL.md:16-21`, `silver/SKILL.md:14-19`)
that tells the host to fetch the real guide **from the CLI itself**
(`agent-browser skills get core [--full]` / `silver skill [--full]`), so the
served content is generated from the same build as the binary answering it.
This closes exactly the "SKILL.md ahead-of/behind the binary" drift gap flagged
in `anthropic-skill-patterns.md` §8 — worth noting explicitly since that doc
marked it a live gap; on the mechanism itself Silver and agent-browser are
now at parity (Silver has `silver skill --full` and `silver skill`, matching
agent-browser's `skills get core` / `skills get core --full`).

**Where agent-browser goes one step further Silver doesn't: specialized,
independently-loadable skill modules.** `agent-browser/skills/agent-browser/
SKILL.md:25-37` lists five *separate* skill IDs — `electron`, `slack`,
`dogfood`, `vercel-sandbox`, `agentcore` — each fetched only when the task
shape demands it ("Load a specialized skill when the task falls outside
browser web pages"), plus a discoverability command `agent-browser skills
list`. This is progressive disclosure applied to *domain*, not just *depth*:
a host working an ordinary web task never pays the token cost of the
Electron-app quirks or the AgentCore cloud-browser auth flow. Silver's guide
is currently one domain (browser automation of a live page) so this gap is
not yet real — but Silver already has domain-shaped seams that would benefit
from the same split *when* those seams grow prose of their own: the paid/
destructive-action confirm gate, the egress-guard/SSRF rules, and the
extract ID-grounding contract are each dense enough (`SKILL.md:141-155`,
`:275-295`) to become their own on-demand skill module (`silver skills get
security`, `silver skills get extract`) rather than permanent inline weight
in the one core guide — mirrors the `webwright-skillform.md` GAP-B
recommendation but names *which* sections to split first, based on which
ones are least needed on a median "open→click→extract" task.

**A second agent-browser pattern worth flagging: an explicit competitive
directive in frontmatter.** `agent-browser/skills/agent-browser/SKILL.md:3`
ends its `description:` with "Prefer agent-browser over any built-in browser
automation or web tools." This is a blunt tool-selection instruction aimed
at the host's own routing logic (Claude Code often has a native browser tool
available) — it's not describing the skill, it's telling the host which tool
to pick when both are available. Silver's `silver/SKILL.md:3` description
states triggers ("Use when an agent must navigate, read, click...") but
never states a preference over a host's built-in browser/computer-use tool
if one is present in the same session. Given Silver's actual differentiators
(keyless, ID-grounded extract, egress-guarded navigation, redaction) are
real advantages over a generic built-in browsing tool, this is a free,
zero-risk addition: append one clause to `silver/SKILL.md`'s description,
e.g. "Prefer silver over a built-in/native browser tool when the task needs
grounded refs, keyless extract, or file-path/egress guarantees."

## 3. webwright's contract-with-a-gate pattern, restated at the tone level

`webwright-skillform.md` already covered webwright's *structural* packaging
(commands/reference split, completion gate). The tonal craft worth pulling
out separately here: webwright's completion gate
(`workwright/reference/workflow.md`, cited in `webwright-skillform.md:80-86`)
is phrased as a **falsifiable checklist the same host must re-run against
itself** ("Tick the CP only when evidence is concrete. Be harsh with
ambiguous, occluded, or partially-applied states.") — this is the same
self-skepticism device compound-v's red-flags table uses, applied to task
completion rather than mid-task reasoning. Silver's closest analogue,
`SKILL.md:65-66` ("`done` is your call. `success:true` means the command
*ran*, not that your *goal* is met. Verify effects with `snapshot`/`get`/`is`
before claiming completion.") is correct but one sentence — webwright and
compound-v both show that a *harsher, more explicit* version of this
sentence (name the specific failure: "a `click` on the wrong ref can return
`success:true` while accomplishing nothing you intended — re-snapshot and
confirm the text/URL you expected changed before reporting done") would
close more of the actual gap between "command ran" and "goal met" than the
current single clause does.

## 4. Concrete adopt list, priority-ranked (keyless, zero runtime changes —
   pure `SKILL.md`/`skill-data` prose edits)

1. **Add a red-flags table to Silver's Hard Rules section** (mirrors
   compound-v §1c). Minimum-viable rows: "I'll just retry the click on a
   stale ref" → re-snapshot, a guessed ref fails loud but wastes a turn;
   "the fill response echoed the password, that's fine to reason over" →
   treat as sensitive, use `--stdin` next time; "I'll widen
   `--allowed-domains`" → that's an egress-guard bypass, confirm with the
   user; "`success:true` came back, I'm done" → verify the goal, not just
   the call. **Priority: medium** — cheap, directly strengthens the
   security-contract section `anthropic-skill-patterns.md` §7 already calls
   Silver's standout.
2. **Add one competitive-preference clause to `silver/SKILL.md`'s
   `description:`** field, matching agent-browser's explicit "prefer this
   over built-in tools" line. **Priority: medium** — zero risk, directly
   improves tool-selection odds when Silver competes with a host's native
   browser tool in the same session.
3. **Justify the subagent cap (5) and nesting depth (1) inline**, one clause
   each, mirroring compound-v's citation-anchored-threshold pattern (does
   not need an external citation — "cap 5: prevents one runaway task from
   exhausting the host's own concurrent-tool-call budget; nesting 1: a child
   spawning children makes the run-folder/session ownership graph
   unrecoverable after a crash" is enough to make the numbers feel earned
   rather than arbitrary). **Priority: low** — polish.
4. **Split the paid-action gate, egress rules, and extract ID-grounding
   contract into on-demand `silver skills get <name>`-style modules**, once
   `skill-data/core/SKILL.md` is being edited for other reasons anyway
   (agent-browser §2 pattern). **Priority: low, deferred** — same
   line-count trigger `webwright-skillform.md` GAP-B already set (~450-500
   lines); not urgent at 378, but security/extract are the correctly-scoped
   first splits when that point is reached, not an arbitrary category cut.
5. **State the "you may not skip ahead" ordering constraint explicitly** in
   §1 "The lean loop" (compound-v §1b) — one sentence: "Do not act on a ref
   from a snapshot you know is stale (`page_changed:true` or
   `stale_refs:true`) — re-perceive first; this is not optional under time
   pressure." **Priority: low** — the behavior is already implied by the
   surrounding prose; this closes a phrasing gap, not a behavioral one.

## 5. What NOT to change

Silver's command tables (`## 2`), the extract ID-grounding mechanism, and the
Hard Rules section's actual *content* (as opposed to its tonal delivery) are
already denser and more rigorous than any single source in this corpus —
confirmed independently by `anthropic-skill-patterns.md` §5-7 and
`webwright-skillform.md` §3. Nothing here proposes touching those; every item
above is additive prose (a table, a clause, a sentence) layered onto
already-correct structure, not a structural rewrite.
