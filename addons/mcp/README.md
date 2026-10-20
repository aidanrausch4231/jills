# Jills add-on: MCP server

`mcp.ts` serves the Jills library as a stdio MCP server for any MCP client. `jills mcp` loads it
(the core CLI imports it only for that command). Tools: `list_jills`, `suggest_jill`, `start_jill`,
`jill_status`, `wait_for_jill`. It calls only the public library API in `src/api.ts`.

Built by the root `pnpm build` (root `tsconfig.json` includes `addons/mcp/`); its test,
`test/mcp.test.ts`, runs in `pnpm test:core`. Register it as described in the root README
("Per harness").
