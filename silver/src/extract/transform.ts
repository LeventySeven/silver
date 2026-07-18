/**
 * Keyless ID-grounded schema transform (spec §3 P4, §8; plan Task 10).
 *
 * THE MOAT. Before the host LLM ever sees the extract schema, we swap every
 * URL-bearing field for an *element-ID* field constrained to `^\d+-\d+$`. A
 * model asked to fill an ID-pattern field literally cannot emit a fabricated
 * URL as free text — it can only emit an ID that maps to a real DOM node via
 * the CLI-retained value map. Fabricated URLs become STRUCTURALLY impossible
 * rather than merely discouraged.
 *
 * Adapted from Stagehand `reference/stagehand` transformSchema /
 * makeIdStringSchema / injectUrls, reworked to operate on plain JSON Schema
 * (no zod dependency — KEYLESS: this module only transforms JSON and strings).
 */
import { EXTRACT_SYSTEM_PROMPT } from './prompts.js'

/**
 * A minimal, recursive JSON-Schema shape — enough for extract schemas. The
 * open index signature lets callers pass through fields we don't model
 * (`enum`, `required`, `minimum`, …) without them being dropped by transforms.
 */
export type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  format?: string
  description?: string
  pattern?: string
  [k: string]: unknown
}

/** The element-ID pattern the host model is constrained to emit for URL fields. */
export const ID_PATTERN = '^\\d+-\\d+$'

/** Field names (case-insensitive) that are treated as URL-bearing regardless of type. */
const URL_NAME_RE = /^(url|href|link)$/i

/** Freshly-minted ID-field schema (fresh object per call — never share/mutate). */
function idField(): JsonSchema {
  return {
    type: 'string',
    pattern: ID_PATTERN,
    description: 'the element ID of the link, e.g. 0-18372',
  }
}

/** A `{type:"string", format:"uri"|"url"}` leaf. */
function isUriString(node: JsonSchema): boolean {
  return node.type === 'string' && (node.format === 'uri' || node.format === 'url')
}

/**
 * A property named url/href/link (case-insensitive) is URL-bearing — but only
 * collapse it to an ID when it is a string-ish leaf. A container named `url`
 * (object/array) is recursed into instead, so we never turn a whole subtree
 * into a single ID (that would silently drop its real fields).
 */
function nameIsUrlLeaf(nameHint: string | undefined, node: JsonSchema): boolean {
  if (nameHint === undefined || !URL_NAME_RE.test(nameHint)) return false
  return node.type === 'string' || node.type === undefined
}

/**
 * Deep-walk a JSON Schema, returning a NEW schema (input is never mutated) with
 * every URL-bearing field replaced by the ID-pattern field, plus the dot-joined
 * paths of every replaced field. Array items are addressed with `*`
 * (`items.*.href`); an array-of-urls is `links.*`; a root url string is `""`.
 * These paths are what resolve.ts walks to reverse-map IDs → real values.
 */
/** JSON-Schema type-name strings a shorthand value may carry. */
const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

/**
 * A shorthand VALUE is one of: a bare type-name string (`"string"`); a
 * single-element array of shorthand (`[{…}]` — the documented `{"links":[{…}]}`
 * list form); or a plain map whose EVERY value is itself shorthand (a nested
 * object). Crucially, any object carrying `type`/`properties`/`items` is a
 * CANONICAL node and is NOT shorthand — its presence makes the whole map
 * canonical, so we never misread a JSON-Schema construct (a `oneOf`/`$ref` array,
 * a `{type:…}` leaf) as a shorthand field and wrongly restructure it.
 */
function isShorthandValue(v: unknown): boolean {
  if (typeof v === 'string') return TYPE_NAMES.has(v)
  if (Array.isArray(v)) return v.length === 1 && isShorthandValue(v[0])
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    if (o.type !== undefined || o.properties !== undefined || o.items !== undefined) return false
    const vals = Object.values(o)
    return vals.length > 0 && vals.every(isShorthandValue)
  }
  return false
}

/** Turn a KNOWN-shorthand value (validated by `isShorthandValue`) into a canonical node. */
function shorthandToSchema(v: unknown): JsonSchema {
  if (typeof v === 'string') return { type: v }
  if (Array.isArray(v)) return { type: 'array', items: shorthandToSchema(v[0]) }
  const o = v as Record<string, unknown>
  const properties: Record<string, JsonSchema> = {}
  for (const [k, val] of Object.entries(o)) properties[k] = shorthandToSchema(val)
  return { type: 'object', properties }
}

/**
 * Normalize a SHORTHAND extract schema into canonical `{type,properties,items}`
 * form BEFORE `walk` runs. Shorthand is the map-of-field form the README
 * documents: `{field:"type"}`, a nested `{field:{…}}`, the list form
 * `{"links":[{"title":"string","url":"string"}]}`, and — crucially — a MIX where
 * one field is annotated canonically (`{title:"string", url:{type:"string",
 * format:"uri"}}`). Without this, such a map slips past `walk` (which only
 * recurses a node that HAS `type:'object'`+`properties` or `type:'array'`+`items`),
 * so URL fields are never detected and the ID-grounding moat is SILENTLY bypassed
 * — a `link`/`url` field then leaks the raw element ID out as if it were data,
 * with success:true (the worst shape; the README onboards a new user with exactly
 * the list form).
 *
 * A plain map (no top-level `type`/`properties`/`items`) is treated as a field-map
 * and wrapped as `{type:'object', properties}` — EACH value converted if it is
 * shorthand (a type-name string, a 1-element array of shorthand, or a nested
 * shorthand map) and PASSED THROUGH unchanged if it is already a canonical node
 * (so `walk` grounds a canonical `url` child by name/format). The map is left
 * entirely UNTOUCHED only when a value is neither shorthand nor a plain object —
 * e.g. a JSON-Schema combinator's array of canonical nodes (`{oneOf:[{type:…}]}`),
 * a multi-element array, a number — so we never misread a combinator as a field.
 */
