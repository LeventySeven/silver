# AgentQL / TinyFish — Source Digest

Source: `/Users/seventyleven/Desktop/researchfms/agentql/` — primarily `AGENTQL.md` (609KB main teardown, sections 3–4, 12, 18, 35) and `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md` (Tetra browser-fleet architecture, sections 5–8). 60+ SDK source files read line-by-line by the original researchers (`agentql==1.18.1` Python, `agentql@1.18.1` JS).

## Killer Insight

AgentQL's actual innovation is not "a query language" per se — it's **collapsing the entire perception problem into one mutation-and-bridge trick**: inject JS that walks the DOM, builds a compressed accessibility-tree (10–100x smaller than raw HTML), and while doing so **stamps a `tf623_id` attribute onto every live DOM element it touches**. The server only ever sees the compressed tree and returns bare integers; the client turns `tf623_id="42"` straight into `page.locator("[tf623_id='42']")`. This ID-bridge is what makes server-side reasoning (any model, any vendor) resolvable back to a concrete, clickable Playwright locator without the server ever knowing a CSS selector exists. For our CLI, the transferable idea is not "build a GraphQL clone" — it's "compress perception to an a11y-tree, assign stable per-element IDs as DOM attributes during that compression pass, and let all higher-level operations (click/type/extract) resolve through that ID" rather than through fragile selectors or re-running vision on every step.

## Patterns

### 1. Accessibility-tree-as-primary-perception (not raw DOM/HTML)
- **What**: Never send raw HTML to the model. Build a stripped semantic tree (role, name, key attributes only) via a client-side JS injection.
- **Why**: A11y tree is 10-100x smaller than HTML (500KB HTML → ~20KB tree per teardown), aligns with how screen readers already compress pages for non-visual comprehension, and is the natural input shape for an LLM reasoning about "what can I interact with."
- **How to implement**: A single injected JS function (`generateAccessibilityTree`, 383 lines in AgentQL) that recursively walks `document`, assigns `role` via a ~40-tag + ~20-input-type mapping table (fallback `"generic"`), extracts `name` from `aria-label > placeholder > alt > title > value > name` in that priority order, and prunes nodes with no role/name/children.
- **Evidence**: `AGENTQL.md:348-398` (section 3.2, line-by-line description of `generate_accessibility_tree.js`).
- **Tier**: CORE.

### 2. Stable per-element ID stamped into the DOM during the perception pass
- **What**: While walking the DOM, mutate it: write a unique `tf623_id` attribute onto every element that gets a tree node. IDs are monotonic, persist across repeated calls via a counter stored on the page object, and collisions are detected/reassigned.
- **Why**: This is the single mechanism that lets *any* downstream consumer (LLM, cache, replay log) refer to an element by a short opaque token and have it resolve deterministically back to a live locator — no re-running selector inference, no brittle nth-child paths.
- **How to implement**: `check_and_assign_tfid(node)`: read existing id attr; if missing or already in the assigned-id `Set`, mint `generate_tf_id()` (increment counter) and `node.setAttribute("tf623_id", newId)`. Counter persists on `page._impl_obj.current_tf_id` across calls so repeated queries on the same page reuse IDs.
- **Evidence**: `AGENTQL.md:355-360` (ID assignment system), `AGENTQL.md:602-609` (the `tf623_id` bridge, "the entire system hinges on this bridge").
- **Tier**: CORE.

### 3. Locator resolution = CSS attribute selector over the stamped ID, not by walking back through the tree
- **What**: `page.locator(f"[tf623_id='{tf_id}']")`. For iframes, `iframe_path` is a dot-separated chain of ids: `context.frame_locator(f"[tf623_id='{fid}']")` for each hop before the final `.locator(...)`.
- **Why**: Trivial, framework-native (works with vanilla Playwright locator retry/auto-wait semantics), and cross-iframe by construction because the ids are embedded during the same recursive pass that flattens iframes.
- **How to implement**: see full function under Command Surface below.
- **Evidence**: `AGENTQL.md:2618-2641` (`resolve_to_locator`), `AGENTQL.md:340-347` (iframe path stitching).
- **Tier**: CORE.

