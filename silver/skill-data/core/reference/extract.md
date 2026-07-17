# silver — Extract (keyless, ID-grounded, hallucination-proof)

`extract` is silver's grounding moat: because you never see a real URL, you *cannot* emit a
fabricated one. It is a two-call handshake — silver hands you a bundle, YOU infer over it and
pick IDs, silver maps the IDs back to the real values it withheld. No model runs inside silver.

## Contents
1. The two-call handshake (do exactly this)
2. Why fabricated URLs are impossible
3. Writing a good `--instruction`
4. `list[T]` auto-wrapping (every match, not N→1)
5. Generation-gating and `resolve` failures

Full worked transcript: `examples.md §4`.

---

## 1. The two-call handshake (LOW freedom — one correct form)

```
silver extract --schema '<json|@file>' --instruction "<specific ask>" --session s
#   → returns a BUNDLE: { id_transformed_schema, prompt, snapshot_with_ids, url_field_paths }
#   YOU infer over the bundle and choose element IDs (^\d+-\d+$), NOT real URLs.
silver extract resolve --ids '<json|@file>' --session s
#   → maps the IDs you chose back to the real values silver withheld.
```

Pass `resolve --ids` in the **same shape** the transformed schema describes (an array when the
schema is an array). **Do not re-snapshot between `extract` and `resolve`** — resolve is
generation-gated and will fail `ref_stale`.

---

## 2. Why fabricated URLs are impossible

Every URL-bearing field (`url` / `href` / `link`, or a field with `format:"uri"`) is swapped
for an ID field constrained to the pattern `^\d+-\d+$`, and every real `url=` token is stripped
from the host-facing `snapshot_with_ids`. You only ever see IDs like `13-2`, so a URL you
"remember" cannot be emitted through this path — grounding cannot be bypassed by copying one.
`resolve` is the only door back to the real value, and it only opens for IDs that are still in
the current snapshot's value map.

---

## 3. Writing a good `--instruction`

`--instruction` is a prompt **you write for yourself to run later**, over the bundle. Be as
specific as the field — the more precise the instruction, the better your own downstream pass:

- `'the shipped price INCLUDING tax'` beats `'the price'`.
- `'each product name and its detail-page link'` beats `'the products'`.
- Name the disambiguator when the page has near-duplicates (`'the in-stock variant only'`).

It is optional; the schema alone works, but a specific instruction is the cheapest accuracy win.

---

## 4. `list[T]` auto-wrapping

An object schema is auto-wrapped in a `list[T]` (an array of that object). This **forces
returning every match**, not collapsing N results into 1 — a common silent failure. If the page
has three products and your schema is a single `{name,url}` object, the transformed schema is an
*array* of `{name,url}`, and you return all three. Resolve them as an array.

---

## 5. Generation-gating and `resolve` failures

- **Re-snapshot between extract and resolve → `ref_stale`.** The IDs are bound to the snapshot
  generation `extract` captured; a new snapshot bumps the generation and invalidates them.
  Recovery: run `extract` again for fresh IDs.
- **An ID not in the current value map → `null` + a loud warning** (never a fabricated empty
  string). Example: resolving `13-99` when only `13-2..13-5` exist returns `{"url": null}` and
  `warning: unresolved element IDs set to null: 13-99 …`. Re-snapshot and re-extract for fresh
  IDs.
