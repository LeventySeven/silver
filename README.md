# moxxie

**The ultimate keyless browser for AI agents.** A single CLI a sub-agent installs and drives over the
shell to *perceive and act on live web pages* — `open → snapshot → act → re-snapshot → done` with stable
`@ref` grounding, ID-grounded extraction, diff-as-observation, and lethal-trifecta security **on by
default**. The host model is the brain; moxxie is the eyes and hands. **100% keyless** — no model call
anywhere in the tool, installable into any sandbox with zero configuration.

Synthesized from the best patterns across the field — **Aside**, **Vercel `agent-browser`**,
**`microsoft/webwright`**, **Browser Use**, **Stagehand / Browserbase**, **AgentQL**, and **Perplexity
Computer** — built on **Playwright** (the actuation engine; we reimplement none of it).

## Why moxxie beats the tools it synthesizes

Every serious browser-agent system converges on the same loop (snapshot → pick a stable ref → act →
re-snapshot; `done` is a tool; vision only to disambiguate; extract must be ID-grounded). moxxie ships
that convergent spine **plus the four things none of them ship together**, keyless:

1. **A runnable eval gate (`pass_k`)** — the moat. Vercel's `agent-browser` has *no* task-completion
   benchmark; moxxie's runs the real binary end-to-end (pass_k 1.000). The honest A/B vs Vercel: both
   pass the shared read/act tasks, but moxxie has **capabilities Vercel cannot express** — `extract`
   (ID-grounded) and injection-neutralization — plus trifecta-by-default and the stale-`@ref` grounding
   gate (proven by the unit + trifecta suites).
2. **Keyless, host-delegated, ID-grounded `extract`** — the schema's URL fields are swapped for element-ID
   fields *before the model sees them*, so a fabricated URL/price is **structurally impossible**.
3. **Hardened-by-default security** — egress denylist (`file:`/`data:`/`blob:` denied, suffix-match host
   allowlisting), redaction at the serializer choke point, forged-role-tag neutralization of page output,
   and **phase quarantine** (a disabled verb literally isn't dispatchable — no prompt can bypass it).
4. **Diff-as-observation** — every snapshot returns `min(tree, diff)`, keeping the observation cheap.

## Install

```bash
cd skill/agent-browser
pnpm install && pnpm build
npx playwright install chromium   # first time only
node dist/cli.js version
```

## Quick start

```bash
moxxie open https://example.com
moxxie snapshot -i                 # compact a11y tree with @e1, @e2 … refs
moxxie get text @e1                # read grounded text
moxxie --enable-actions click @e3  # actor verbs are gated off by default (read-only is safe)
moxxie extract --schema '{"links":[{"title":"string","url":"string"}]}'   # host runs inference on the bundle
moxxie close
```

`moxxie` is a **compatible superset** of Vercel's `agent-browser` surface — the same verbs and `@ref`
grounding, plus `extract`, diff-observation, and the security defaults.

## Layout

- `skill/agent-browser/` — the moxxie CLI (TypeScript + Playwright) and its skill doc.
- `evals/` — the `pass_k` harness, the lethal-trifecta suite, and the Vercel A/B (the gate).
- `docs/specs/`, `docs/plans/` — the committed design spec and implementation plan.
- `research/` — the deep multi-agent investigation corpus + synthesis + red-team that drove the design.
- `reference/` — cloned OSS sources (gitignored): Vercel `agent-browser`, browser-use, stagehand, webwright.

## Status

Core engine + security + extract + CLI + eval gate are green (103 tests; pass_k 1.000; trifecta 3/3).
Under active cross-source alignment and hardening.

## License

MIT (our code). See `NOTICE` for patterns adapted from vercel-labs/agent-browser (Apache-2.0),
browserbase/stagehand (MIT), browser-use/browser-use (MIT), and microsoft/webwright (MIT).
