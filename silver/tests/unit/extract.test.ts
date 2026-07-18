import { describe, it, expect } from 'vitest'
import {
  transformSchema,
  ensureContainer,
  buildBundle,
  ID_PATTERN,
  type JsonSchema,
} from '../../src/extract/transform.js'
import { resolveIds } from '../../src/extract/resolve.js'
import { EXTRACT_SYSTEM_PROMPT } from '../../src/extract/prompts.js'

// A free-text URL a hallucinating model might try to emit — must NEVER satisfy
// the ID pattern the transform installs.
const FAKE_URL = 'https://example.com/totally-made-up'

describe('transformSchema — URL fields become element-ID fields (the moat)', () => {
  it('a `url`-named field is swapped for the ^\\d+-\\d+$ ID pattern', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        url: { type: 'string' },
      },
    }
    const { transformed, urlFieldPaths } = transformSchema(schema)
    const field = transformed.properties!.url

    expect(field.type).toBe('string')
    expect(field.pattern).toBe('^\\d+-\\d+$')
    expect(field.description).toBe('the element ID of the link, e.g. 0-18372')
    expect(urlFieldPaths).toEqual(['url'])
    // Non-URL fields are untouched.
    expect(transformed.properties!.title).toEqual({ type: 'string' })
  })

  it('SHORTHAND schema `{field:"type"}` is normalized so URL grounding still applies (no silent bypass)', () => {
    // Real failure (error-analysis on MDN): a shorthand schema slipped past walk()
    // → urlFieldPaths:[] → the element ID leaked out as data with success:true.
    const { transformed, urlFieldPaths } = transformSchema({
      country: 'string',
      link: 'string',
    } as unknown as JsonSchema)
    expect(urlFieldPaths).toEqual(['link']) // was [] — the moat is now applied
    expect(transformed.type).toBe('object')
    expect(transformed.properties!.link.pattern).toBe('^\\d+-\\d+$') // link → ID field
    expect(transformed.properties!.country).toEqual({ type: 'string' }) // non-URL untouched
    // A CANONICAL schema is unchanged by normalization (it already carries `type`).
    const canon = transformSchema({
      type: 'object',
      properties: { link: { type: 'string', format: 'uri' } },
    })
    expect(canon.urlFieldPaths).toEqual(['link'])
  })

  it('SHORTHAND LIST form `{"links":[{...,"url":"string"}]}` (the README onboarding schema) grounds url', () => {
    // Real failure caught by onboarding error-analysis: the FIRST `extract` the
    // README hands a new user — a nested single-element array of shorthand — slipped
    // past normalization (array values bailed), so the url field was NOT grounded and
    // the moat was silently off on a brand-new user's very first extract.
    const { transformed, urlFieldPaths } = transformSchema({
      links: [{ title: 'string', url: 'string' }],
    } as unknown as JsonSchema)
    expect(urlFieldPaths).toEqual(['links.*.url']) // was [] — the moat now applies
    expect(transformed.type).toBe('object')
    const item = transformed.properties!.links.items!
    expect(item.properties!.url.pattern).toBe(ID_PATTERN) // url → element-ID field
    expect(item.properties!.title).toEqual({ type: 'string' }) // non-URL untouched
  })

  it('MIXED shorthand + canonical map grounds the canonically-annotated url field', () => {
    // Adversarial-review catch: a user writes sibling fields in shorthand but
    // annotates the one url/link field they care about (`{type:"string"}`,
    // `format:"uri"`, a description). The whole map must still normalize so walk()
    // grounds that field — a stricter all-or-nothing guard silently disabled the moat.
    for (const schema of [
      { title: 'string', url: { type: 'string' } },
      { name: 'string', url: { type: 'string', format: 'uri' } },
      { title: 'string', link: { type: 'string', description: 'the link' } },
    ] as unknown as JsonSchema[]) {
      const { transformed, urlFieldPaths } = transformSchema(schema)
      expect(urlFieldPaths.length, JSON.stringify(schema)).toBeGreaterThan(0) // was [] — moat back ON
      expect(transformed.type).toBe('object')
    }
  })

  it('does NOT misread a JSON-Schema combinator as shorthand (no false-positive restructuring)', () => {
    // A canonical `{type:…}` node anywhere makes the map non-shorthand, so an
    // `oneOf`/`anyOf` array (whose elements carry `type`) is left UNTOUCHED — never
    // wrapped into a bogus `{type:object, properties:{oneOf:…}}`.
    const combinator = { oneOf: [{ type: 'string' }] }
    const { transformed, urlFieldPaths } = transformSchema(combinator as unknown as JsonSchema)
    expect(urlFieldPaths).toEqual([])
    expect(transformed).toEqual(combinator) // structurally unchanged
    // A shorthand array of a bare type name is not URL-bearing → no paths, no crash.
    expect(transformSchema({ tags: ['string'] } as unknown as JsonSchema).urlFieldPaths).toEqual([])
  })

  it('a fabricated free-text URL cannot satisfy the installed pattern; a real ID can', () => {
    const schema: JsonSchema = { type: 'object', properties: { url: { type: 'string' } } }
    const { transformed } = transformSchema(schema)
    const re = new RegExp(transformed.properties!.url.pattern!)

    expect(re.test(FAKE_URL)).toBe(false) // hallucinated URL is structurally rejected
    expect(re.test('0-18372')).toBe(true) // a real element ID is accepted
    expect(re.test('3-18')).toBe(true)
  })

  it('detects `{type:"string", format:"uri"}` by format even when the name is not url-like', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { homepage: { type: 'string', format: 'uri' } },
    }
    const { transformed, urlFieldPaths } = transformSchema(schema)
    expect(transformed.properties!.homepage.pattern).toBe(ID_PATTERN)
    expect(urlFieldPaths).toEqual(['homepage'])
  })

  it('detects href/link by name, case-insensitively', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        Href: { type: 'string' },
        LINK: { type: 'string' },
        note: { type: 'string' },
      },
    }
    const { transformed, urlFieldPaths } = transformSchema(schema)
    expect(transformed.properties!.Href.pattern).toBe(ID_PATTERN)
    expect(transformed.properties!.LINK.pattern).toBe(ID_PATTERN)
    expect(transformed.properties!.note.pattern).toBeUndefined()
    expect(urlFieldPaths.sort()).toEqual(['Href', 'LINK'])
  })

  it('records array paths with `*` (array of objects each holding a url)', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, url: { type: 'string' } },
      },
    }
    const { urlFieldPaths } = transformSchema(schema)
    expect(urlFieldPaths).toEqual(['*.url'])
  })

  it('does not mutate the input schema', () => {
    const schema: JsonSchema = { type: 'object', properties: { url: { type: 'string' } } }
    const snapshot = JSON.stringify(schema)
    transformSchema(schema)
    expect(JSON.stringify(schema)).toBe(snapshot)
  })

  it('does not collapse a container merely because it is named `url`', () => {
    // A url-named OBJECT must be recursed into, not turned into a single ID —
    // otherwise its real fields would silently vanish.
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        url: {
          type: 'object',
          properties: { href: { type: 'string' }, label: { type: 'string' } },
        },
      },
    }
    const { transformed, urlFieldPaths } = transformSchema(schema)
    expect(transformed.properties!.url.type).toBe('object')
    expect(transformed.properties!.url.properties!.href.pattern).toBe(ID_PATTERN)
    expect(urlFieldPaths).toEqual(['url.href'])
  })
})