### 4. A small formal query DSL over the tree, not free-text prompting, as the primary interface
- **What**: A hand-rolled recursive-descent grammar: `Query ::= '{' NodeList '}'`; `Node ::= IDENTIFIER Description? (Container | List)`; leaf `IdNode` (`search_btn`), list `IdListNode` (`links[]`), nested `ContainerNode` (`footer { ... }`), `ContainerListNode` (`products[] { name price }`). Parenthetical `Description` after an identifier is optional NL hint text passed through to the server verbatim (`search_btn(the main search button)`).
- **Why**: Separates *structure* (what shape of output you want — deterministic, composable, nestable) from *semantics* (how to find/interpret it — left to the model). This buys client-side validation (duplicate-identifier detection, unclosed-brace errors) with zero network round-trip, and gives callers a predictable output schema even when page markup changes.
- **How to implement**: Lexer is character-by-character with a linked list of tokens (`prev`/`next` pointers); NEWLINE tokens exist but are ignored by lookahead (`IGNORED_TOKENS`); comma is an optional node separator; description parsing supports nested parens (`open_paren_count` depth counter) and strips wrapping quotes after extraction. Reject duplicate identifiers within the same container at parse time (`QuerySyntaxError`).
- **Evidence**: `AGENTQL.md:399-455` (3.3 full grammar + lexer + AST table), `AGENTQL.md:4690-4712` and `8171-8199` (grammar reconstructed twice, consistent).
- **Tier**: IMPORTANT — worth a lightweight equivalent, not a full clone (see anti-patterns: adoption risk is real, per AgentQL's own section 5.5).

### 5. `get_by_prompt` is just sugar over the DSL — one pattern, two entry points
- **What**: `page.get_by_prompt("the login button on the top right")` compiles to a single-field query: `{ page_element(the login button on the top right) }` — an `IdNode` named `page_element` whose *description* is the entire natural-language prompt.
- **Why**: Keeps the server-side contract to exactly one shape (parsed query + tree in, id-references out) whether the caller writes structured DSL or plain English. No separate "NL mode" server pipeline needed.
- **How to implement**: When accepting free-text locate/extract requests in a CLI, wrap them as a single-field query with the free text as the description, rather than building a parallel code path.
- **Evidence**: `AGENTQL.md:436-442` (how `getByPrompt` decomposes), `AGENTQL.md:8700-8712` ("get_by_prompt('submit button') becomes `{ page_element(submit button) }`. The description IS the prompt.").
- **Tier**: CORE (as a design principle: one query IR, prompt is sugar for a single-field query).

### 6. Query-elements vs query-data are the same pipeline, different terminal step
- **What**: `/api/v2/query` (element location, returns `tf623_id` refs to resolve to locators) and `/api/v2/query-data` (data extraction, returns plain strings) share identical request shape (`query`, `accessibility_tree`, `metadata`, `params.mode`, `request_origin`) — only the endpoint path and terminal interpretation differ.
- **Why**: One perception+matching engine serves both "find it" and "read it" — the AI task (locate the right node) is identical; only whether you resolve to a locator or extract+typecast its text differs.
- **How to implement (recommended "Approach B" from the teardown)**: two-phase — (1) run the same locate pipeline to get element refs, (2) look up each ref in the *original* tree client-side and pull its `name`/children text, applying type coercion from the description hint (e.g. `price(integer)` → strip non-digits, `int()`).
- **Evidence**: `AGENTQL.md:2685-2742` (12.7, extract_text_from_node + apply_type_constraint reference implementation), `AGENTQL.md:456-476` (shared request schema for both endpoints).
- **Tier**: IMPORTANT.

### 7. `mode: fast|standard` as an explicit cost/quality dial in every request
- **What**: `params.mode` on every query request. `fast` = default, cheaper/smaller model; `standard` = stronger model. Exposed identically in both the SDK's element/data endpoints and the REST `/v1/query-data` endpoint (`RestUrlQueryParams.mode`, default `"fast"`).
- **Why**: Most workflow steps are mechanical; only a minority need frontier-model reasoning. TinyFish's enterprise numbers back this up (89.9% Mind2Web vs OpenAI Operator's 61.3%, attributed to routing mechanical steps to small/fast models and reserving big models for ~20-30% of steps that are actual decision points).
- **How to implement**: Expose a `--mode fast|standard` (or `--budget cheap|accurate`) flag on every locate/extract/act command in the CLI; default to cheap; let the agent escalate explicitly.
- **Evidence**: `AGENTQL.md:993-1013` (8.3 dual-mode pipeline), `AgentQL_R2_05...md:545-573` (`RestUrlQueryParams.mode` enum, default fast), `AGENTQL.md:733-747` (4.3 three-layer AI system, Mind2Web numbers).
- **Tier**: CORE — cost/latency dial belongs on every LLM-touching CLI verb.

