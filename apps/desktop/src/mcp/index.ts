#!/usr/bin/env node
/**
 * Legacy stdio entry for the ZenNotes MCP server. The real
 * implementation lives in ./server. Existing user installs (Claude
 * Code / Desktop / Codex configs that already point at this file)
 * keep working through this shim; new installs prefer the unified
 * `zn mcp` subcommand wired by mcp-integrations.ts.
 */

import { runMcpServer } from './server.js'

runMcpServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[zennotes-mcp] fatal', err)
  process.exit(1)
})
