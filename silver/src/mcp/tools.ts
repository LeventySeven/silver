/**
 * MCP tool table — the second host interface (spec: rust-oracle `mcp.rs`'s
 * per-tool `session` routing arg; DECISION.md §build-step-6).
 *
 * Each entry declares an MCP tool (name + JSON-Schema input) and a pure
 * `buildArgv` that maps the tool's typed arguments to the SAME argv the CLI
 * parses. The server (server.ts) feeds that argv straight into the CLI's
 * `run()` entry, so every tool call flows through the identical dispatch,
 * phase-quarantine registry gate, egress guard, and confirm gate the shell
 * uses. No browser logic is re-implemented here.
 *
 * DESIGN NOTES
 *   - `session` routing arg (default "default") → `--session <name>`: one
 *     detached browser per name, exactly like the CLI. This is the load-bearing
 *     port of the Rust oracle's per-tool `session` arg.
 *   - `enableActions` (default false) on actor tools → appends `--enable-actions`
 *     so the registry admits the actor verb; omit it and the read-only phase
 *     quarantine denies the verb (unchanged security default).
 *   - argv shape is `[verb, ...flags, '--', ...positionals]`. The `--` sentinel
 *     makes every free-text positional (refs, fill/type values, find values)
 *     injection-proof: a value that begins with `-` can never be re-parsed as a
 *     flag (parseFlags treats only the FIRST `--` as the sentinel).
 *
 * KEYLESS: this module maps arguments to argv and nothing else. It never calls a
 * model. MCP is a transport here, not a brain.
 */

/** Context handed to a tool's `buildArgv`: the routing session/namespace, the
 * actor grant, and typed readers over the raw MCP `arguments` object. */
export type ToolCtx = {
  /** Routing session name (`--session`); defaults to "default". */
  session: string
  /** Server-level namespace (`--namespace`), applied to every tool. */
  namespace?: string
  /** Whether the caller granted `--enable-actions` for this actor tool. */
  enableActions: boolean
  str(key: string): string | undefined
  num(key: string): number | undefined
  bool(key: string): boolean
  boolDefault(key: string, def: boolean): boolean
  arr(key: string): string[] | undefined
}

/** A JSON-Schema object (draft-07 subset the MCP `Tool.inputSchema` accepts).
 * Property values are schema fragments (objects), matching the SDK's
 * `Tool.inputSchema.properties: Record<string, object>`. */
type JsonSchemaObject = {
  type: 'object'
  properties: Record<string, object>
  required?: string[]
}

export type ToolSpec = {
  /** MCP tool name, e.g. `silver_snapshot`. */
  name: string
  /** Short human title (annotation). */
  title: string
  /** One-line description shown to the host LLM. */
  description: string
  /** Input JSON Schema (already includes the `session`/`enableActions` args). */
  inputSchema: JsonSchemaObject
  /** True → the tool cannot mutate page/host state (annotation hint only). */
  readOnly?: boolean
  /** Map typed args → CLI argv (fed verbatim to `run()`). */
  buildArgv(ctx: ToolCtx): string[]
}

// ---------------------------------------------------------------------------
// argv helpers
// ---------------------------------------------------------------------------

/** Coerce an optional string to a definite argv token (missing → "" so the
 * underlying handler emits its own `usage`/`bad_request` envelope). */
const s = (v: string | undefined): string => v ?? ''

/** `--namespace <ns>` when a server-level namespace is set, else nothing. */
function nsFlags(ctx: ToolCtx): string[] {
  return ctx.namespace ? ['--namespace', ctx.namespace] : []
}

/** Common global flags: routing session + namespace (+ `--enable-actions` for
 * actor tools that were granted it). */
function gflags(ctx: ToolCtx, actor: boolean): string[] {
  const out = ['--session', ctx.session, ...nsFlags(ctx)]
  if (actor && ctx.enableActions) out.push('--enable-actions')
  return out
}

// ---------------------------------------------------------------------------
// reusable schema fragments
// ---------------------------------------------------------------------------

const SESSION_PROP = {
  type: 'string',
  default: 'default',
  description:
    'Routing session name: one detached browser per name (the safe parallel default). Reuse a name to drive the same browser across calls.',
}
const ENABLE_ACTIONS_PROP = {
  type: 'boolean',
  default: false,
  description:
    'Grant --enable-actions so this mutating verb is admitted by the phase-quarantine registry. Omit (false) to keep the session read-only.',
}
const REF_PROP = {
  type: 'string',
  description: 'Element ref from a prior snapshot, e.g. "@e3" (or "e3").',
}