### 8. Page-readiness = dual-signal wait, not a fixed sleep
- **What**: `READY = (DOM quiet for 500ms) AND (network requests resolved or stale 1500ms) OR (6s elapsed AND (network quiet OR duplicate-URL polling detected))`. Hard ceiling: 14s (`SLOWEST_WEBSITE_AVG_LOAD_TIME_SECONDS`), then proceed regardless.
- **Why**: Handles both the "SPA still fetching" case and the "page has infinite background polling" case (duplicate-URL heuristic distinguishes real loading from steady-state long-polling) without either hammering fast pages with fixed waits or hanging forever on chatty ones.
- **How to implement**: Inject a `MutationObserver` writing `Date.now()` to `localStorage['lastDomChange']`; poll it via `page.evaluate`. Track requests via Playwright `request`/`requestfinished`/`requestfailed` listeners; treat a pending request as "resolved" after 1500ms without a response (handles WS/long-poll that never normally completes).
- **Evidence**: `AGENTQL.md:227-246` (3.1 Step 3, exact formula and heuristics), `AGENTQL.md:6247` (only 2 of 6 checkout steps need model involvement — same "mechanical vs. reasoning" split reflected in readiness handling).
- **Tier**: CORE — directly portable readiness algorithm, better than `waitForLoadState` alone.

### 9. Shadow DOM and `<slot>` traversal built into the perception pass
- **What**: If `node.shadowRoot` exists, tree-walk uses `shadowRoot.children` instead of `childNodes`; if the shadow root has no element children but has text, use that as the node's name. For `<slot>` elements, use `node.assignedNodes()` instead of direct children (correct Web Component slot distribution).
- **Why**: Most scraping/automation tools silently fail on shadow-DOM-heavy sites (design-system components, many enterprise SaaS UIs). This is called out explicitly as "a significant capability most scraping tools lack."
- **How to implement**: In the tree-walker, branch on `node.shadowRoot` and `node.tagName === 'SLOT'` before falling through to normal `childNodes` iteration.
- **Evidence**: `AGENTQL.md:334-339` (3.2 step 5-6, shadow DOM + slot handling).
- **Tier**: IMPORTANT.

### 10. Cross-origin iframe handling degrades gracefully instead of failing
- **What**: Same-origin iframes: replace children with `contentDocument.body` children, recurse. Cross-origin iframes (no `contentDocument` access): set role to `"iframe"`, preserve the `src` attribute as a leaf node instead of crashing or silently dropping the frame.
- **Why**: Keeps the tree structurally complete (agent can at least see "there's an iframe pointing at X here") rather than producing a tree with an unexplained gap.
- **How to implement**: Try/catch (or feature-detect) `contentDocument` access; on failure, emit a stub node `{role: "iframe", attributes: {src: ...}}` rather than `null`.
- **Evidence**: `AGENTQL.md:340-347` (3.2 step 7).
- **Tier**: NICE.