describe('ensureContainer — list[T] default (N-collapse-to-1 guard)', () => {
  it('wraps a bare object schema in an array', () => {
    const obj: JsonSchema = { type: 'object', properties: { title: { type: 'string' } } }
    const wrapped = ensureContainer(obj)
    expect(wrapped.type).toBe('array')
    expect(wrapped.items).toBe(obj)
  })

  it('leaves an already-array schema unchanged', () => {
    const arr: JsonSchema = { type: 'array', items: { type: 'string' } }
    expect(ensureContainer(arr)).toBe(arr)
  })

  it('leaves a primitive schema unchanged', () => {
    const prim: JsonSchema = { type: 'string' }
    expect(ensureContainer(prim)).toBe(prim)
  })
})

describe('buildBundle — assembles the host bundle without calling a model', () => {
  const valueMap = { '0-1': 'https://real.example/a' }

  it('forces a container, ID-transforms url fields, and composes the prompt', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' }, url: { type: 'string' } },
    }
    const bundle = buildBundle(schema, 'SNAPSHOT-TEXT', valueMap, 'get all products')

    // Container default: object → array of objects, so the url path is *.url.
    expect(bundle.id_transformed_schema.type).toBe('array')
    expect(bundle.id_transformed_schema.items!.properties!.url.pattern).toBe(ID_PATTERN)
    expect(bundle.url_field_paths).toEqual(['*.url'])

    // Prompt = verbatim EXTRACT prompt + instruction.
    expect(bundle.prompt.startsWith(EXTRACT_SYSTEM_PROMPT)).toBe(true)
    expect(bundle.prompt).toContain('get all products')

    // Snapshot passes through verbatim.
    expect(bundle.snapshot_with_ids).toBe('SNAPSHOT-TEXT')
  })

  it('uses the bare EXTRACT prompt when no instruction is given', () => {
    const bundle = buildBundle({ type: 'string' }, 'S', valueMap)
    expect(bundle.prompt).toBe(EXTRACT_SYSTEM_PROMPT)
  })

  it('NEVER leaks the real value map into the host-facing bundle', () => {
    // The whole moat: the host must see IDs, never real URLs.
    const bundle = buildBundle(
      { type: 'object', properties: { url: { type: 'string' } } },
      'S',
      { '0-1': 'https://secret.example/leak' },
    )
    expect(JSON.stringify(bundle)).not.toContain('secret.example')
  })
})

