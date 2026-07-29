---
description: Hand back a preview URL silver has itself loaded and status-checked — never an unproven link.
argument-hint: [route]
---

# Proven preview link

Load the guide (`silver skill --full`, or read `skill-data/core/SKILL.md`), then prove the
route: **$ARGUMENTS**

**Invariant: silver never hands over a URL it has not itself loaded.** On failure, name the
failure mode and return NO link.

silver has no git and spawns nothing but Chromium, so steps 1–2 are YOUR Bash, not silver's:

1. Resolve the identity yourself: `git rev-parse --abbrev-ref HEAD` and `git rev-parse --short HEAD`.
2. Start or verify the dev server yourself (or take the deployment URL from your deploy tool).
3. **Rewrite `http://127.0.0.1:PORT` / `http://0.0.0.0:PORT` to `http://localhost:PORT`** — the
   egress guard hard-blocks a loopback IP literal and `--allowed-domains` cannot lift it.
4. `silver open <url><route> --session preview --json` and READ `data.status`. While the envelope
   is `navigation_failed` the server is not up yet — retry with backoff. STOP if `status >= 400`
   (`http_error`), or if `auth_required` / `captcha_detected` / `page_empty` is set: a 200 at the
   final hop can still be a login wall or a blank shell, so the number alone is not proof.
   `status: null` means NOT OBSERVED (a same-document/hash nav) — never read it as 200.
5. `silver wait --ready --session preview`, then `silver screenshot <path> --session preview`.
6. Return URL + screenshot path + branch + SHA together — or, if any check failed, say which one
   (server not running / wrong host / route 404 / auth wall / timeout) and hand back no link.