### 11. Text nodes get synthetic wrapper elements when needed to stay addressable
- **What**: If a parent has multiple children including a bare text node, wrap the text in a synthetic `<span>`, insert it into the real DOM (replacing the text node), then recurse into it as a normal element (so it too gets a `tf623_id`). If the parent has exactly one text child, just set the parent's own name/role instead of creating a wrapper (except buttons, which always take their textContent as name).
- **Why**: Bare text nodes have no place to hang an id or attributes; wrapping keeps every meaningfully-addressable piece of text resolvable to a locator without over-fragmenting simple single-text-child elements.
- **How to implement**: `parent.children.length > 1 && childIsTextNode` → `document.createElement('span')`, `span.textContent = text`, `parent.replaceChild(span, textNode)`, recurse.
- **Evidence**: `AGENTQL.md:336-338` (3.2 step 8).
- **Tier**: NICE — real DOM mutation is a deliberate tradeoff (breaks strict "don't touch the page" purity) worth being explicit about if copied.

### 12. `::before`/`::after` pseudo-content is folded into the node name
- **What**: `getComputedStyle(node, "::before"/"::after").getPropertyValue("content")`, quotes stripped, prepended/appended to the visible name.
- **Why**: Captures CSS-generated content (icons-as-text, required-field asterisks, badge counts) that's completely invisible if you only read `textContent`/DOM attributes.
- **How to implement**: Two `getComputedStyle` calls per node during the tree walk; cheap, no extra network/model cost.
- **Evidence**: `AGENTQL.md:339` (3.2 step 9).
- **Tier**: NICE.

### 13. `X-API-Key` resolution order with legacy-path auto-migration
- **What**: Resolve key in order: (1) explicit `configure(api_key=...)` call/runtime singleton, (2) `AGENTQL_API_KEY` env var, (3) `~/.agentql/config/config.ini` (`[DEFAULT] agentql_api_key=`), (4) legacy `~/.agentql/config/agentql_api_key.ini`, auto-migrated to the new path on first read.
- **Why**: Standard, predictable precedence (explicit > env > config file) plus a real example of graceful config-format migration without breaking old installs — directly reusable for our CLI's own credential resolution.
- **Evidence**: `AGENTQL.md:536-541` (3.4 auth resolution order).
- **Tier**: IMPORTANT (as a CLI credential-resolution pattern, independent of AgentQL specifically).

### 14. Explicit, typed error taxonomy with numeric codes, all carrying `request_id`
- **What**: `APIKeyError` (1000, HTTP 401), `AgentQLServerTimeoutError` (2001), `AgentQLServerError` (2000, wraps server `detail`), `QuerySyntaxError` (1010, client-side parse), `AccessibilityTreeError` (1005), `ElementNotFoundError` (1006), `PageCrashError` (1013). Every server response includes a `request_id` (UUIDv4) surfaced in error messages for support correlation.
- **Why**: A short closed enum of numeric codes (not free-text messages) lets an agent programmatically branch on failure class (retry vs. reformulate query vs. bail) instead of string-matching error text.
- **How to implement**: Define ~7-10 error classes up front for our CLI's own perceive/act primitives (locator-not-found, timeout, DOM-changed-mid-action, page-crash, auth) each with a stable code, and always echo a correlation id in both stdout and any log line.
- **Evidence**: `AGENTQL.md:542-550` (error taxonomy table with codes).
- **Tier**: CORE.

### 15. Generous, endpoint-specific default timeouts — not one global timeout
- **What**: element-query 300s, data-query 900s, query-generation 75s, document-query 900s, key-validation 30s, health-check 15s. `wait_for` param on the serverless REST endpoint caps at 10s.
- **Why**: Different operations have genuinely different latency floors (LLM call + browser render + document OCR vs. a health ping); a single global timeout either times out legitimate slow extractions or makes fast checks sluggish.
- **How to implement**: Per-command timeout defaults in the CLI, overridable via flag, not a single `--timeout` for the whole tool.
- **Evidence**: `AGENTQL.md:459-467` (timeout table).
- **Tier**: NICE.

