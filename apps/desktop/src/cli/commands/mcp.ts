/**
 * `zn mcp` — start the MCP server in stdio mode. The CLI process
 * effectively becomes the MCP server for as long as the calling
 * client (Claude Code, Claude Desktop, Codex) keeps the stdin pipe
 * open. We delegate to the same runMcpServer() the legacy
 * out/main/mcp.js entry uses, so behavior is identical.
 */

import { runMcpServer } from '../../mcp/server.js'

export async function cmdMcp(): Promise<void> {
  await runMcpServer()
  // The MCP SDK's connect() returns once stdin/stdout listeners are
  // wired up. Node's event loop keeps the process alive while those
  // listeners exist — but the CLI dispatcher would otherwise see this
  // promise resolve and call process.exit(0), tearing down stdin
  // before the client can send any requests. Awaiting indefinitely
  // here pins the process to whatever lifetime the parent client
  // (Claude Code / Desktop / Codex) chooses to give it.
  await new Promise<void>(() => {})
}
