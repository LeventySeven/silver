# Silver

**One keyless browser for AI agents — so you never switch tools again.** Silver is a single CLI a
sub-agent installs and drives over the shell to *perceive and act on live web pages*:
`open → snapshot → act → re-snapshot → done`, with stable `@ref` grounding, ID-grounded extraction,
diff-as-observation, long-running task artifacts, parallel multi-browser orchestration, and
lethal-trifecta security **on by default**. The host model is the brain; Silver is grounded eyes + hands.
**100% keyless** — no model call anywhere in the tool, installable into any sandbox with zero config.

Silver exists because switching between Vercel `agent-browser`, Webwright, and Aside when one breaks is
painful. So it **synthesizes the best of each into one** — not a monster that bolts them together, but the
top capabilities of every tool, distilled and made better.

## What it takes from each (and improves)

- **Vercel `agent-browser`** — the fast, agent-ergonomic CLI shape + the compact `@eN` accessibility-tree
  snapshot (token-efficient perception). Silver ships a **compatible superset** of its verb surface.
- **Webwright** (Microsoft) — long-running tasks as a **replayable run-folder artifact** (plan + action
  log + checkpoints), so a task survives a crashed agent.
- **Aside** — parallel **subagents**, grep-first **memory**, generation-stamped `@ref` grounding, and the
  "harness > model" philosophy.
- **Stagehand / AgentQL / Browser Use** — ID-grounded `extract` (fabricated URLs are *structurally*
  impossible), the interactive-element heuristic cascade, the page-change guard.

**Beyond all of them, by default:** a runnable `pass_k` **eval gate** (Vercel has none), keyless
**ID-grounded extract**, **DNS-rebinding SSRF** defense, forged-tag + boundary-glyph **injection
neutralization**, **phase-quarantine** (a disabled verb literally isn't dispatchable), a **paid/destructive
confirm gate**, and **encrypted session state at rest**.

## Install

The npm name `silver` is taken, so Silver installs straight from GitHub (no npm publish needed).

```bash
# Run once, no install (prints the full agent-facing guide):
npx github:LeventySeven/silver skill --full

# Install the CLI globally, then use `silver <verb>` anywhere:
npm i -g github:LeventySeven/silver
silver version

# Drop the skill files into your project (writes ./.claude/skills/silver/ or ./silver/):
npx github:LeventySeven/silver skill install

# First-time browser download (Playwright's own postinstall usually handles this):
npx playwright install chromium
```

From source (for development):

```bash
git clone https://github.com/LeventySeven/silver.git
cd silver/silver          # the product package lives in the silver/ subdir
pnpm i && pnpm build
npm link                  # puts `silver` on your PATH
npx playwright install chromium   # first time only
node dist/cli.js version
```

> A GitHub install runs `prepare`, which compiles `silver/dist` on the fly — so
> `npx github:LeventySeven/silver <verb>` and the global bin both work without a
> published tarball.

## How it runs

Silver spawns a **real, detached, headless-by-default Chromium on your machine** (Playwright's bundled
build) and each command reconnects to it over CDP — so state (tabs, cookies, page) persists across
commands. `--headed` shows the window. `--session <name>` gives each agent its own browser; `--namespace`
isolates whole agent groups; `connect <endpoint>` attaches to a browser someone else launched.

## Quick start

```bash
silver open https://example.com
silver snapshot -i                     # compact a11y tree: @e1, @e2 … refs
silver get text @e1
silver --enable-actions click @e3      # actor verbs are gated off by default (read-only is safe)
silver extract --schema '{"links":[{"title":"string","url":"string"}]}'   # host runs inference on the bundle
# long task:  silver task start "research X" ; silver task exec <id> -- snapshot -i ; silver task resume <id>
# parallel:   silver --session a open … & silver --session b open …   (own browser each)
silver skill --full                    # the complete agent-facing guide
```

## Layout

- `silver/` — the product (TypeScript + Playwright). This is the CLI **and** the skill:
  `silver/src` (code), `silver/skill-data/core/SKILL.md` + `reference/*` (the agent guide, served by
  `silver skill --full`), `silver/commands/*` (mode dispatchers), `silver/tests`.
- `evals/` — the `pass_k` harness, lethal-trifecta suite, and A/B vs the real Vercel binary (the moat).

The deep multi-agent investigation, synthesis, red-teams, the base/language decision, and the Rust
differential oracle are kept **local-only** (gitignored) — this repo ships just the skill + CLI.

## Why TypeScript (not Rust)

Decided by an **unbiased 18-agent workflow** (evidence → advocates → 5 independent judges → red-team),
5/5 for TypeScript, on the one durable fact: **Playwright is TS-native** (auto-wait, selector engine,
network interception maintained upstream) while Rust hand-rolls CDP and owns protocol maintenance forever.
Token-efficiency is a property of the *snapshot format* (which Silver matches), not the language — and the
one real Rust edge (per-command latency) was measured, traced to a *dead network-idle settle on read
verbs*, and fixed in TS: **warm snapshot dropped 1.45s → 0.23s (6×)**, `version` 190ms → ~55ms.

## Status

Prod-grade: **328 tests · eval pass_k 1.000 · lethal-trifecta 3/3**, all committed. Keyless. No MCP.
Full Vercel-parity verbs + Webwright long-tasks (`task compile`/manifest/replay) + Aside subagents/memory/
parallel; cross-origin iframe (OOPIF) perception; keyless auth (`--engine firefox`, `--profile`, TOTP,
cookie-fetch, `<secret>` write-path); an `expect` trust primitive + captcha/auth detection; subresource
egress + DNS-rebinding SSRF defense; an Anthropic-grade SKILL (3-tier progressive disclosure).

## License

MIT. See `NOTICE` for patterns adapted from vercel-labs/agent-browser (Apache-2.0), browserbase/stagehand
(MIT), browser-use/browser-use (MIT), and microsoft/webwright (MIT).