function normalizeShorthand(schema: JsonSchema): JsonSchema {
  const s = schema as unknown as Record<string, unknown>
  const isPlainMap =
    s !== null &&
    typeof s === 'object' &&
    !Array.isArray(s) &&
    s.type === undefined &&
    s.properties === undefined &&
    s.items === undefined &&
    Object.keys(s).length > 0
  if (!isPlainMap) return schema
  // A field-map value is: a type-name string, a plain (non-array) object (canonical
  // or a nested shorthand map — recursed / passed through), or a 1-element array of
  // shorthand (the `{"links":[{…}]}` list form). Anything else (a number, a multi-
  // element array, a combinator's array of canonical nodes) means this is not a
  // field-map, so leave it for `walk` — never guess a structure.
  const isFieldMapValue = (v: unknown): boolean =>
    (typeof v === 'string' && TYPE_NAMES.has(v)) ||
    (typeof v === 'object' && v !== null && !Array.isArray(v)) ||
    isShorthandValue(v)
  if (!Object.values(s).every(isFieldMapValue)) return schema
  const properties: Record<string, JsonSchema> = {}
  for (const [k, v] of Object.entries(s)) {
    properties[k] = Array.isArray(v)
      ? { type: 'array', items: shorthandToSchema(v[0]) }
      : typeof v === 'string'
        ? { type: v }
        : normalizeShorthand(v as JsonSchema)
  }
  return { type: 'object', properties }
}

export function transformSchema(schema: JsonSchema): {
  transformed: JsonSchema
  urlFieldPaths: string[]
} {
  const paths: string[] = []
  const transformed = walk(normalizeShorthand(schema), [], undefined, paths)
  return { transformed, urlFieldPaths: paths }
}

function walk(
  node: JsonSchema,
  path: string[],
  nameHint: string | undefined,
  out: string[],
): JsonSchema {
  // 1. Does this node itself become an element-ID field?
  if (isUriString(node) || nameIsUrlLeaf(nameHint, node)) {
    out.push(path.join('.'))
    return idField()
  }
  // 2. Recurse object properties (property key becomes the next name hint).
  if (node.type === 'object' && node.properties) {
    const newProps: Record<string, JsonSchema> = {}
    for (const key of Object.keys(node.properties)) {
      newProps[key] = walk(node.properties[key] as JsonSchema, [...path, key], key, out)
    }
    return { ...node, properties: newProps }
  }
  // 3. Recurse array items (addressed with `*`; items carry no name hint).
  if (node.type === 'array' && node.items) {
    const newItems = walk(node.items, [...path, '*'], undefined, out)
    return { ...node, items: newItems }
  }
  // 4. Leaf that isn't URL-bearing — passed through unchanged.
  return node
}

/**
 * Default cardinality to a CONTAINER (`list[T]`). A bare object schema tends to
 * make the model collapse N page results into 1 (the "N-options-collapse-to-1"
 * bug); wrapping it in an array forces the model to return every match. Already
 * a container (or a primitive) → returned unchanged.
 */
export function ensureContainer(schema: JsonSchema): JsonSchema {
  if (schema.type === 'object') {
    return { type: 'array', items: schema }
  }
  return schema
}

/**
 * What `buildBundle` assembles. The first three fields are the HOST-FACING
 * bundle the CLI prints for the host to run inference over. `url_field_paths`
 * is CLI-retained state the host does not need but `extract resolve` does.
 */
export type ExtractBundle = {
  // ---- host-facing (printed for the host LLM) ----
  id_transformed_schema: JsonSchema
  prompt: string
  snapshot_with_ids: string
  // ---- CLI-retained (persist to the session sidecar for `extract resolve`) ----
  // Non-sensitive (schema paths only, e.g. "*.url"); safe to co-locate.
  url_field_paths: string[]
}

/**
 * Assemble the extract bundle the CLI prints. It (1) forces a `list[T]`
 * container, (2) ID-transforms every URL field, and (3) composes the host
 * prompt from the verbatim EXTRACT system prompt plus the optional instruction.
 *
 * The CLI does NOT call a model — it prints this bundle for the host to run.
 *
 * `valueMap` (id → real value) is passed for signature completeness but is
 * DELIBERATELY excluded from the returned bundle: the host must never see real
 * URLs/values, only element IDs — that exclusion is the whole point of the
 * transform. The CLI persists `valueMap` to the session sidecar itself and
 * consults it later in `extract resolve`. (Same discipline as envelope.ts's
 * `void ctx` no-leak guard.)
 */
export function buildBundle(
  schema: JsonSchema,
  snapshotWithIds: string,
  valueMap: Record<string, string>,
  instruction?: string,
): ExtractBundle {
  void valueMap
  const contained = ensureContainer(schema)
  const { transformed, urlFieldPaths } = transformSchema(contained)
  const prompt =
    instruction && instruction.trim().length > 0
      ? `${EXTRACT_SYSTEM_PROMPT}\n\nInstruction: ${instruction}`
      : EXTRACT_SYSTEM_PROMPT
  return {
    id_transformed_schema: transformed,
    prompt,
    snapshot_with_ids: snapshotWithIds,
    url_field_paths: urlFieldPaths,
  }
}
