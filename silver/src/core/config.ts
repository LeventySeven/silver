/**
 * Config-file system (adopt-list E3) — `~/.silver/config.json` (user) + project
 * `silver.json`, merged user → project → env → CLI so a fleet stops repeating
 * every flag on every invocation (the real drift source: one batch call silently
 * forgets `--allowed-domains` and runs unrestricted).
 *
 * Merge rules (Vercel `flags.rs` parity):
 *   - SECURITY-SENSITIVE allowlist fields (`allowedDomains`) use TIGHTEN-ONLY
 *     semantics across the file/env layers: a more-local (lower-trust) layer may
 *     only NARROW the effective allowlist to a subset of the higher-trust layer,
 *     never ADD hosts to it. Concretely, across user → project → env the first
 *     non-empty layer establishes the baseline and each later non-empty layer is
 *     INTERSECTED with it; a layer that is disjoint (would only widen) is
 *     rejected and the higher-trust allowlist stands. This is deliberately NOT a
 *     union: an egress allowlist is a security fence, and a lower-trust project
 *     `silver.json` in cwd must never be able to punch new holes in a
 *     higher-trust `~/.silver/config.json` allowlist (an empty effective
 *     allowlist means UNRESTRICTED downstream, so tightening also never blanks a
 *     non-empty higher-trust layer). An empty list in a layer is "no opinion".
 *   - NON-SECURITY LIST fields (`confirmActions` / `resourceTypes`) are
 *     CONCATENATED across layers. For `confirmActions` more entries = more gated
 *     actions = a STRICTER confirm fence, so union is itself a tightening; the
 *     CLI adds to both.
 *   - SCALAR fields are OVERRIDDEN by the more-specific layer, but ONLY when that
 *     layer set them explicitly. The `<field>Explicit` shadow-boolean (Vercel
 *     `cli_*`) records, per scalar, whether the CLI actually supplied it — so a
 *     parser DEFAULT never clobbers a real config value (the config-vs-CLI
 *     precedence bug this item exists to prevent).
 *
 * KEYLESS: file read + JSON merge, no model, no network. Fail-OPEN: a missing or
 * malformed config file is skipped with a warning, never a thrown error — a typo
 * in `silver.json` must not brick every command.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseFlags, type ParsedFlags } from './flags.js'

/**
 * The config-file schema: a camelCase subset mirroring {@link ParsedFlags}. Every
 * field is optional (a layer sets only what it cares about). Unknown keys in the
 * on-disk JSON are ignored (lenient, forward-compatible).
 */
export type SilverConfig = {
  session?: string
  namespace?: string
  json?: boolean
  headed?: boolean
  /** LIST — concatenated across layers. */
  allowedDomains?: string[]
  allowFileAccess?: boolean
  profile?: string
  maxOutput?: number
  timeout?: number
  engine?: string
  state?: string
  enableActions?: boolean
  /** LIST — concatenated across layers. */
  confirmActions?: string[]
  incognito?: boolean
  noEncryptState?: boolean
  twoPhaseConfirm?: boolean
  grantPermissions?: boolean
  contentBoundaries?: boolean
  /** LIST — concatenated across layers. */
  resourceTypes?: string[]
}

/** Config fields whose values are lists (merged across layers — see below). */
const LIST_FIELDS = ['allowedDomains', 'confirmActions', 'resourceTypes'] as const
type ListField = (typeof LIST_FIELDS)[number]
const LIST_FIELD_SET: ReadonlySet<string> = new Set(LIST_FIELDS)

/**
 * Security-sensitive allowlist fields: TIGHTEN-ONLY across layers (a more-local
 * layer may only narrow to a subset, never widen). All OTHER list fields
 * concatenate. See the module doc comment for the full precedence rationale.
 */
const SECURITY_LIST_FIELDS = ['allowedDomains'] as const
const SECURITY_LIST_FIELD_SET: ReadonlySet<string> = new Set(SECURITY_LIST_FIELDS)

/** All scalar config fields (everything in SilverConfig that is not a list). */
const SCALAR_FIELDS = [
  'session',
  'namespace',
  'json',
  'headed',
  'allowFileAccess',
  'profile',
  'maxOutput',
  'timeout',
  'engine',
  'state',
  'enableActions',
  'incognito',
  'noEncryptState',
  'twoPhaseConfirm',
  'grantPermissions',
  'contentBoundaries',
] as const
type ScalarField = (typeof SCALAR_FIELDS)[number]

type ConfigField = ListField | ScalarField

