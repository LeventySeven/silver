/**
 * MCP host-interface tests (build-step-6).
 *
 * Drives the REAL `buildServer()` over the SDK's in-memory linked transport pair
 * — no child process, no reliance on a shared full build that a sibling may be
 * racing. Asserts: the server initializes, tools/list exposes the CORE verbs
 * each carrying a `session` routing arg, and a read-only tool round-trips its
 * `{success,data,error}` envelope end-to-end. Also asserts the phase-quarantine
 * still bites through the MCP path (an actor tool without `enableActions` is
 * denied) — the security gate is not bypassed by the second interface.
 *
 * KEYLESS: no model is ever called; MCP is a transport only.
 */
import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildServer } from '../../src/mcp/server.js'
import { ERRORS } from '../../src/core/errors.js'

/** Stand up buildServer() wired to an in-process Client via a linked pair. */
async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = buildServer({})
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** Parse a tool result's text content back into the silver envelope. */
function envelopeOf(result: { content: Array<{ type: string; text?: string }> }): {
  success: boolean
  data: unknown
  error: string | null
} {
  const first = result.content[0]
  expect(first.type).toBe('text')
  return JSON.parse(first.text ?? '') as { success: boolean; data: unknown; error: string | null }
}

// The agent-useful CORE set the build spec asked for.
const CORE_TOOLS = [
  'silver_snapshot',
  'silver_open',
  'silver_click',
  'silver_fill',
  'silver_type',
  'silver_press',
  'silver_get',
  'silver_is',
  'silver_wait',
  'silver_extract',
  'silver_find',
  'silver_screenshot',
  'silver_tab',
  'silver_session',
  'silver_task',
  'silver_memory',
  'silver_subagent',
  'silver_close',
]

describe('mcp server (in-process, real buildServer over a linked transport)', () => {
  it('lists the core tools, each browser tool carrying a session routing arg', async () => {
    const client = await connectedClient()
    try {
      const { tools } = await client.listTools()
      const names = new Set(tools.map((t) => t.name))
      for (const name of CORE_TOOLS) {
        expect(names.has(name), `missing tool ${name}`).toBe(true)
      }

      // Every browser-driving tool exposes the `session` routing arg (the load-
      // bearing port of the Rust oracle's per-tool session routing).
      const snapshot = tools.find((t) => t.name === 'silver_snapshot')
      expect(snapshot?.inputSchema.properties).toHaveProperty('session')
      const click = tools.find((t) => t.name === 'silver_click')
      expect(click?.inputSchema.properties).toHaveProperty('session')
      // Actor tools additionally expose the `enableActions` grant.
      expect(click?.inputSchema.properties).toHaveProperty('enableActions')
    } finally {
      await client.close()
    }
  })

  it('round-trips a read-only tool (silver_version) end-to-end', async () => {
    const client = await connectedClient()
    try {
      const result = await client.callTool({ name: 'silver_version', arguments: {} })
      expect(result.isError).toBeFalsy()
      const env = envelopeOf(result as never)
      expect(env.success).toBe(true)
      expect((env.data as { name: string }).name).toBe('silver')
    } finally {
      await client.close()
    }
  })

  it('round-trips a read-only tool (silver_session list) end-to-end', async () => {
    const client = await connectedClient()
    try {
      const result = await client.callTool({
        name: 'silver_session',
        arguments: { action: 'list' },
      })
      expect(result.isError).toBeFalsy()
      const env = envelopeOf(result as never)
      expect(env.success).toBe(true)
      expect(Array.isArray((env.data as { sessions: unknown[] }).sessions)).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('preserves the phase quarantine: an actor tool without enableActions is denied', async () => {
    const client = await connectedClient()
    try {
      const result = await client.callTool({
        name: 'silver_click',
        arguments: { ref: '@e1', session: `mcp-quarantine-${process.pid}` },
      })
      expect(result.isError).toBe(true)
      const env = envelopeOf(result as never)
      expect(env.success).toBe(false)
      expect(env.error).toBe(ERRORS.not_permitted.message)
    } finally {
      await client.close()
    }
  })

  it('reports an unknown tool as an error result (never a crash)', async () => {
    const client = await connectedClient()
    try {
      const result = await client.callTool({ name: 'silver_does_not_exist', arguments: {} })
      expect(result.isError).toBe(true)
      const first = (result.content as Array<{ type: string; text?: string }>)[0]
      expect(first.text).toContain('unknown tool')
    } finally {
      await client.close()
    }
  })
})
