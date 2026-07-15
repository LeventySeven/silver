/**
 * MCP interface barrel — silver's second host interface.
 *
 * `runMcp` is the entry the CLI dispatches for the `silver mcp` META verb; the
 * rest is exported for tests and embedders. KEYLESS: nothing here calls a model.
 */
export { runMcp, buildServer, callTool, listToolDescriptors } from './server.js'
export type { McpServerOptions } from './server.js'
export { TOOLS, TOOL_BY_NAME } from './tools.js'
export type { ToolSpec, ToolCtx } from './tools.js'