### 16. "Codified learning" cache — cache decisions/heuristics, not raw model calls
- **What**: TinyFish enterprise reuses prior *decisions* per workflow node once a heuristic is established, not a literal request→response cache. "Each node executes independently... Failed nodes are isolated — only the failing node reruns. Results cached and reused across runs. Pricing scales with 'distinct decisions' not browser runtime or token count — reused heuristic nodes cost nothing on repeat." Only ~2 of 6 steps in a typical checkout flow need model involvement at all; the rest become deterministic/cached after the first successful run.
- **Why**: The real caching win in browser agents isn't "memoize this HTTP call" (a11y trees differ every time) — it's "once you've established that step N of this workflow reliably resolves to selector X on this site, skip the model for step N next time and just replay the mechanical action, falling back to the model only if replay fails."
- **How to implement**: Key a cache by `(site/workflow_id, step_id)`, store the resolved locator/action, and on replay try the cached action first with a short timeout; on failure (element not found / page changed), fall back to full LLM-mediated locate and overwrite the cache entry. Note: AgentQL's *client SDK* itself has no such cache — this is TinyFish's enterprise-tier behavior, described only qualitatively, not with exposed code.
- **Evidence**: `AGENTQL.md:7007` (per-node caching/isolation description), `AGENTQL.md:6247` (2-of-6-steps-need-model figure), `AGENTQL.md:2586` ("cached heuristics" option explicitly named as what codified learning does).
- **Tier**: IMPORTANT — the single most valuable "cache" idea to steal, but note it is largely INFERRED/qualitative, not reverse-engineered code.

### 17. `Node.get_cache_key()` — deterministic cache key derived straight from the query AST
- **What**: `f"{name}({description})"` (or just `name` with empty description) is the literal cache-key format used server-side for AgentQL's own query caching, per the SDK's node serialization code.
- **Why**: Cheap, obvious pattern: your query DSL's canonical serialization *is* your cache key — no separate hashing scheme needed, and it's human-readable for debugging cache hits/misses.
- **How to implement**: If our CLI builds a locator DSL, give every node a canonical `dump()`/serialization form and use that string directly as the cache key (plus site/URL as a namespace prefix).
- **Evidence**: `AGENTQL.md:4709` and `8191` (`get_cache_key()` format, cited twice consistently).
- **Tier**: NICE.

### 18. `generated_query` returned back to the caller as both transparency and a cache seed
- **What**: When a caller supplies only `prompt` (not `query`), the server LLM-generates an AgentQL query and returns it in `ResponseMetadata.generated_query` alongside the extracted data.
- **Why**: Two purposes stated directly by the researchers: (1) debuggability — caller can see exactly what query ran; (2) caching — caller can persist `generated_query` and reuse it on future calls, skipping the prompt→query generation cost entirely. Called "one of the most reasonable design decisions in the API."
- **How to implement**: Any CLI verb that accepts free-text and internally compiles it to a structured locator/query should always print the compiled form (e.g., `--explain` or always-on stderr line) so the operator can pin it into a script and skip re-compilation next run.
- **Evidence**: `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md:574-589` (5.9 ResponseMetadata, explicit "Finding" callout).
- **Tier**: CORE — cheap, high-leverage UX/cost pattern, directly portable regardless of whether we build a DSL.

