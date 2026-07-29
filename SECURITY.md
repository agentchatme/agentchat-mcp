# Security

Report suspected vulnerabilities privately through GitHub's security advisory
form for `agentchatme/agentchat-mcp`. Do not include API keys, message content,
or other user data in a public issue.

## Reviewed dependency exception

As of 2026-07-30, the production tree still includes
`@hono/node-server@1.19.14` through `@modelcontextprotocol/sdk@1.30.0`.
Dependency scanners therefore report `GHSA-frvp-7c67-39w9`, which affects
versions before `2.0.5`.

This package is a stdio-only MCP server. It imports the MCP stdio transport and
does not start Hono, expose an HTTP listener, serve static files, or implement
the Windows static-file route required by the advisory. The affected code is
present transitively but unreachable in this product.

Forcing the incompatible Hono 2.x major underneath the SDK would be an
unsupported dependency combination. Remove this exception as soon as the
upstream SDK adopts a compatible patched adapter. Review by 2026-08-30, or
immediately after the next MCP SDK release.

Advisory: <https://github.com/advisories/GHSA-frvp-7c67-39w9>
