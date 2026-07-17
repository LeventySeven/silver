# Silver

Silver is a browser for AI agents. It runs a real headless Chromium on your machine and hands the
agent a compact, grounded view of the page over the shell. The agent reads that view, decides what to
do, and Silver does it. It never calls a model itself. You bring the brain; Silver is the eyes and hands.

That "never calls a model" part is the whole point. Silver has no API key, no provider config, no cost
of its own. Drop it into any sandbox and it just runs.

## How it works

When you `open` a page, Silver spawns a detached Chromium and leaves it running. Every command after
that reconnects to the same browser over CDP, so your tabs, cookies, and page state stick around
between calls. `--headed` shows the window if you want to watch. Give each agent its own `--session`
and it gets its own browser; `--namespace` keeps whole groups of agents apart; `connect` attaches to a
browser something else already launched.

The agent doesn't look at screenshots. It reads the accessibility tree, which is a compact, structured
version of the page with a stable id (`@e1`, `@e2`, ...) on every element worth touching. That's
cheaper than pixels and far less ambiguous. Screenshots are there for when you actually need to see
something, not as the default.

## What you can do

```bash
silver open https://example.com
silver snapshot -i                 # the page as @e1, @e2, ... refs
silver get text @e1
silver --enable-actions click @e3  # actions are off by default; reading is safe
silver extract --schema '{"links":[{"title":"string","url":"string"}]}'
silver close
```

A few things worth calling out:

**Reading is safe by default.** Anything that changes the page needs `--enable-actions`. And a verb
that isn't allowed in the current mode isn't just discouraged, it isn't in the dispatch table at all,
so no amount of clever prompt injection can talk Silver into running it.

**Extraction can't hallucinate a URL.** When you `extract`, links come back as element ids, not text
the model wrote. You resolve the id to the real href afterward. The model literally can't hand you a
URL that wasn't on the page.

**Long tasks survive a crash.** `silver task` records a run to a folder (plan, action log, checkpoints)
and can compile it into a re-runnable script. If the agent dies halfway, another one picks up from
`task resume`.

**Real work needs real logins.** Point Silver at your actual Chrome profile with `--profile`, generate
MFA codes with the built-in TOTP helper, or fill a `<secret>NAME</secret>` token that resolves the
credential server-side so it never lands in the agent's context. For targets gated behind a custom
header or an HTTP Basic Auth wall, `set headers` (Bearer, `X-Api-Key`, `x-vercel-protection-bypass`)
and `set credentials` both take the same `<secret>` tokens, so nothing sensitive touches the agent
or the disk.

## Install

The npm name `silver` is already taken, so it installs from GitHub.

```bash
# Run it once without installing (prints the full agent guide):
npx github:LeventySeven/silver skill --full

# Install the CLI:
npm i -g github:LeventySeven/silver
silver version

# Drop the skill into your project:
npx github:LeventySeven/silver skill install

# First-time browser download (Playwright usually handles this on install):
npx playwright install chromium
```

From source:

```bash
git clone https://github.com/LeventySeven/silver.git
cd silver/silver          # the package lives in the silver/ subdir
pnpm i && pnpm build
npm link
```

## Why TypeScript, not Rust

I went back and forth on this and ended up running the argument out to a panel of independent judges to
settle it. TypeScript won, and the reason is boring and durable: Playwright is native to Node.
Auto-wait, the selector engine, network interception, the browser downloads are all maintained upstream
by Playwright's own team. Rust has to hand-roll the CDP protocol and own that maintenance forever.

The usual case for Rust is speed. But the token cost of driving a browser has nothing to do with the
CLI's language; it comes from how compact the page view is, and that's the same in any language. The
one place Rust was genuinely faster turned out to be a bug in ours: we were running a network-idle wait
on read commands that didn't need it. Fixing that dropped a warm snapshot from 1.45s to 0.23s. The
language was never the bottleneck.

## Status

575 tests, an eval suite that passes, and a lethal-trifecta security check that passes, all on every
commit. Keyless. No MCP.

## License

MIT.
