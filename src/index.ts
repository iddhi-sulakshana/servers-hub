#!/usr/bin/env bun
// servers-hub: a single MCP server that starts other (stdio) MCP servers lazily,
// only when a tool on them is first requested, and proxies calls to them.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

type ServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  description?: string;
};

const CONFIG_PATH =
  process.env.SERVERS_HUB_CONFIG ?? join(dirname(import.meta.dir), "servers.json");
const CONNECT_TIMEOUT_MS = Number(process.env.SERVERS_HUB_CONNECT_TIMEOUT_MS ?? 120_000);

// Re-read on every lookup so edits to servers.json apply without restarting the hub.
function loadConfig(): Record<string, ServerConfig> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")).servers ?? {};
}

function getConfig(name: string): ServerConfig {
  const cfg = loadConfig()[name];
  if (!cfg) {
    throw new Error(`Unknown server "${name}". Use list_servers to see what is available.`);
  }
  return cfg;
}

const clients = new Map<string, Promise<Client>>();

function connect(name: string): Promise<Client> {
  const existing = clients.get(name);
  if (existing) return existing;

  const cfg = getConfig(name);
  const pending = (async () => {
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      cwd: cfg.cwd,
      stderr: "inherit",
    });
    const client = new Client({ name: `servers-hub/${name}`, version: "1.0.0" });
    client.onclose = () => clients.delete(name);

    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${CONNECT_TIMEOUT_MS}ms starting "${name}"`)),
        CONNECT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([client.connect(transport), timeout]);
    } catch (err) {
      await transport.close().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return client;
  })();

  clients.set(name, pending);
  pending.catch(() => clients.delete(name));
  return pending;
}

function text(value: unknown): CallToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: body }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const serverArg = {
  server: { type: "string", description: "Server name from list_servers" },
} as const;

const hub = new Server(
  { name: "servers-hub", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Gateway to on-demand MCP servers (SSH hosts and Dokploy instances). " +
      "Nothing is started until needed. Only start a server when the user asks for that " +
      "host/instance. Flow: list_servers -> list_tools(server) -> call_tool(server, tool, arguments).",
  },
);

hub.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_servers",
      description:
        "List the MCP servers available through the hub and whether each is running. Starts nothing.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_tools",
      description:
        "Start the named server if it isn't running, and list its tools (name + short description). " +
        "Some servers have hundreds of tools, so narrow with `filter`, then pass `schemas: true` " +
        "to get input schemas for the matches before calling one.",
      inputSchema: {
        type: "object",
        properties: {
          ...serverArg,
          filter: {
            type: "string",
            description: "Case-insensitive substring matched against tool names and descriptions",
          },
          schemas: { type: "boolean", description: "Include each matching tool's inputSchema" },
        },
        required: ["server"],
      },
    },
    {
      name: "call_tool",
      description:
        "Call a tool on the named server, starting it if needed. Check list_tools first for the tool's input schema.",
      inputSchema: {
        type: "object",
        properties: {
          ...serverArg,
          tool: { type: "string", description: "Tool name as returned by list_tools" },
          arguments: { type: "object", description: "Arguments matching the tool's inputSchema" },
        },
        required: ["server", "tool"],
      },
    },
    {
      name: "stop_server",
      description: "Stop a running server started through the hub.",
      inputSchema: { type: "object", properties: serverArg, required: ["server"] },
    },
  ],
}));

hub.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const args = (req.params.arguments ?? {}) as Record<string, any>;
  try {
    switch (req.params.name) {
      case "list_servers": {
        const servers = Object.entries(loadConfig()).map(([name, cfg]) => ({
          name,
          running: clients.has(name),
          ...(cfg.description ? { description: cfg.description } : {}),
        }));
        return text(servers);
      }
      case "list_tools": {
        const client = await connect(args.server);
        const { tools } = await client.listTools();
        const needle = String(args.filter ?? "").toLowerCase();
        const matches = tools.filter(
          (t) => !needle || `${t.name} ${t.description ?? ""}`.toLowerCase().includes(needle),
        );
        return text({
          total: tools.length,
          matched: matches.length,
          tools: matches.map((t) =>
            args.schemas
              ? { name: t.name, description: t.description, inputSchema: t.inputSchema }
              : { name: t.name, description: t.description?.split("\n")[0].slice(0, 160) },
          ),
        });
      }
      case "call_tool": {
        const client = await connect(args.server);
        const result = await client.callTool({ name: args.tool, arguments: args.arguments ?? {} });
        return result as CallToolResult;
      }
      case "stop_server": {
        const pending = clients.get(args.server);
        if (!pending) return text(`"${args.server}" is not running.`);
        clients.delete(args.server);
        await (await pending).close();
        return text(`Stopped "${args.server}".`);
      }
      default:
        return fail(`Unknown tool "${req.params.name}"`);
    }
  } catch (err) {
    return fail(err);
  }
});

async function shutdown() {
  await Promise.allSettled(
    [...clients.values()].map(async (pending) => (await pending).close()),
  );
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await hub.connect(new StdioServerTransport());
