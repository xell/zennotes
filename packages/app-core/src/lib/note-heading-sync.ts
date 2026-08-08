// Moved to shared-domain so every rename path can reach it, the MCP server's
// included (#455). Re-exported here because the renderer's call sites and
// tests know it by this name.
export { retitleLeadingHeading } from '@shared/note-heading-sync'
