# servers-hub

One MCP server that starts other stdio MCP servers **on demand**. Nothing in
`servers.json` is launched at Claude Code startup; a server starts the first time
one of its tools is requested and stays up for the rest of the session.

## Setup

    bun install
    cp servers.example.json servers.json && chmod 600 servers.json
    claude mcp add -s user servers-hub -- bun /path/to/servers-hub/src/index.ts

## Tools

- `list_servers` – names + running state (starts nothing)
- `list_tools(server, filter?, schemas?)` – starts the server, lists its tools; use
  `filter` for big servers (Dokploy has ~600 tools), `schemas: true` for input schemas
- `call_tool(server, tool, arguments)` – proxies a call
- `stop_server(server)`

## Config

`servers.json` (gitignored, `chmod 600`, holds credentials), same shape as
`servers.example.json`. It is re-read on each lookup, so edits apply without a
restart. Override the path with `SERVERS_HUB_CONFIG`, and the server start
timeout (default 120000 ms) with `SERVERS_HUB_CONNECT_TIMEOUT_MS`.
