---
name: silver
description: Use when an agent must navigate, read, click, fill, or extract data from a live web page via a local headless browser — keyless (no model calls), standalone or chained with other CLIs. The host is the brain; silver is grounded eyes + hands.
allowed-tools: Bash(silver:*)
---

# silver

Keyless browser automation: a local headless Chromium (Playwright) driven by
accessibility-tree snapshots with stable `@eN` refs. silver never calls a model — you are
the brain.

This is a discovery stub, not the guide. Load the full, version-matched contract from the CLI:

```bash
silver skill --full        # complete guide: lean loop, command tables, hard rules
silver skill               # a compact head of the same guide
```

Install: `npm i -g silver` (or run the bundled `dist/cli.js`). Lean loop: `open <url>` →
`snapshot -i` (`@eN` refs) → act with `--enable-actions` → re-`snapshot` after any
`page_changed`/`stale_refs`. Read-only by default; a stale ref fails loud — re-snapshot.