/** Env-var → config-field mapping (`SILVER_*`). */
const ENV_MAP: Record<string, ConfigField> = {
  SILVER_SESSION: 'session',
  SILVER_NAMESPACE: 'namespace',
  SILVER_JSON: 'json',
  SILVER_HEADED: 'headed',
  SILVER_ALLOWED_DOMAINS: 'allowedDomains',
  SILVER_ALLOW_FILE_ACCESS: 'allowFileAccess',
  SILVER_PROFILE: 'profile',
  SILVER_MAX_OUTPUT: 'maxOutput',
  SILVER_TIMEOUT: 'timeout',
  SILVER_ENGINE: 'engine',
  SILVER_STATE: 'state',
  SILVER_ENABLE_ACTIONS: 'enableActions',
  SILVER_CONFIRM_ACTIONS: 'confirmActions',
  SILVER_INCOGNITO: 'incognito',
  SILVER_NO_ENCRYPT_STATE: 'noEncryptState',
  SILVER_TWO_PHASE_CONFIRM: 'twoPhaseConfirm',
  SILVER_GRANT_PERMISSIONS: 'grantPermissions',
  SILVER_RESOURCE_TYPES: 'resourceTypes',
}

const NUMERIC_FIELDS: ReadonlySet<string> = new Set(['maxOutput', 'timeout'])
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set([
  'json',
  'headed',
  'allowFileAccess',
  'enableActions',
  'incognito',
  'noEncryptState',
  'twoPhaseConfirm',
  'grantPermissions',
  'contentBoundaries',
])

/** Shadow-boolean map: `true` iff the CLI EXPLICITLY supplied that scalar. */
export type ExplicitMap = Partial<Record<ScalarField | ListField, boolean>>

/** Result of {@link loadConfig}: the merged file+env config plus provenance. */
export type LoadedConfig = {
  /** Merged user → project → env config (lists concatenated, scalars last-wins). */
  config: SilverConfig
  /** Absolute-ish source labels that actually contributed (for `doctor`/debug). */
  sources: string[]
  /** Non-fatal warnings (unreadable/malformed file). Never thrown. */
  warnings: string[]
}

/** Result of {@link mergeConfig}: the final flags + the shadow-boolean map. */
export type MergedConfig = {
  /** The effective flags the host should act on (config underlaid beneath CLI). */
  flags: ParsedFlags
  /** Per-scalar `<field>Explicit`: was the value pinned by the CLI (not config)? */
  explicit: ExplicitMap
}

/** Options for {@link loadConfig} (all injectable for tests). */
export type LoadConfigOptions = {
  /** Home dir for `~/.silver/config.json`. Default `os.homedir()`. */
  home?: string
  /** Project dir for `silver.json`. Default `process.cwd()`. */
  cwd?: string
  /** Explicit project-config path (overrides `<cwd>/silver.json`). */
  projectFile?: string
  /** Environment to read `SILVER_*` from. Default `process.env`. */
  env?: NodeJS.ProcessEnv
}

/** Coerce one raw JSON value to the typed shape a config field expects. */
function coerceField(field: string, raw: unknown): unknown {
  if (LIST_FIELD_SET.has(field)) {
    if (Array.isArray(raw)) {
      return raw.map((v) => String(v).trim()).filter((v) => v.length > 0)
    }
    if (typeof raw === 'string') {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }
    return undefined
  }
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof raw === 'boolean') return raw
    if (typeof raw === 'string') return /^(1|true|yes|on)$/i.test(raw.trim())
    if (typeof raw === 'number') return raw !== 0
    return undefined
  }
  // string scalar
  if (raw === undefined || raw === null) return undefined
  return String(raw)
}

/** Parse a raw JSON object into a normalized {@link SilverConfig} (unknown keys dropped). */
export function normalizeConfig(raw: unknown): SilverConfig {
  const out: SilverConfig = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  const rec = raw as Record<string, unknown>
  const known: string[] = [...LIST_FIELDS, ...SCALAR_FIELDS]
  for (const field of known) {
    if (!(field in rec)) continue
    const val = coerceField(field, rec[field])
    if (val !== undefined) (out as Record<string, unknown>)[field] = val
  }
  return out
}

/** Read + parse one config file. Returns `null` (with a warning) on any failure. */
function readConfigFile(path: string, warnings: string[], label: string): SilverConfig | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // Missing file is the normal case — not a warning.
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // No path in the warning (no-leak invariant); the label is a fixed token.
    warnings.push(`${label} config is not valid JSON; ignored`)
    return null
  }
  return normalizeConfig(parsed)
}

/** Build a {@link SilverConfig} from `SILVER_*` env vars. */
function envConfig(env: NodeJS.ProcessEnv): SilverConfig {
  const rec: Record<string, unknown> = {}
  for (const [envKey, field] of Object.entries(ENV_MAP)) {
    const v = env[envKey]
    if (v === undefined) continue
    rec[field] = v
  }
  return normalizeConfig(rec)
}

