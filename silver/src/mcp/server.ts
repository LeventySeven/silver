/**
 * `silver mcp` — a stdio MCP server exposing silver's verbs as MCP tools
 * (DECISION.md §build-step-6; rust-oracle `mcp.rs` is the design spec).
 *
 * This is silver's SECOND host interface. Where the shell drives silver one
 * argv at a time, an MCP-native host (Claude Desktop, an agent runtime, …) can
 * now drive the SAME verbs as typed tools over stdio JSON-RPC. Every tool call
 * is mapped to argv (tools.ts) and fed straight into the CLI's `run()` entry —
 * so the phase-quarantine registry, egress guard, output neutralization, and
 * paid/destructive confirm gate all still apply, because they live INSIDE the
 * handlers `run()` dispatches to. Nothing is re-implemented here.
 *
 * KEYLESS: the server NEVER calls a model. MCP is a transport, not a brain — it
 * only routes typed tool calls to silver's keyless handlers and returns the
 * `{success,data,error}` envelope as tool text content. No provider key is ever
 * needed or used, preserving silver's keyless invariant.
 *
 * We use the SDK's LOW-LEVEL `Server` (not the zod-based `McpServer`) so silver
 * takes on no direct `zod` dependency: request schemas come from the SDK, and
 * tool input schemas are plain JSON Schema returned from tools/list.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'

import { ok, type Envelope } from '../core/envelope.js'
import type { ParsedFlags } from '../core/flags.js'
import { TOOLS, TOOL_BY_NAME, type ToolCtx } from './tools.js'

const SERVER_NAME = 'silver'
const SERVER_VERSION = '0.1.0'

/** Options captured from the `silver mcp` invocation (server-level, constant
 * for the whole session). */
export type McpServerOptions = {
  /** Applied to every tool call as `--namespace <ns>` when set. */
  namespace?: string
}

// ---------------------------------------------------------------------------
// arguments → ToolCtx
// ---------------------------------------------------------------------------

/** Build the typed reader context over one tool call's raw `arguments`. */
function makeCtx(raw: Record<string, unknown>, opts: McpServerOptions): ToolCtx {
  const str = (key: string): string | undefined => {
    const v = raw[key]
    return typeof v === 'string' ? v : undefined
  }
  const num = (key: string): number | undefined => {
    const v = raw[key]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const bool = (key: string): boolean => raw[key] === true
  const boolDefault = (key: string, def: boolean): boolean => {
    const v = raw[key]
    return typeof v === 'boolean' ? v : def
  }
  const arr = (key: string): string[] | undefined => {
    const v = raw[key]
    if (!Array.isArray(v)) return undefined
    return v.filter((x): x is string => typeof x === 'string')
  }

  const sessionRaw = str('session')
  const session = sessionRaw && sessionRaw.length > 0 ? sessionRaw : 'default'

  const ctx: ToolCtx = {
    session,
    enableActions: bool('enableActions'),
    str,
    num,
    bool,
    boolDefault,
    arr,
  }
  if (opts.namespace) ctx.namespace = opts.namespace
  return ctx
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

/** MCP `Tool` descriptors for tools/list — pure JSON Schema, no zod. */
export function listToolDescriptors(): Tool[] {
  return TOOLS.map((t) => {
    const tool: Tool = {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: {
        title: t.title,
        ...(t.readOnly ? { readOnlyHint: true } : {}),
      },
    }
    return tool
  })
}

// ---------------------------------------------------------------------------
// tools/call — route to the SAME run() the CLI uses
// ---------------------------------------------------------------------------

/**
 * Execute one MCP tool call by mapping it to argv and invoking the CLI's
 * `run()` entry. Returns the silver envelope as JSON text content; `isError`
 * mirrors the envelope's `success` so hosts can branch without parsing.
 *
 * `run()` is imported dynamically to keep the module graph acyclic (cli.ts is
 * the entry that starts this server) — the exact pattern task/index.ts uses.
 */
export async function callTool(
  name: string,
  rawArgs: Record<string, unknown>,
  opts: McpServerOptions,
): Promise<CallToolResult> {
  const spec = TOOL_BY_NAME.get(name)
  if (!spec) {
    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    }
  }

  const ctx = makeCtx(rawArgs, opts)
  const argv = spec.buildArgv(ctx)

  const { run } = await import('../cli.js')
  const { env } = await run(argv)

  return {
    content: [{ type: 'text', text: JSON.stringify(env) }],
    isError: !env.success,
  }
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

/** Build the low-level MCP `Server` with tools/list + tools/call wired to
 * silver. Exposed for in-process tests (which drive it via a linked transport
 * pair) without spawning a child. */
export function buildServer(opts: McpServerOptions): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Drive a browser with the keyless silver_* tools. Call silver_open then silver_snapshot to obtain stable @ref grounding before clicking/typing. Mutating tools require enableActions:true. Use the session arg to route parallel work to separate browsers.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listToolDescriptors() }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    return callTool(request.params.name, args, opts)
  })

  return server
}

/**
 * Start the stdio MCP server loop and resolve only when the transport closes
 * (stdin EOF or a client shutdown). Returns a success envelope so the CLI
 * dispatcher has something to print AFTER the session ends — never during it
 * (stdout is reserved for JSON-RPC while connected).
 */
export async function runMcp(flags: ParsedFlags): Promise<Envelope<unknown>> {
  const opts: McpServerOptions = {}
  if (flags.namespace) opts.namespace = flags.namespace

  const server = buildServer(opts)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Resolve on the FIRST shutdown signal: an explicit server/transport close, or
  // stdin reaching EOF (the host disconnected). StdioServerTransport does not
  // itself close on stdin 'end', so we watch the stream directly to guarantee a
  // deterministic, clean exit instead of relying on event-loop drain.
  await new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      process.stdin.off('end', finish)
      process.stdin.off('close', finish)
      resolve()
    }
    server.onclose = finish
    process.stdin.on('end', finish)
    process.stdin.on('close', finish)
  })

  return ok({ mcp: 'closed', tools: TOOLS.length })
}
