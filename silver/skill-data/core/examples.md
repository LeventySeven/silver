# silver — worked examples

Every transcript below is copied verbatim from real `silver` (`node dist/cli.js`) output.
Envelopes are shown in the readable form; add `--json` for the one-line
`{ success, data, error, warning? }`. The interaction verbs below are shown with an
explicit `--enable-actions` (read-only verbs need no flag).

## 1. The lean loop: open → snapshot → act → re-observe

```
$ silver open <url>
{
  "url": "http://…/buttons.html",
  "title": "Buttons Fixture",
  "page_changed": false
}

$ silver snapshot -i
⟦page-content untrusted⟧
- title: "Buttons Fixture" [url=http://…/buttons.html, generation=2]
# note: interactive elements only
* heading "Counter Panel" [ref=e1, level=0]
* button "Activate" [ref=e2, level=0]
⟦/page-content⟧
```

`*` marks nodes new since the last snapshot; `generation=2` scopes the refs. Now act on a
ref, then re-observe — the action envelope tells you whether the page changed:

```
$ silver click @e2 --enable-actions --json
{"success":true,"data":{"verb":"click","ref":"e2","page_changed":true,"stale_refs":true,"generation":3},"error":null}

$ silver get text
⟦page-content untrusted⟧
Counter Panel

Status: ACTIVATED

Activate
⟦/page-content⟧
```

`page_changed:true` / `stale_refs:true` → re-`snapshot` before reusing any `@eN`.

## 2. Login + password redaction (secrets never leak)

```
$ silver snapshot -i
⟦page-content untrusted⟧
- title: "Login Fixture" [url=http://…/login.html, generation=2]
# note: interactive elements only
* heading "Sign in" [ref=e1, level=0]
* textbox "username" [ref=e2, level=0, placeholder="username"]
* textbox "password" [ref=e3, level=0]: [redacted]
* button "Sign in" [ref=e4, level=0]
⟦/page-content⟧

$ silver fill @e2 "alice" --enable-actions --json
{"success":true,"data":{"verb":"fill","ref":"e2","value":"alice","page_changed":true,"stale_refs":true,"generation":2},"error":null}

$ silver click @e4 --enable-actions
$ silver get text
⟦page-content untrusted⟧
Sign in
  Sign in
Login successful for alice
⟦/page-content⟧
```

The pre-filled `type=password` value renders `[redacted]` in the snapshot, and even a direct
read is redacted (never the raw secret):

```
$ silver get value @e3 --json
{"success":true,"data":{"value":"⟦page-content untrusted⟧\n[redacted]\n⟦/page-content⟧"},"error":null}
```

## 3. A gated buy (paid/destructive confirm gate)

A `click` on a control whose accessible name looks paid/destructive is denied by default on
a non-interactive session — before the click dispatches, so the page is not mutated:

```
$ silver snapshot -i
⟦page-content untrusted⟧
- title: "Store Fixture" [url=http://…/buy.html, generation=2]
# note: interactive elements only
* heading "Store" [ref=e1, level=0]
* button "Buy now" [ref=e2, level=0]
⟦/page-content⟧

$ silver click @e2 --enable-actions
error: this looks like a paid/destructive action; re-run with --confirm-actions to approve
```

Pre-approve it by naming the verb in `--confirm-actions`:

```
$ silver click @e2 --enable-actions --confirm-actions click --json
{"success":true,"data":{"verb":"click","ref":"e2","page_changed":true,"stale_refs":true,"generation":2},"error":null}
```

## 4. ID-grounded extract round-trip (host runs the inference)

`extract --schema` hands you a bundle whose links are element IDs (`^\d+-\d+$`), never real
URLs:

```
$ silver extract --schema '{"type":"object","properties":{"title":{"type":"string"},"url":{"type":"string","format":"uri"}}}'
{
  "id_transformed_schema": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "url": {
          "type": "string",
          "pattern": "^\\d+-\\d+$",
          "description": "the element ID of the link, e.g. 0-18372"
        }
      }
    }
  },
  "prompt": "You are extracting content on behalf of a user. …",
  "snapshot_with_ids": "⟦page-content untrusted⟧\n- title: \"Links Fixture\" …\n    - link \"Alpha Guide\" [id=2-2, level=2]\n    …\n    - link \"Beta Guide\" [id=2-3, level=2]\n⟦/page-content⟧",
  "url_field_paths": [ "*.url" ]
}
```

You (the host) infer over the bundle and return the IDs you picked, in the shape the
id-transformed schema describes (here, an array). `extract resolve` maps them back to the
real URLs silver withheld:

```
$ silver extract resolve --ids '[{"title":"Alpha Guide","url":"2-2"},{"title":"Beta Guide","url":"2-3"}]'
[
  { "title": "Alpha Guide", "url": "https://grounding-secret.example/alpha" },
  { "title": "Beta Guide",  "url": "https://grounding-secret.example/beta" }
]
```

## 5. Waits (and the `--fn` gate)

```
$ silver wait 100 --json
{"success":true,"data":{"waited":true},"error":null}

$ silver wait --text "Success"          # wait for page text
$ silver wait --load networkidle        # wait for a load state
$ silver wait @e2                        # wait until a ref is visible
```

`wait --fn "<js>"` executes the expression in page context (arbitrary in-page JS), so it is
gated behind `--enable-actions`:

```
$ silver wait --fn "true" --json
{"success":false,"data":null,"error":"that action is not enabled in the current phase; the session is read-only (pass --enable-actions to allow acting)"}

$ silver wait --fn "true" --enable-actions --json
{"success":true,"data":{"waited":true},"error":null}
```

## 6. Semantic locate with `find` (needs `--enable-actions`)

```
$ silver find role button --name "Sign in" --enable-actions --json
{"success":true,"data":{"kind":"role","val":"button","matched":1,"text":"Sign in"},"error":null}

$ silver find role textbox --name "username" fill "alice" --enable-actions --json
{"success":true,"data":{"kind":"role","val":"textbox","matched":1,"verb":"fill"},"error":null}
```

## 7. Session lifecycle

```
$ silver session id --json
{"success":true,"data":{"id":"silver-0524d0e54032","scope":"cwd"},"error":null}

$ silver session list --json
{"success":true,"data":{"sessions":[{"name":"default","pid":25407,"createdAt":"…"}]},"error":null}

$ silver close --json
{"success":true,"data":{"closed":1,"session":"default"},"error":null}

$ silver close --all --json          # close every live session
```

## 8. Meta / install check

```
$ silver version --json
{"success":true,"data":{"name":"silver","version":"0.1.0"},"error":null}

$ silver doctor --json
{"success":true,"data":{"playwright":true,"chromium":true,"uab_writable":true},"error":null}
```