/** Concatenate list fields / last-wins scalars across an ordered layer list. */
function mergeLayers(layers: SilverConfig[]): SilverConfig {
  const out: SilverConfig = {}
  for (const layer of layers) {
    for (const [field, val] of Object.entries(layer)) {
      if (val === undefined) continue
      if (SECURITY_LIST_FIELD_SET.has(field)) {
        // TIGHTEN-ONLY: a more-local (lower-trust) layer may only NARROW the
        // effective allowlist to a subset of the higher-trust one, never ADD
        // hosts. An empty list is "no opinion" (kept from the prior layer). A
        // disjoint layer (would only widen) is rejected so the higher-trust
        // allowlist stands — and a non-empty baseline is never blanked (empty
        // downstream == UNRESTRICTED). See the module doc comment.
        const prev = (out as Record<string, unknown>)[field] as string[] | undefined
        const next = (val as string[]).filter((d) => d.length > 0)
        if (next.length === 0) continue
        if (!prev || prev.length === 0) {
          ;(out as Record<string, unknown>)[field] = [...new Set(next)]
        } else {
          const nextSet = new Set(next)
          const inter = prev.filter((d) => nextSet.has(d))
          ;(out as Record<string, unknown>)[field] = inter.length > 0 ? inter : prev
        }
      } else if (LIST_FIELD_SET.has(field)) {
        const prev = ((out as Record<string, unknown>)[field] as string[]) ?? []
        const next = val as string[]
        // Concatenate + dedupe (order-preserving). For confirmActions, more
        // entries = a stricter confirm fence, so union is itself a tightening.
        const seen = new Set(prev)
        const merged = [...prev]
        for (const item of next) if (!seen.has(item)) (seen.add(item), merged.push(item))
        ;(out as Record<string, unknown>)[field] = merged
      } else {
        ;(out as Record<string, unknown>)[field] = val
      }
    }
  }
  return out
}

/**
 * Load + merge the file/env config layers (user → project → env). The CLI layer
 * is applied later by {@link mergeConfig}. Never throws.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const home = opts.home ?? homedir()
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? process.env
  const warnings: string[] = []
  const sources: string[] = []
  const layers: SilverConfig[] = []

  const userPath = join(home, '.silver', 'config.json')
  const userCfg = readConfigFile(userPath, warnings, 'user')
  if (userCfg) {
    layers.push(userCfg)
    sources.push(userPath)
  }

  const projectPath = opts.projectFile ?? join(cwd, 'silver.json')
  const projectCfg = readConfigFile(projectPath, warnings, 'project')
  if (projectCfg) {
    layers.push(projectCfg)
    sources.push(projectPath)
  }

  const envCfg = envConfig(env)
  if (Object.keys(envCfg).length > 0) {
    layers.push(envCfg)
    sources.push('env')
  }

  return { config: mergeLayers(layers), sources, warnings }
}

// The parser defaults, computed once — the baseline the CLI layer is diffed
// against to decide whether a scalar was set explicitly.
const DEFAULTS: ParsedFlags = parseFlags([])

/** Was scalar `field` supplied on the CLI (i.e. it differs from the parser default)? */
function isScalarExplicit(cli: ParsedFlags, field: ScalarField): boolean {
  const cliVal = (cli as Record<string, unknown>)[field]
  const defVal = (DEFAULTS as Record<string, unknown>)[field]
  return cliVal !== defVal
}

/** Was list `field` supplied on the CLI? */
function isListExplicit(cli: ParsedFlags, field: ListField): boolean {
  // `confirmActions` carries a dedicated provided-flag; the others: non-empty.
  if (field === 'confirmActions') return cli.confirmActionsProvided === true
  const arr = (cli as Record<string, unknown>)[field] as unknown[] | undefined
  return Array.isArray(arr) && arr.length > 0
}

/**
 * Merge a loaded {@link SilverConfig} UNDER a parsed CLI {@link ParsedFlags}.
 *
 * Precedence: CLI beats config for every SCALAR the CLI set explicitly; config
 * fills the rest. LIST fields are the config values FOLLOWED BY the CLI values
 * (config allowlist ∪ CLI allowlist), deduped. Returns the effective flags plus
 * the `<field>Explicit` shadow-boolean map so downstream code never re-derives
 * "did this come from config or the CLI?".
 */
export function mergeConfig(config: SilverConfig, cli: ParsedFlags): MergedConfig {
  const flags: ParsedFlags = { ...cli }
  const explicit: ExplicitMap = {}

  for (const field of SCALAR_FIELDS) {
    const cliExplicit = isScalarExplicit(cli, field)
    explicit[field] = cliExplicit
    if (!cliExplicit && config[field] !== undefined) {
      ;(flags as Record<string, unknown>)[field] = config[field]
    }
  }

  for (const field of LIST_FIELDS) {
    const cliExplicit = isListExplicit(cli, field)
    explicit[field] = cliExplicit
    const fromConfig = (config[field] as string[] | undefined) ?? []
    const fromCli = ((cli as Record<string, unknown>)[field] as string[] | undefined) ?? []
    const seen = new Set<string>()
    const merged: string[] = []
    for (const item of [...fromConfig, ...fromCli]) {
      if (!seen.has(item)) (seen.add(item), merged.push(item))
    }
    ;(flags as Record<string, unknown>)[field] = merged
    // Keep the paired `confirmActionsProvided` truthful post-merge: the gate
    // engages if EITHER layer supplied confirm actions.
    if (field === 'confirmActions') {
      flags.confirmActionsProvided = merged.length > 0
    }
  }

  return { flags, explicit }
}