### 19. Browser-fleet session API: 3 knobs, on-disconnect lifecycle, byte-metered billing
- **What**: `POST /v1/tetra/sessions` takes `browser_ua_preset` (windows/macos/linux), `browser_profile` (light/stealth/tf-browser), `shutdown_mode` (`on_disconnect` default | `on_inactivity_timeout`, 5s–86400s TTL), `proxy` (built-in country-code proxy or BYO), `sub_user_id` (multi-tenant tag), `branding`. Response: exactly 3 fields — `session_id`, `cdp_url` (wss://…), `base_url` (https://…). No `DELETE` endpoint exists; killing the session is just disconnecting the WebSocket.
- **Why**: Minimal, composable session-lifecycle contract: one dedicated VM per session (inferred from disconnect-kills-it default + no shared-pool state in the API), billed on proxy bytes not just VM-minutes (`proxy_trg_rx_bytes`/`tx_bytes` in telemetry), no server-side session listing — client is expected to track its own IDs.
- **How to implement**: If our CLI ever needs a remote/fleet browser mode, model it exactly this way: create-returns-connection-info-only, no server enumeration API, disconnect-is-terminate as the default, and a hostname-encodes-the-IP addressing scheme (`ip-A-B-C-D.tetra-data.<domain>`, SNI = hostname) to avoid DNS provisioning per session.
- **Evidence**: `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md:451-608` (5.3–5.11, full schemas), `:851-889` (7.1–7.2 hostname-encoding rationale).
- **Tier**: NICE — relevant only if/when we build a hosted-fleet mode; not needed for a local-Playwright-driving CLI.

### 20. `/v1/query-data` REST mode: URL-or-HTML input, bypasses the whole client SDK
- **What**: The serverless REST endpoint accepts either `url` (server renders the page itself via its own browser fleet) or `html` (caller supplies pre-fetched markup — server skips rendering/proxy entirely, faster/cheaper). Query params: `mode` (fast/standard), `wait_for` (≤10s), `is_scroll_to_bottom_enabled`, `is_screenshot_enabled`, `browser_profile`, `proxy`.
- **Why**: Two distinct cost/latency tiers exposed as one endpoint via an input-type branch — worth mirroring: any "fetch and query" verb in our CLI should accept both a URL (we render) and raw HTML (we skip rendering) as alternative inputs to the same locate/extract logic.
- **Evidence**: `AGENTQL_R2_05_TETRA_BROWSER_FLEET.md:545-573` (5.8 full schema + findings).
- **Tier**: NICE.

## Command Surface (verbatim / near-verbatim)

**AQL grammar** (reconstructed consistently from parser source in three places in the teardown):
```
Query        ::= '{' NodeList '}'
NodeList     ::= Node (',' Node)* | Node (NEWLINE Node)*
Node         ::= IDENTIFIER Description? (Container | List | epsilon)
Description  ::= '(' DescContent ')'
Container    ::= '{' NodeList '}'
List         ::= '[]' Container?
IDENTIFIER   ::= [a-zA-Z_][a-zA-Z0-9_]*
```
Example queries:
```
{ product_name product_price }
{ page_element(the login button on the top right) }
{ products[] { name price(integer) } }
{ footer { copyright_text links[] } }
```

**Locator resolution (Python, near-verbatim from `AGENTQL.md:2618-2641`):**
```python
def resolve_to_locator(page, server_response_item):
    tf_id = server_response_item["tf623_id"]
    iframe_path = server_response_item.get("attributes", {}).get("iframe_path", "")
    if iframe_path:
        context = page
        for frame_id in iframe_path.split("."):
            if frame_id:
                context = context.frame_locator(f"[tf623_id='{frame_id}']")
        return context.locator(f"[tf623_id='{tf_id}']")
    else:
        return page.locator(f"[tf623_id='{tf_id}']")
```

**Accessibility tree JS injection call signature:**
```js
generateAccessibilityTree({
  currentGlobalId: int,   // counter, persists across calls on page._impl_obj
  processIFrames: false,
  iframePath: "",
  includeHidden: false,
  nodeIdsToIgnore: [],
})
// => { tree: {role, name, attributes: {html_tag, tf623_id, ...}, children: [...]}, lastUsedId: int }
```

**Request/response envelope (both `/api/v2/query` and `/api/v2/query-data`):**
```json
// request
{
  "query": "{ product_name product_price }",
  "accessibility_tree": { "role": "webArea", "name": "...", "attributes": {...}, "children": [...] },
  "metadata": { "url": "https://example.com", "experimental_query_elements_enabled": false },
  "params": { "mode": "fast" },
  "request_origin": "sdk-playwright-python"
}
// response
{ "response": { "product_name": "iPhone 15 Pro", "product_price": "$999" }, "request_id": "uuid" }
```

**Tetra session create/response:**
```http
POST /v1/tetra/sessions
X-API-Key: tk_...
{ "browser_ua_preset":"linux","browser_profile":"light","shutdown_mode":"on_disconnect",
  "inactivity_timeout_seconds":300,"proxy":{"type":"tetra","country_code":"US"},
  "sub_user_id":"...","branding":true }

201 { "session_id":"tf-<uuid>", "cdp_url":"wss://ip-A-B-C-D.tetra-data.../tf-<uuid>/",
      "base_url":"https://ip-A-B-C-D.tetra-data.../tf-<uuid>/" }
```

**Error taxonomy (codes):** `APIKeyError`=1000, `AgentQLServerError`=2000, `AgentQLServerTimeoutError`=2001, `QuerySyntaxError`=1010, `AccessibilityTreeError`=1005, `ElementNotFoundError`=1006, `PageCrashError`=1013.

## Anti-Patterns (do NOT copy)

1. **Don't build a full custom grammar/parser as the primary interface up front.** AgentQL's own teardown flags this as a real adoption risk (section 5.5): is `{ products[] { name, price(integer) } }` meaningfully better than a Zod-schema-style `extract({...})` call to justify the learning curve? A CLI for *agents* (not human developers typing queries by hand) gets less benefit from bespoke syntax than a human-facing SDK does — agents can emit structured JSON/args directly. Prefer a JSON/flag-based locator spec over inventing new textual syntax, and reserve DSL-style compactness only if token-cost of the query itself is a measured bottleneck.
2. **Don't make every operation server-dependent with no offline/local fallback.** Section 5.3 explicitly names this as a risk: "No offline capability... Single point of failure." Every single locate/extract call in AgentQL requires a network round trip to `api.agentql.com` even for cases a local heuristic (exact text match, stable `id`/`data-testid` attribute) could resolve instantly and free. Our CLI should try cheap deterministic matches (role+name equality against the last-known accessibility tree, or a cached locator) before ever calling out to a model.
3. **Don't silently mutate the live DOM as a side effect of "reading" it.** Two mutations happen during tree generation: (a) `tf623_id` written onto every element (arguably fine/necessary — that's the bridge), but (b) text nodes get replaced with synthetic `<span>` wrappers inserted into the real DOM (`AGENTQL.md:336-338`). This can break page JS that assumes its own text-node structure (React reconciliation, custom event listeners tied to node identity) and is a maintenance/compatibility risk field-reported nowhere in the docs but implied by "this DOM mutation is notable." If we adopt the ID-stamping trick, keep it to attribute writes only — avoid restructuring node types.
4. **Don't treat "accessibility tree as sole perception input" as sufficient for all sites.** Explicitly a known failure class (5.1–5.2): canvas apps, drag-and-drop without DOM ids, slider widgets, image-only content without alt text, CSS-only meaning. 12 of 40 Mind2Web failures were anti-bot blocking, 4 were pure a11y-tree blind spots. Our CLI should keep a screenshot/vision fallback path for exactly this class rather than assuming a11y-tree coverage is universal.
5. **Don't expose your OpenAPI schema/docs endpoints unauthenticated in production** (this is AgentQL's own operational mistake, not a design pattern to copy): `api.agentql.com/openapi.json`, `/docs`, `/redoc` are all served with zero auth, leaking full request/response schemas including internal field-naming conventions and 3x-duplicated security-scheme entries that reveal internal middleware structure (`AGENTQL_R2_05...md:385-424`). If our CLI ships any companion service, gate schema/docs endpoints behind the same auth as the API itself, or don't mount them in prod.
6. **Don't assume "codified learning"/decision caching is free to build.** It's the highest-leverage idea in the whole corpus (#16 above) but it is *not* reverse-engineered code — it's a qualitative claim from marketing/blog language ("distinct decisions" pricing, "reused heuristic nodes cost nothing"). Treat it as a design target to prototype and validate against real replay-failure rates, not a ready-made algorithm to port.
