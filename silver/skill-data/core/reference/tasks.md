# silver — Long-running tasks (the run folder is the durable artifact)

A `task` records a replayable *run folder* so a long job survives a crashed agent. silver
writes scaffold only — YOU drive the browser and fill the plan. The value is durability: a
fresh agent can pick up mid-flow from what the folder recorded.

## Contents
1. The run-folder anatomy
2. The task command surface
3. `task exec` flag order (do exactly this)
4. Resume after a crash
5. Anti-drift: `--echo-plan`
6. Host-run verification protocol (keyless — your model)
7. When to reach for a task (and when not to)

Full worked transcript: `examples.md §6`.

---

## 1. The run-folder anatomy

`task start` creates `~/.silver/[<ns>/]tasks/<id>/run_N/` containing:

- **`plan.md`** — a Critical-Points checklist you fill in. Progress is counted from checked
  items (`task status` reports total/checked/remaining).
- **`action_log.jsonl`** — append-only event log. `task exec` auto-appends every command it
  runs; `task log` appends a custom event.
- **`screenshots/`** — best-effort captures written by `task checkpoint`.
- **`checkpoint.json`** — the latest checkpoint (progress + note + screenshot ref).

Each `task start` opens a new `run_N` under the same id, so re-running keeps prior runs intact.

---

## 2. The task command surface

| Command | What it does |
|---|---|
| `task start <goal> [--id <id>]` | Create the run folder + scaffold. |
| `task exec <id> [--enable-actions] [--echo-plan] -- <silver-cmd…>` | Run a silver command threaded to the task's session AND auto-append it to the log. Actor sub-op. |
| `task log <id> <event-json>` | Append a custom event. |
| `task checkpoint <id> [--note "<t>"]` | Snapshot progress + a best-effort screenshot. |
| `task status <id>` | Plan progress, log size, latest checkpoint. |
| `task resume <id>` | Latest checkpoint + remaining plan + recent log tail. |
| `task list` | All tasks in the namespace. |
| `task compile <id>` | Compile the run into `run_N/compiled.sh` (+ `replay_cache.json`) — a re-runnable script with detected parameters (override any via its env var). |
| `task replay <id> [<current-dom-hash>]` | Replay the compiled script; the optional DOM-hash lets the per-step gate detect a changed page and re-resolve. |

---

## 3. `task exec` flag order (LOW freedom)

Put `--enable-actions` **BEFORE** the `--`. Everything after the `--` is the inner silver
command, verbatim.

```
silver task exec <id> --enable-actions -- open https://airline.example --session flight
silver task exec <id> --enable-actions -- click @e5 --session flight
```

Flags placed after the `--` are passed to the inner command, so a misplaced `--enable-actions`
never reaches the exec gate and the inner actor verb is refused.

---

## 4. Resume after a crash

After a crash, a fresh agent runs `task resume <id>` and receives the latest checkpoint, the
remaining plan items, and a recent log tail — enough to continue driving from where the last run
stopped. The run folder IS the state; nothing lives only in the crashed agent's context. Drive
the same session name the task threaded (or re-`open` it) and keep logging via `task exec`.

---

## 5. Anti-drift: `--echo-plan`

On a long `task exec` loop your own context rots — the original goal scrolls out of the window.
`--echo-plan` appends the current `plan.md` checklist (open items first) plus the original goal
to each `task exec` envelope, so the goal stays in front of you every step without a separate
`task status` round-trip. Opt-in and cheap; reach for it on any loop long enough that you'd
otherwise re-read the plan by hand.

---

## 6. Host-run verification protocol (keyless — YOUR model, not silver's)

silver never judges whether the goal was met — it only guarantees the *evidence* exists on disk
(checkpoints, screenshots, `action_log.jsonl`). Completion is **your** call, and here is the
two-stage rubric to make it honestly:

1. **Per-checkpoint pass.** For each checkpoint screenshot / recorded state, score it **harshly
   1–5** with a one-line reason. Be a critic, not a cheerleader — a 5 means the checkpoint's
   Critical Point is unambiguously satisfied in the evidence, not "looks plausible."
2. **Aggregate pass.** One final pass over ALL the evidence + the action log, ending its output
   with a trailing line that is exactly `Status: success` or `Status: failure`.

**Parse it defensively:** take the **LAST** `Status:` line in the output; if none parses, **treat
it as FAIL**. Abstain rather than hallucinate — insufficient evidence is a *failure*, not a pass.
This is the doc half of the honest-completion gate: silver checks that the artifacts are there;
you check that they actually show the goal was reached. It stays keyless because the judgement is
run by your model, never by silver.

---

## 7. When to reach for a task (and when not)

Reach for a task the moment a job **can crash mid-flow** and you'd want to resume rather than
restart — multi-step purchases, long scrapes, anything that mutates remote state in stages. For
a one-shot read or a single form submit, the plain lean loop is lighter; a task's logging
overhead only pays off when durability matters.
