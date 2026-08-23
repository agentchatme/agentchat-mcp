// ─── Public library entry ──────────────────────────────────────────────────
//
// `import { buildMcpServer } from '@agentchatme/mcp'` — the transport-
// agnostic tool core, for hosting the same AgentChat tools behind transports
// other than the bundled stdio binary (e.g. the hosted Streamable HTTP
// endpoint). The bin entry (`npx @agentchatme/mcp` → dist/index.js) remains
// the stdio server and is unchanged.
//
// This entry MUST stay side-effect free: importing it never starts a server,
// reads process.env, or touches the filesystem.

export { buildMcpServer, type BuildMcpServerOptions } from './core.js'
export { PACKAGE_VERSION } from './version.js'
