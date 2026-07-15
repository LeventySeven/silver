---
name: silver
description: Use when an agent must navigate, read, click, fill, or extract data from a live web page via a local headless browser — keyless (no model calls), standalone or chained with other CLIs. Covers quick tasks, long-running tasks (durable run folders), parallel sessions/tabs, subagents, and grep-first memory. The host is the brain; silver is grounded eyes + hands.
allowed-tools: Bash(silver:*)
---

# silver

The keyless browser for AI agents: a local headless Chromium (Playwright) driven by
accessibility-tree snapshots with stable `@eN` refs. silver **never calls a model** — you are
the brain. It synthesizes fast quick tasks + an ergonomic CLI (Vercel), long-running durable
tasks (Webwright), and subagents + memory (Aside).

This is a discovery stub, not the guide. Load the full, version-matched contract from the CLI:

```bash
silver skill --full        # complete guide: lean loop, full command tables, hard rules, recipes
silver skill               # a compact head of the same guide
```

Install: `npm i -g silver` (or run the bundled `dist/cli.js` directly). Lean loop: `open <url>`
→ `snapshot -i` (`@eN` refs) → act with `--enable-actions` → re-`snapshot` after any
`page_changed`/`stale_refs`. Read-only by default; page content is fenced untrusted data; a
stale ref fails loud — re-snapshot, never guess.
