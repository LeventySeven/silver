# ev-distribution: install-and-use reality, tested live in this sandbox

Scope: can a sub-agent, in a fresh sandbox, get + run each option with **zero
config**? Tested live (cargo/npm/uv all available in this environment,
2026-07-15). All facts anchored to files read or commands actually run — not
opinions.

## Facts

### Rust — `silver` (fork of Vercel `agent-browser`)

- **Intended distribution model is prebuilt-binary-via-npm**, esbuild-style:
  `bin/silver.js` is a Node dispatcher that `spawn()`s a platform binary
  (`agent-browser-{darwin,linux,linux-musl,win32}-{x64,arm64}[.exe]`)
  (`/Users/seventyleven/Desktop/Silver/silver/bin/silver.js:31-66`).
  `scripts/postinstall.js` downloads that binary from GitHub Releases at
  install time and — on global installs — rewrites the npm symlink/shims to
  point straight at the native binary for zero-overhead execution
  (`/Users/seventyleven/Desktop/Silver/silver/scripts/postinstall.js:52-56`).
- **That download points at the wrong, non-Silver repo.** `GITHUB_REPO =
  'vercel-labs/agent-browser'` is hardcoded
  (`scripts/postinstall.js:56`), and root `package.json`'s `repository.url`
  is still `git+https://github.com/vercel-labs/agent-browser.git`
  (`/Users/seventyleven/Desktop/Silver/silver/package.json:24-27`). README
  install instructions likewise say `npm install -g agent-browser` /
  `cargo install agent-browser` / `brew install agent-browser`
  (`/Users/seventyleven/Desktop/Silver/silver/README.md:14,32,39`) — none of
  this is rebranded to Silver.
- **The npm name `agent-browser` is not available** — verified live:
  `npm view agent-browser versions` returns a real, actively published
  package up to `0.31.2`, `repository.url` = `vercel-labs/agent-browser`.
  Silver's own `package.json` also declares `"name": "agent-browser"`,
  version `0.1.0` — publishing as-is would either collide with the real
  Vercel package or require a rename across README/package.json/postinstall
  before Silver could ever npm-publish itself.
- **No prebuilt binaries exist on disk.** `bin/` contains only `silver.js`
  (verified via `ls`); a sub-agent installing today gets no binary from the
  (broken) postinstall path and must build from source.
- **Cold build cost, measured**: `cli/Cargo.lock` locks 332 crates
  (`grep -c '^name = ' Cargo.lock`). A **warm** `cargo check` (target dir
  already had a 5.4 GB build cache from prior sessions, confirmed via `du -sh
  target` and `.fingerprint` mtimes) still took 31.8s wall / 66s CPU. A true
  cold build (empty `~/.cargo/registry`, empty `target/`) would be
  materially slower — this sandbox's `~/.cargo/registry` is already 563 MB,
  so even the crate-download cost was not measured cold here.