/** Build an inputSchema, always appending the `session` routing arg (and the
 * `enableActions` grant for actor tools). */
function schema(
  props: Record<string, object>,
  opts: { required?: string[]; actor?: boolean; noSession?: boolean } = {},
): JsonSchemaObject {
  const properties: Record<string, object> = { ...props }
  if (opts.actor) properties.enableActions = ENABLE_ACTIONS_PROP
  if (!opts.noSession) properties.session = SESSION_PROP
  const out: JsonSchemaObject = { type: 'object', properties }
  if (opts.required && opts.required.length > 0) out.required = opts.required
  return out
}

// ---------------------------------------------------------------------------
// the tool table (the agent-useful CORE set from the build spec)
// ---------------------------------------------------------------------------

export const TOOLS: ToolSpec[] = [
  // ---- meta / health ----
  {
    name: 'silver_version',
    title: 'Version',
    description: 'Return silver name + version. Keyless, browser-free health check.',
    readOnly: true,
    inputSchema: schema({}, { noSession: true }),
    buildArgv: () => ['version'],
  },

  // ---- lifecycle ----
  {
    name: 'silver_open',
    title: 'Open page',
    description:
      'Launch (or reuse) the session browser and navigate to a URL. Blocked schemes/hosts fail with navigation_blocked.',
    inputSchema: schema(
      { url: { type: 'string', description: 'URL to open (http/https).' } },
      { required: ['url'] },
    ),
    buildArgv: (c) => ['open', ...gflags(c, false), '--', s(c.str('url'))],
  },
  {
    name: 'silver_close',
    title: 'Close session',
    description: 'Close the current browser session (or all sessions with all:true).',
    inputSchema: schema({
      all: { type: 'boolean', default: false, description: 'Close every active session.' },
    }),
    buildArgv: (c) => ['close', ...(c.bool('all') ? ['--all'] : []), ...gflags(c, false)],
  },

  // ---- perception ----
  {
    name: 'silver_snapshot',
    title: 'Snapshot page',
    description:
      'Accessibility-tree snapshot with stable @ref grounding. Take this after navigation, before clicking/typing.',
    readOnly: true,
    inputSchema: schema({
      interactive: {
        type: 'boolean',
        default: true,
        description: 'Only interactive elements (grounded refs). Set false for the full tree.',
      },
      compact: { type: 'boolean', default: false, description: 'Drop empty structural nodes.' },
      depth: { type: 'integer', minimum: 0, description: 'Limit tree depth.' },
      selector: { type: 'string', description: 'Scope the snapshot to a CSS selector.' },
      includeUrls: { type: 'boolean', default: false, description: 'Include href URLs on links.' },
    }),
    buildArgv: (c) => {
      const a = ['snapshot']
      if (c.boolDefault('interactive', true)) a.push('-i')
      if (c.bool('compact')) a.push('-c')
      const d = c.num('depth')
      if (d !== undefined) a.push('-d', String(d))
      const sel = c.str('selector')
      if (sel) a.push('-s', sel)
      if (c.bool('includeUrls')) a.push('-u')
      a.push(...gflags(c, false))
      return a
    },
  },
  {
    name: 'silver_screenshot',
    title: 'Screenshot',
    description:
      'Capture a screenshot. With a path, saves inside the working dir; without, returns base64 in the envelope.',
    readOnly: true,
    inputSchema: schema({
      path: { type: 'string', description: 'Optional output path (must be inside the working dir).' },
      fullPage: { type: 'boolean', default: false, description: 'Capture the full scrollable page.' },
    }),
    buildArgv: (c) => {
      const a = ['screenshot']
      if (c.bool('fullPage')) a.push('-f')
      a.push(...gflags(c, false))
      const p = c.str('path')
      if (p) a.push('--', p)
      return a
    },
  },

  // ---- query (read-only) ----
  {
    name: 'silver_get',
    title: 'Get property',
    description:
      'Read page/element data: kind = text|value|attr|title|url|count. Pass ref for text/value/attr, selector for count, name for attr.',
    readOnly: true,
    inputSchema: schema(
      {
        kind: { type: 'string', enum: ['text', 'value', 'attr', 'title', 'url', 'count'] },
        ref: REF_PROP,
        selector: { type: 'string', description: 'CSS selector (for kind=count).' },
        name: { type: 'string', description: 'Attribute name (for kind=attr).' },
      },
      { required: ['kind'] },
    ),
    buildArgv: (c) => {
      const kind = s(c.str('kind'))
      const pos: string[] = [kind]
      const ref = c.str('ref')
      const sel = c.str('selector')
      const name = c.str('name')
      if (kind === 'count') {
        if (sel) pos.push(sel)
      } else if (kind === 'text' || kind === 'value' || kind === 'attr') {
        if (ref) pos.push(ref)
      }
      if (kind === 'attr' && name) pos.push(name)
      return ['get', ...gflags(c, false), '--', ...pos]
    },
  },
  {
    name: 'silver_is',
    title: 'Is state',
    description: 'Boolean element state: kind = visible|enabled|checked for a grounded ref.',
    readOnly: true,
    inputSchema: schema(
      {
        kind: { type: 'string', enum: ['visible', 'enabled', 'checked'] },
        ref: REF_PROP,
      },
      { required: ['kind', 'ref'] },
    ),
    buildArgv: (c) => ['is', ...gflags(c, false), '--', s(c.str('kind')), s(c.str('ref'))],
  },
  {
    name: 'silver_wait',
    title: 'Wait',
    description:
      'Wait for a condition. Provide exactly one of: text, url, load (load|domcontentloaded|networkidle), ms, or selector (a CSS selector or ref).',
    readOnly: true,
    inputSchema: schema({
      text: { type: 'string', description: 'Wait for this text to appear.' },
      url: { type: 'string', description: 'Wait for the URL to match.' },
      load: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'] },
      ms: { type: 'integer', minimum: 0, description: 'Wait a fixed number of milliseconds.' },
      selector: { type: 'string', description: 'CSS selector or ref to wait for.' },
    }),
    buildArgv: (c) => {
      const g = gflags(c, false)
      const text = c.str('text')
      const url = c.str('url')
      const load = c.str('load')
      const ms = c.num('ms')
      const sel = c.str('selector')
      if (text !== undefined) return ['wait', '--text', text, ...g]
      if (url !== undefined) return ['wait', '--url', url, ...g]
      if (load !== undefined) return ['wait', '--load', load, ...g]
      if (ms !== undefined) return ['wait', ...g, '--', String(ms)]
      if (sel !== undefined) return ['wait', ...g, '--', sel]
      return ['wait', ...g]
    },
  },
  {
    name: 'silver_extract',
    title: 'Extract',
    description:
      'Keyless ID-grounded extraction. Pass schema (JSON or @file) to build a bundle; pass resolveIds (JSON or @file) to resolve IDs from a prior bundle back to real URLs.',
    readOnly: true,
    inputSchema: schema({
      schema: { type: 'string', description: 'JSON schema string or @file path for the extraction.' },
      instruction: { type: 'string', description: 'Optional extraction instruction passed to the host.' },
      resolveIds: { type: 'string', description: 'JSON id-list (or @file) to resolve against the last bundle.' },
    }),
    buildArgv: (c) => {
      const g = gflags(c, false)
      const resolveIds = c.str('resolveIds')
      if (resolveIds !== undefined) return ['extract', 'resolve', '--ids', resolveIds, ...g]
      const instr = c.str('instruction')
      const extra = instr !== undefined ? ['--instruction', instr] : []
      return ['extract', '--schema', s(c.str('schema')), ...extra, ...g]
    },
  },

  // ---- interaction (actor) ----
  {
    name: 'silver_click',
    title: 'Click',
    description: 'Click a grounded element ref. Requires enableActions:true.',
    inputSchema: schema({ ref: REF_PROP }, { required: ['ref'], actor: true }),
    buildArgv: (c) => ['click', ...gflags(c, true), '--', s(c.str('ref'))],
  },
  {
    name: 'silver_fill',
    title: 'Fill',
    description: 'Clear and fill an input by grounded ref. Requires enableActions:true.',
    inputSchema: schema(
      { ref: REF_PROP, value: { type: 'string', description: 'Text to fill.' } },
      { required: ['ref', 'value'], actor: true },
    ),
    buildArgv: (c) => ['fill', ...gflags(c, true), '--', s(c.str('ref')), s(c.str('value'))],
  },
  {
    name: 'silver_type',
    title: 'Type',
    description: 'Type text into an element by grounded ref. Requires enableActions:true.',
    inputSchema: schema(
      { ref: REF_PROP, value: { type: 'string', description: 'Text to type.' } },
      { required: ['ref', 'value'], actor: true },
    ),
    buildArgv: (c) => ['type', ...gflags(c, true), '--', s(c.str('ref')), s(c.str('value'))],
  },
  {
    name: 'silver_press',
    title: 'Press key',
    description: 'Press a key on a grounded ref, e.g. Enter or Control+a. Requires enableActions:true.',
    inputSchema: schema(
      { ref: REF_PROP, key: { type: 'string', description: 'Key name, e.g. Enter, Tab, Control+a.' } },
      { required: ['ref', 'key'], actor: true },
    ),
    buildArgv: (c) => ['press', ...gflags(c, true), '--', s(c.str('ref')), s(c.str('key'))],
  },
  {
    name: 'silver_find',
    title: 'Find',
    description:
      'Locate an element semantically (kind = role|text|label|placeholder|testid|first|last|nth) and optionally act on it. Requires enableActions:true.',
    inputSchema: schema(
      {
        kind: {
          type: 'string',
          enum: ['role', 'text', 'label', 'placeholder', 'testid', 'first', 'last', 'nth'],
        },
        value: { type: 'string', description: 'Role, text, label, selector, or test id.' },
        action: {
          type: 'string',
          description: 'Optional action: click|fill|type|hover|focus|check|uncheck|text.',
        },
        text: { type: 'string', description: 'Text/value for a fill or type action.' },
        name: { type: 'string', description: 'Accessible-name filter (for kind=role).' },
        index: { type: 'integer', description: 'Index (for kind=nth).' },
      },
      { required: ['kind', 'value'], actor: true },
    ),
    buildArgv: (c) => {
      const flags: string[] = []
      const name = c.str('name')
      if (name !== undefined) flags.push('--name', name)
      const index = c.num('index')
      if (index !== undefined) flags.push('--index', String(index))
      const pos: string[] = [s(c.str('kind')), s(c.str('value'))]
      const action = c.str('action')
      if (action !== undefined) pos.push(action)
      const text = c.str('text')
      if (text !== undefined) pos.push(text)
      return ['find', ...gflags(c, true), ...flags, '--', ...pos]
    },
  },

  // ---- tabs ----
  {
    name: 'silver_tab',
    title: 'Tabs',
    description:
      'Manage tabs: action = list|new|switch|close. new takes url/label; switch/close take tab (id or label).',
    inputSchema: schema({
      action: { type: 'string', enum: ['list', 'new', 'switch', 'close'], default: 'list' },
      url: { type: 'string', description: 'URL for action=new.' },
      label: { type: 'string', description: 'Durable label for action=new.' },
      tab: { type: 'string', description: 'Tab id (tN) or label for switch/close.' },
    }),
    buildArgv: (c) => {
      const action = c.str('action') ?? 'list'
      const g = gflags(c, false)
      if (action === 'new') {
        const f: string[] = []
        const label = c.str('label')
        if (label) f.push('--label', label)
        const url = c.str('url')
        return ['tab', ...f, ...g, '--', 'new', ...(url ? [url] : [])]
      }
      if (action === 'switch') return ['tab', ...g, '--', s(c.str('tab'))]
      if (action === 'close') {
        const tab = c.str('tab')
        return ['tab', ...g, '--', 'close', ...(tab ? [tab] : [])]
      }
      return ['tab', ...g, '--', 'list']
    },
  },

  // ---- session (meta; namespace-scoped) ----
  {
    name: 'silver_session',
    title: 'Sessions',
    description:
      'Session management: action = list|id|gc. id accepts scope (cwd|worktree|git-root) and prefix.',
    readOnly: true,
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['list', 'id', 'gc'], default: 'list' },
        scope: { type: 'string', description: 'Scope for action=id (cwd|worktree|git-root).' },
        prefix: { type: 'string', description: 'Prefix for action=id.' },
      },
      { noSession: true },
    ),
    buildArgv: (c) => {
      const action = c.str('action') ?? 'list'
      const ns = nsFlags(c)
      if (action === 'id') {
        const f: string[] = []
        const scope = c.str('scope')
        if (scope) f.push('--scope', scope)
        const prefix = c.str('prefix')
        if (prefix) f.push('--prefix', prefix)
        return ['session', ...f, ...ns, 'id']
      }
      if (action === 'gc') return ['session', ...ns, 'gc']
      return ['session', ...ns, 'list']
    },
  },

  // ---- task-as-artifact layer ----
  {
    name: 'silver_task',
    title: 'Task artifact',
    description:
      'Task run-folder artifact: action = start|log|checkpoint|status|list|resume|exec. exec re-runs an inner silver command (requires enableActions:true).',
    inputSchema: schema(
      {
        action: {
          type: 'string',
          enum: ['start', 'log', 'checkpoint', 'status', 'list', 'resume', 'exec'],
        },
        id: { type: 'string', description: 'Task id (required for all but start/list).' },
        goal: { type: 'string', description: 'Goal text (for action=start).' },
        note: { type: 'string', description: 'Checkpoint note (for action=checkpoint).' },
        event: { type: 'string', description: 'Event JSON (for action=log).' },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Inner silver argv tokens (for action=exec).',
        },
      },
      { required: ['action'], actor: true },
    ),
    buildArgv: (c) => {
      const action = s(c.str('action'))
      const ns = nsFlags(c)
      const id = c.str('id')
      if (action === 'start') {
        const f: string[] = []
        if (id) f.push('--id', id)
        return ['task', ...f, ...ns, '--', 'start', s(c.str('goal'))]
      }
      if (action === 'log') return ['task', ...ns, '--', 'log', s(id), s(c.str('event'))]
      if (action === 'checkpoint') {
        const f: string[] = []
        const note = c.str('note')
        if (note !== undefined) f.push('--note', note)
        return ['task', ...f, ...ns, '--', 'checkpoint', s(id)]
      }
      if (action === 'status') return ['task', ...ns, '--', 'status', s(id)]
      if (action === 'resume') return ['task', ...ns, '--', 'resume', s(id)]
      if (action === 'exec') {
        const ea = c.enableActions ? ['--enable-actions'] : []
        const cmd = c.arr('command') ?? []
        // `exec` + id sit BEFORE the sentinel (both safe); the inner command
        // follows `--` so the layer re-dispatches it verbatim through run().
        return ['task', ...ea, ...ns, 'exec', s(id), '--', ...cmd]
      }
      return ['task', ...ns, 'list']
    },
  },

  // ---- grep-first memory layer ----
  {
    name: 'silver_memory',
    title: 'Memory',
    description: 'Grep-first markdown memory: action = add|search|list. add takes text (+ optional tag); search takes query.',
    inputSchema: schema({
      action: { type: 'string', enum: ['add', 'search', 'list'], default: 'list' },
      text: { type: 'string', description: 'Note text (for action=add).' },
      query: { type: 'string', description: 'Search query (for action=search).' },
      tag: { type: 'string', description: 'Comma-separated tags (for action=add).' },
    }),
    buildArgv: (c) => {
      const action = c.str('action') ?? 'list'
      const ns = nsFlags(c)
      if (action === 'add') {
        const f: string[] = []
        const tag = c.str('tag')
        if (tag) f.push('--tag', tag)
        return ['memory', ...f, ...ns, '--', 'add', s(c.str('text'))]
      }
      if (action === 'search') return ['memory', ...ns, '--', 'search', s(c.str('query'))]
      return ['memory', ...ns, 'list']
    },
  },

  // ---- subagent orchestration layer ----
  {
    name: 'silver_subagent',
    title: 'Subagent',
    description:
      'Subagent orchestration: action = spawn|wait|done|fail|status|list. spawn provisions a child (requires enableActions:true); childSession/tab/background shape where it runs.',
    inputSchema: schema(
      {
        action: {
          type: 'string',
          enum: ['spawn', 'wait', 'done', 'fail', 'status', 'list'],
          default: 'list',
        },
        prompt: { type: 'string', description: 'Child prompt (for action=spawn).' },
        childSession: { type: 'string', description: 'Child session name (for action=spawn).' },
        tab: { type: 'boolean', default: false, description: 'Run the child on its own tab (spawn).' },
        background: { type: 'boolean', default: false, description: 'Non-blocking child (spawn).' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Child ids (for action=wait).' },
        id: { type: 'string', description: 'Child id (for status/done/fail).' },
        enableActions: ENABLE_ACTIONS_PROP,
      },
      { noSession: true },
    ),
    buildArgv: (c) => {
      const action = c.str('action') ?? 'list'
      const ns = nsFlags(c)
      const ea = c.enableActions ? ['--enable-actions'] : []
      if (action === 'spawn') {
        const f: string[] = []
        const child = c.str('childSession')
        if (child) f.push('--session', child)
        if (c.bool('tab')) f.push('--tab')
        if (c.bool('background')) f.push('--background')
        return ['subagent', ...ea, ...f, ...ns, '--', 'spawn', s(c.str('prompt'))]
      }
      if (action === 'wait') return ['subagent', ...ns, '--', 'wait', ...(c.arr('ids') ?? [])]
      if (action === 'done') return ['subagent', ...ns, '--', 'done', s(c.str('id'))]
      if (action === 'fail') return ['subagent', ...ns, '--', 'fail', s(c.str('id'))]
      if (action === 'status') return ['subagent', ...ns, '--', 'status', s(c.str('id'))]
      return ['subagent', ...ns, 'list']
    },
  },
]

/** Fast lookup by tool name. */
export const TOOL_BY_NAME: ReadonlyMap<string, ToolSpec> = new Map(TOOLS.map((t) => [t.name, t]))