describe('resolveIds — reverse-map IDs → real values, hardened', () => {
  it('replaces an ID (3-18) with its real href from the value map', () => {
    const valueMap = { '3-18': 'https://real.example/product/18' }
    const result = { name: 'Widget', url: '3-18' }
    const res = resolveIds(result, ['url'], valueMap, 7, 7)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toEqual({ name: 'Widget', url: 'https://real.example/product/18' })
      expect(res.warning).toBeUndefined()
    }
  })

  it('resolves IDs across every element of an array path (*.url)', () => {
    const valueMap = { '0-1': 'https://a.example', '0-2': 'https://b.example' }
    const result = [
      { name: 'A', url: '0-1' },
      { name: 'B', url: '0-2' },
    ]
    const res = resolveIds(result, ['*.url'], valueMap, 1, 1)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toEqual([
        { name: 'A', url: 'https://a.example' },
        { name: 'B', url: 'https://b.example' },
      ])
    }
  })

  it('an unknown ID → null + a LOUD warning naming it (never "")', () => {
    const valueMap = { '3-18': 'https://real.example/18' }
    const result = { url: '9-99' }
    const res = resolveIds(result, ['url'], valueMap, 2, 2)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect((res.data as { url: unknown }).url).toBeNull() // null, NOT ""
      expect(res.data).not.toEqual({ url: '' })
      expect(res.warning).toBeDefined()
      expect(res.warning).toContain('9-99') // the offending id is named
    }
  })

  it('a stale bundle generation → { ok:false, code:"ref_stale" } (no resolution)', () => {
    const valueMap = { '3-18': 'https://real.example/18' }
    const result = { url: '3-18' }
    const res = resolveIds(result, ['url'], valueMap, 4, 5) // 4 !== 5

    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ref_stale')
  })

  it('leaves non-ID leaf values untouched (e.g. null for "no info found")', () => {
    const res = resolveIds({ url: null, other: 'plain text' }, ['url'], {}, 1, 1)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ url: null, other: 'plain text' })
  })

  it('does not mutate the caller-supplied result object', () => {
    const valueMap = { '3-18': 'https://real.example/18' }
    const result = { url: '3-18' }
    resolveIds(result, ['url'], valueMap, 1, 1)
    expect(result.url).toBe('3-18') // original still holds the ID
  })

  it('end-to-end: buildBundle paths feed resolveIds', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' }, link: { type: 'string' } },
    }
    const valueMap = { '0-5': 'https://real.example/five' }
    const bundle = buildBundle(schema, 'S', valueMap, 'all links')
    // Host emits an array (container default) with IDs in the `link` field.
    const hostOutput = [{ name: 'Five', link: '0-5' }]
    const res = resolveIds(hostOutput, bundle.url_field_paths, valueMap, 3, 3)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toEqual([{ name: 'Five', link: 'https://real.example/five' }])
    }
  })
})

describe('prompts — verbatim host-run constants', () => {
  it('EXTRACT prompt carries the ID-only link rule (the model-facing moat half)', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain(
      'you MUST respond with ONLY the IDs of the link elements',
    )
    expect(EXTRACT_SYSTEM_PROMPT).toContain('YOU MUST EXTRACT ALL OF THE INFORMATION')
  })
})
