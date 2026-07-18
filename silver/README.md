# agent-silver

**Silver is a browser for AI agents.** It runs a real headless Chromium on your machine and hands the
agent a compact, grounded view of the page over the shell. The agent reads that view, decides what to
do, and Silver does it. **It never calls a model itself** — no API key, no provider config, no cost of
its own. You bring the brain; Silver is the eyes and hands. Drop it into any sandbox and it just runs.

> Published to npm as **`agent-silver`** (the name `silver` was taken). The CLI command is **`silver`**
> (an `agent-silver` alias is installed too).

## Install

```bash
npm i -g agent-silver
silver version

# first run only, if Chromium isn't present yet:
npx playwright install chromium

# check the install is healthy:
silver doctor
```

Requires Node ≥ 20.

## Quickstart

```bash
silver open https://example.com
silver snapshot -i                 # the page as @e1, @e2, … interactive refs (start here)
silver get text @e1
silver --enable-actions click @e3  # actions are off by default; reading is always safe
silver extract --schema '{"links":[{"title":"string","url":"string"}]}'
silver close
```

`silver skill --full` prints the complete agent guide; `silver help` lists every verb.

## Why it's built this way

- **Reading is safe by default.** Anything that changes the page needs `--enable-actions`, and a verb
  that isn't allowed in the current mode isn't in the dispatch table at all — no prompt injection can
  talk Silver into running it.
- **Grounded, never hallucinated.** The agent acts on stable element ids (`@e1`, `@e2`, …) from the
  accessibility tree, not pixels or model-written selectors. `extract` returns element ids, so the
  model literally can't hand you a URL that wasn't on the page.
- **Completion is verified, not claimed.** `task criteria` pre-commits grounded `expect` predicates and
  `task done` refuses unless every one passes live — an un-gameable, keyless done-signal.
- **Long tasks survive a crash.** `silver task` records a run to a folder (plan, action log,
  checkpoints) and compiles it into a re-runnable script; another agent picks up from `task resume`.
- **Real logins, no leaked secrets.** Drive your real Chrome profile with `--profile`, or pass a
  domain-scoped `--secret NAME@host=…` that resolves only at the actuation choke point — the value
  never enters the agent's context. Unscoped secrets are fail-closed by default.

## Parallel agents & durability

Give each agent its own `--session` (its own browser) or a `--tab` in a shared one; `--namespace` keeps
whole groups apart; `connect` attaches to a browser something else launched. `--restore` keeps a
logged-in session alive across a daemon crash. Read-only by default, egress-guarded, redacting,
prompt-injection-neutralizing throughout.

## Links

Full docs, source, and issues: <https://github.com/LeventySeven/silver>. MIT licensed.
