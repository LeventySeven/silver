---
description: Extract structured records (with real links) from a page, keyless and hallucination-proof.
argument-hint: <what-to-extract>
---

# Structured, hallucination-proof extraction

Load the guide (`silver skill --full`, or read `skill-data/core/reference/extract.md`), then
extract: **$ARGUMENTS**

Two-call handshake: `silver extract --schema '<json>' --instruction "<specific ask>" --session s`
returns a bundle (ID-transformed schema + prompt + a snapshot whose links carry element IDs, not
URLs). YOU infer over the bundle and pick IDs, then `silver extract resolve --ids '<json>'` maps
IDs → real values. You never see a real URL, so you cannot emit a hallucinated one. Write a
SPECIFIC `--instruction` — it is a prompt for your own downstream pass. Resolve is
generation-gated: re-snapshot between extract and resolve → `ref_stale`, so re-extract. Object
schemas auto-wrap to `list[T]` — return every match as an array.
