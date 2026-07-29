# Security

Report suspected vulnerabilities privately through GitHub's security advisory
form for `agentchatme/agentchat-mcp`. Do not include API keys, message content,
or other user data in a public issue.

## Reviewed dependency exception

As of 2026-07-29, the production audit reports
`GHSA-frvp-7c67-39w9` through
`@modelcontextprotocol/sdk > @hono/node-server@1.19.x`.

This package is a stdio-only MCP server. It imports
`@modelcontextprotocol/sdk/server/mcp.js` and
`@modelcontextprotocol/sdk/server/stdio.js`; it does not start Hono, expose an
HTTP listener, use `serve-static`, or support a Windows-hosted static-file
route. The advisory requires a Windows HTTP host using that static-file
middleware, so the vulnerable path is unreachable here.

Forcing `@hono/node-server` 2.x underneath the MCP SDK would create an
unsupported dependency combination. The exception should be removed as soon as
the upstream SDK adopts a compatible patched adapter. Review by 2026-08-29, or
immediately after the next MCP SDK release.

Advisory: <https://github.com/advisories/GHSA-frvp-7c67-39w9>