- **Runs cleanly once built.** The compiled debug binary
  (`cli/target/debug/silver`) executes zero-config: `silver doctor` finds
  system Chrome automatically (`Google Chrome 150.0... at
  /Applications/Google Chrome.app/...`), reports no daemons, and needs no
  API key for core function — provider keys (Browserless, Browserbase, AI
  Gateway, etc.) are all optional/"info" not "fail." Chrome itself installs
  separately into `~/.silver/browsers` via `install.rs` (own bespoke
  downloader, not Playwright's).
- **Prerequisite**: Rust toolchain (`cargo`, `rustc`) must be present, or the
  postinstall binary-fetch must actually work. Neither is guaranteed
  zero-config in a generic sandbox unless Rust is pre-installed.

### TypeScript — `moxxie` (`skill/agent-browser`)

- Package name is `moxxie`, not `agent-browser`
  (`/Users/seventyleven/Desktop/Silver/skill/agent-browser/package.json:2`).
  Verified live: `npm view moxxie` → 404, i.e. the name is free to publish,
  unlike Rust's `agent-browser` collision.
- **Ships prebuilt.** `dist/cli.js` (154 lines, `#!/usr/bin/env node` shebang)
  is checked into the tree and runs immediately with plain `node
  dist/cli.js` — verified live, `--help` returns valid JSON instantly, no
  build step needed for a consumer.
- Single runtime dependency: `"playwright": "^1.61.0"`
  (`package.json:20-22`). `node_modules` already present, 67 MB
  (`du -sh node_modules`).
- Browser provisioning piggybacks on Playwright's own downloader (`playwright
  install`), the same mechanism `webwright` uses — shared cost, not
  bespoke code to maintain.
- Prerequisite: Node ≥24 (`engines.node`, `package.json:14-16`) — a single,
  ubiquitous runtime most sandboxes already have or can `apt/brew install`
  in one step; no compiler toolchain needed.

### Python — `webwright` (`reference/webwright`)

- Installed live with `uv`: `uv venv` (0.1s) + `uv pip install -e .`
  (5.0s wall, pulling 27 packages including `playwright==1.61.0`,
  `typer`, `pydantic`, `rich`, `httpx`) — the fastest of the three installs
  measured in this sandbox, largely because `uv`'s cache (`~/.cache/uv`,
  4.7 GB) was already warm.
- CLI works immediately after install: `webwright --help` exits 0.
- **`webwright doctor` fails zero-config**, run live:
  `3/6 checks passed` — `Chromium: FAIL` (playwright browsers not yet
  downloaded/on PATH in the fresh venv — needs a separate `playwright
  install` step, same as TS/moxxie) and, more importantly,
  **`OpenAI Key: FAIL — OPENAI_API_KEY missing`**
  (`src/webwright/run/doctor.py` check + live output). Webwright's own
  doctor treats a model API key as a required check, and the source tree
  has `models/anthropic_model.py`, `models/openrouter_model.py`, and
  `config/model_openai.yaml` — i.e., upstream Webwright is built to call a
  model itself, which conflicts with Silver's "100% keyless, host LLM is
  the brain" mandate. Silver would have to strip/bypass this, not just
  install it, to satisfy criterion (f).
- Prerequisite: Python ≥3.10 (`pyproject.toml:8`) + `playwright install`
  browser download (same as TS).

### Shared cost across TS and Python: the Playwright browser download

- Both `moxxie` and `webwright` depend on `playwright`'s own browser
  provisioning. Verified live via `python -m playwright install --dry-run
  chromium`: downloads Chrome for Testing 149.x + Chrome Headless Shell +
  ffmpeg from `cdn.playwright.dev`, installed into
  `~/Library/Caches/ms-playwright/` (already warm in this sandbox from prior
  activity — `chromium-1228` etc. present). This is a real, non-trivial
  download (typically ~150–300 MB for Chromium alone) that is a **shared,
  one-time cost identical for both TS and Python** — not a differentiator
  between them. Silver's Rust path pays an equivalent cost via its own
  `install.rs` downloader into `~/.silver/browsers`.

## Pros / Cons

| | Rust (silver) | TypeScript (moxxie) | Python (webwright) |
|---|---|---|---|
| Pros | Zero-overhead native binary once built; no interpreter; runs zero-config with no API key required (verified: `silver doctor` all-pass on core checks) | Ships prebuilt (`dist/cli.js` checked in) — instant run, no compile; npm name (`moxxie`) is free to publish; single light dependency (playwright) | Fastest raw package install measured (5s via uv); no compile step; small, ordinary Python dependency graph |
| Cons | npm package name `agent-browser` is **already taken by the real upstream Vercel package** (verified live, v0.31.2) — cannot publish as-is; postinstall script downloads binaries from `vercel-labs/agent-browser`'s GitHub releases, not a Silver-owned release — currently broken/mis-branded; no prebuilt binaries in the repo today, so a fresh sandbox must compile 332 crates from source (needs `cargo`/`rustc` present) | Needs Node ≥24 runtime present; still needs the shared Playwright browser download step | Doctor's own health check treats an LLM API key as required (`OPENAI_API_KEY missing` = FAIL) — upstream Webwright is not keyless by default and calls a model itself (`models/anthropic_model.py`, `models/openrouter_model.py`); needs Python ≥3.10 + separate `playwright install` |

## Relevance to the 9 criteria (install/distribution-relevant subset)

- **(e) zero-config install-and-use**: TS (`moxxie`) is the only one that is
  *actually* zero-build today — prebuilt `dist/cli.js` runs instantly, clean
  npm namespace. Rust's *design* (prebuilt binary via npm postinstall) is the
  right shape for zero-config but is currently non-functional/mis-branded
  (wrong GitHub repo, colliding npm name) and would require real
  re-plumbing (own GitHub releases, own npm name, fixed `postinstall.js`)
  before it could match TS's install experience. Python installs fastest
  raw but its `doctor` fails zero-config out of the box on the API-key
  check, which is a design mismatch, not just friction.
- **(f) keyless**: Directly threatened by webwright's own doctor check
  (`OPENAI_API_KEY missing` = FAIL) and its `models/` directory calling
  Anthropic/OpenAI/OpenRouter directly — adapting Webwright's task-runner
  pattern into Silver means deleting/bypassing that model-calling layer, an
  extra integration cost not present for silver or moxxie (neither has any
  API-key-required check in their doctor/health output).
- **(a) install-and-use with zero config generally**: cross-platform
  prerequisite burden ranks Node (TS) as lowest-friction (one ubiquitous
  runtime, no compiler), Python (webwright) close behind (one runtime +
  uv/pip), Rust (silver) highest today given the broken binary-download path
  — until that's fixed, a sub-agent without a pre-warmed cargo registry pays
  a real multi-crate compile cost that neither of the other two incurs.

## Caveats

- Cold-build timing for Rust was not fully isolated — `~/.cargo/registry`
  (563 MB) and `target/` (5.4 GB) were both already warm from prior session
  activity in this sandbox, so the measured 31.8s `cargo check` understates
  a genuinely cold build's cost; I did not clear caches to get a true
  from-scratch number (would have been destructive to the shared
  environment).
- Did not test actual `npm publish`/`pip publish` flows or CI cross-compile
  jobs (`build:linux`, `build:windows` via Docker) — only what's verifiable
  from source + live local commands.
- Playwright browser-download size was read from the `--dry-run` manifest
  URLs, not measured by an actual fresh download in this sandbox (cache was
  already warm).
