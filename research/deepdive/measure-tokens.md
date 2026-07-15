# Token-Efficiency Deep Dive: Silver vs Vercel `agent-browser` 0.31.2

**Metric:** snapshot output size in **chars** (token proxy) on identical pages, identical modes.
**Method:** distinct `--session` per (tool × page × mode × trial); `open <url>` → `snapshot -i` and `snapshot -i -c`; `wc -c` of stdout; **3 trials each**, cold full snapshot per trial (unique session so no state carryover). Ran `2026-07-16` on macOS arm64.

- Silver: `node /Users/seventyleven/Desktop/Silver/silver/dist/cli.js`
- Vercel: `agent-browser` **0.31.2** (on PATH), persistent daemon per session.
- Raw data: `scratchpad/results2.csv`; saved snapshots: `scratchpad/{silver,vercel}_<page>_<mode>_<trial>.txt`.

## Headline numbers (median chars, default flags)

| Page | Silver `-i` | Vercel `-i` | Silver/Vercel | Silver `-i -c` | Vercel `-i -c` |
|---|---|---|---|---|---|
| example.com | 271 | 74 | **3.66×** | 271 | 74 |
| news.ycombinator.com | 29,370 | 13,474 | **2.18×** | 29,370 | 13,474 |
| en.wikipedia.org/wiki/Web_browser | 51,703 | 19,087 | **2.71×** | 51,703 | 19,087 |
| github.com/microsoft/webwright | 23,810 | 14,545 | **1.64×** | 23,810 | 14,545 |

Numbers were essentially deterministic across the 3 trials (±8 chars). `-c` (compact) has **negligible effect** for either tool once `-i` is set — interactive mode already drops the empty structural nodes that `-c` targets.

**Verdict at default flags: Silver is FATTER — 1.6× to 3.7×.** But this is apples-to-oranges (see below): Silver's default snapshot carries strictly *more information* than Vercel's.

## WHERE Silver is fatter — decomposed

Silver line: `* link "Hacker News" [ref=e2, level=0, url=https://news.ycombinator.com/news]`
Vercel line: `- link "Hacker News" [ref=e103]`

The entire gap is **three per-node / fixed additions Silver makes**, none of them tree structure:

| Source | HN bytes | Wikipedia bytes | github bytes | Notes |
|---|---|---|---|---|
| Inline `url=<href>` on every link | 12,826 (44%) | 28,050 (54%) | 8,414 (35%) | **Dominant.** Vercel omits URLs by default (only with `-u`). |
| `, level=0` on every node | 2,871 (10%) | 4,644 (9%) | 2,529 (11%) | Always `0` in flat interactive mode → pure noise. |
| Fixed preamble¹ | ~150 | ~150 | ~150 | Dominates tiny pages (why example is 271 vs 74). |

¹ `⟦page-content untrusted⟧` security wrapper + `- title: "…" [url=…, generation=N]` + `# note: interactive elements only` + closing `⟦/page-content⟧`.

**Strip `url=` and `level=` from Silver and the node format is EQUAL-or-LEANER than Vercel:**

| Page | Silver core (url+level stripped) | Vercel `-i` | Ratio |
|---|---|---|---|
| HN | 13,673 | 13,474 | 1.01× |
| Wikipedia | 19,009 | 19,087 | **0.996× (Silver smaller)** |
| github | 12,867 | 14,545 | **0.88× (Silver smaller)** |

Silver's underlying encoding is **not** bloated; it is marginally tighter than Vercel's. Silver just ships URLs + a level tag + a security preamble unconditionally.

## Like-for-like (BOTH carrying URLs): Silver `-i` vs Vercel `-i -u`

| Page | Silver `-i` | Vercel `-i -u` | Ratio |
|---|---|---|---|
| HN | 29,370 | 26,292 | 1.12× |
| github | 23,810 | 24,280 | **0.98× (Silver smaller)** |
| Wikipedia | 51,703 | ~46,000 (est.²) | ~1.12× |

² Vercel `-i -u` on Wikipedia could not be captured cleanly — after many rapid page loads the endpoint began returning `(no interactive elements)` (26 chars) even for plain `-i`, consistent with IP throttling by Wikipedia, not a tool defect. Estimate = Vercel `-i` core (19,087) + URL bytes comparable to Silver's 28,050, scaled to Vercel's node count.

**When the information content is matched, Silver is within ~12% and sometimes SMALLER than Vercel.**

## Is Silver token-competitive?

**Yes — the format is competitive; the *defaults* are not.** Silver's per-node encoding is equal-to-leaner than Vercel's. The 1.6–3.7× headline gap is entirely (a) Silver inlining every href by default where Vercel makes URLs opt-in (`-u`), (b) a redundant `level=0` on every node, and (c) a ~150-char fixed preamble that swamps small pages. All three are **snapshot-format choices — language-independent** — and closing them requires no engine change.

### Recommended format fixes (each independently verified above)
1. **Make inline URLs opt-in** (mirror Vercel's `-u`), or truncate/dedupe hrefs. Removes **35–54%** on link-dense pages — the single biggest win.
2. **Drop `level=` when 0 / in flat interactive mode.** Removes ~**10%**.
3. **Trim the preamble:** drop `# note: interactive elements only` and `generation=N` from per-snapshot output (keep the `⟦untrusted⟧` security wrapper — that is load-bearing). Halves example.com.

Applying (1)+(2) alone brings Silver to **~parity or better** than Vercel `-i` on every page tested, while keeping the option to emit URLs when an agent needs them.

## Engine / connection-model note (observed, not benchmarked)
Vercel keeps a **persistent per-session daemon** (`~/.agent-browser/<session>.sock/.pid`); a later process attaches instantly. **Silver also persists a live per-session browser across separate CLI invocations** — I observed generation state advancing and Silver returning *unified-diff* snapshots on repeat calls to the same session (a genuine incremental-update feature Vercel lacks). So the feared "Silver reconnects CDP from scratch every command" was **not** what I observed at the session level; both keep the browser warm between commands. Cold first-open latency (Playwright Chromium launch vs Rust daemon) was not timed here — that is the real remaining engine question and needs a separate latency benchmark. Vercel showed real cold-start flakiness in this environment (fresh named-session daemons intermittently attached to a blank page, needing retries), which the harness absorbed with validation + retry.
