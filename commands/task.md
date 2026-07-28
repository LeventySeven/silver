---
description: Run a long, crash-surviving browser task recorded in a durable run folder.
argument-hint: <goal>
---

# Long, crash-surviving browser task

Load the guide (`silver skill --full`, or read `skill-data/core/reference/tasks.md`), then run
the durable run-folder flow for: **$ARGUMENTS**

`silver task start "<goal>" --id <id>` → fill `plan.md` Critical Points → drive THROUGH the task
so every step logs: `silver task exec <id> --enable-actions -- <silver-cmd> --session <s>` (flags
go BEFORE the `--`) → `silver task checkpoint <id> --note "…"` at milestones. After a crash a
fresh agent runs `silver task resume <id>` to pick up. The run folder IS the durable artifact.
