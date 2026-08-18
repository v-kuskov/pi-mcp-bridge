# pi-mcp-bridge

> A [Pi Agent](https://pi.dev/docs/latest/extensions) extension that bridges any [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server into Pi using **three LLM-callable tools** — `CallMcpTool`, `FetchMcpResource`, and `ListMcpResources` — plus a **filesystem-first registry** and **Cursor-style system-prompt injection** that keeps the agent's context window cheap and cache-friendly.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20.19-green.svg)](./package.json)
[![Specs: OpenSpec](https://img.shields.io/badge/OpenSpec-phase--1--core-orange)](./openspec/)

**English** · [简体中文](./README.zh-CN.md)

---

## Why

Cursor's [Dynamic Context Discovery](https://cursor.com/cn/blog/dynamic-context-discovery) essay makes a sharp observation: exposing every MCP tool directly to the LLM bloats the system prompt and burns context. The fix is to expose only a few generic tools and let the model fetch specific tool schemas on demand from a compact, discoverable registry.

`pi-mcp-bridge` brings that pattern to the Pi Agent — and aligns with how Cursor actually does it:

- **`CallMcpTool`** — call any MCP tool by `server` + `toolName` + `arguments`.
- **`FetchMcpResource`** — read any MCP resource by `server` + `uri`, optionally saving to disk.
- **`ListMcpResources`** — list the resources exposed by a server (discover before you fetch).
- **Filesystem is everything** — each MCP server is described by `registry/<server>/meta.json` + `registry/<server>/tools/<tool>.json`. The agent reads these files to learn *how* to call a tool, then invokes `CallMcpTool` with the right arguments.
- **Cursor-style system-prompt injection** — on each turn, a compact Markdown index of the registry is **appended to the system prompt** via the `before_agent_start` event (not prepended as a user message). The system prompt is the most stable cache prefix, so the block is cached across turns as long as the registry doesn't change. For small registries (≤ 10 tools by default), full `inputSchema`s are inlined so the model can call correctly on the first try; for larger registries, the block falls back to names + descriptions and the model reads schema files on demand.
- **Server `instructions` captured** — the MCP protocol's `InitializeResult.instructions` (the server's own description of its purpose and usage) is captured at sync time, persisted to `meta.json`, and rendered as a blockquote under each server header — so the model sees the server's intended usage pattern, not just our tool descriptions.
- **Lazy by default** — MCP servers connect only when their tools are called, and disconnect after a configurable idle timeout.
- **No vendor lock-in** — the registry is plain JSON. You can `git diff` it, hand-edit it, or generate it from a live MCP server with `/mcp-bridge sync`.

## Architecture (60-second tour)

```
┌──────────────────────────────────────────────────────────────────┐
│  Pi Agent (LLM)                                                  │
│    system prompt  ◀──  MCP registry block appended via           │
│                       before_agent_start (Cursor-style)           │
│    tools: [CallMcpTool, FetchMcpResource, ListMcpResources]      │
└───────────────┬──────────────────────────────────────────────────┘
                │ CallMcpTool({server, toolName, arguments})
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  pi-mcp-bridge                                                   │
│   1. resolve (server, toolName) → registry/<server>/tools/*.json │
│   2. lazy connect to that MCP server (idle timeout)              │
│   3. forward arguments, await result                             │
│   4. output-guard: truncate + spill to temp file                  │
│   5. return ContentBlocks to Pi                                  │
└───────────────┬──────────────────────────────────────────────────┘
                │ MCP protocol (stdio / HTTP / SSE)
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  MCP servers (filesystem, github, slack, …)                      │
└──────────────────────────────────────────────────────────────────┘
```

See [`docs/architecture.md`](./docs/architecture.md) for the full module map, design decisions, and behavior contracts.

## Quick start

### 1. Install

```bash
pi install npm:@qianhuan-lxs/pi-mcp-bridge
```

This installs the package under `~/.pi/agent/npm/` and auto-registers the extension via its `pi.extensions` manifest — no manual config editing required.

> **Note:** `pi install` requires Pi v0.74+. If you're on an older Pi or want to manage it manually, add `"@qianhuan-lxs/pi-mcp-bridge"` to the `packages` array in your `~/.pi/agent/settings.json`.

### 2. Register the extension

Add to your Pi agent config (e.g. `~/.pi/agent.json`):

```jsonc
{
  "extensions": [
    "pi-mcp-bridge"
  ]
}
```

### 3. Add an MCP server to the registry

#### stdio — context7 (library docs lookup)

```
# Inside Pi — sync a live MCP server's tools into the registry (primary path)
/mcp-bridge sync context7 -- npx -y @upstash/context7-mcp

# Or add a server stub first (with an env var), then sync
/mcp-bridge add github --env GITHUB_PERSONAL_ACCESS_TOKEN -- npx -y @modelcontextprotocol/server-github
/mcp-bridge sync github

# Validate / list / check status
/mcp-bridge validate
/mcp-bridge list
/mcp-bridge status
```

#### Streamable HTTP (modern MCP HTTP transport)

Start the server in a separate terminal:

```bash
npx -y @modelcontextprotocol/server-everything streamableHttp
# serves at http://localhost:3000/mcp
```

Then in Pi:

```
/mcp-bridge add everything-http --url http://localhost:3000/mcp --description "Everything MCP (Streamable HTTP)"
/mcp-bridge sync everything-http
```

#### SSE (legacy HTTP transport)

Start the server in a separate terminal:

```bash
npx -y @modelcontextprotocol/server-everything sse
# serves at http://localhost:3001/sse
```

Then in Pi:

```
/mcp-bridge add everything-sse --url http://localhost:3001/sse --description "Everything MCP (SSE)"
/mcp-bridge sync everything-sse
```

> **Transport auto-detection:** for `kind: "http"` servers, `/mcp-bridge sync` and lazy-connect both probe **StreamableHTTP first** and fall back to **SSE** automatically — you don't pick the transport explicitly; the URL is enough.

> **Why slash commands?** Registry management happens inside Pi via `/mcp-bridge ...` so there's no PATH setup and no separate CLI binary to install. An optional `cli.ts` is still included for scripting — run it via `npx tsx ./node_modules/@qianhuan-lxs/pi-mcp-bridge/cli.ts <cmd>`.

This produces:

```
~/.pi/agent/mcp-registry/
  context7/
    meta.json
    tools/
      resolve-library-id.json
      query-docs.json
      ...
  everything-http/
    meta.json
    tools/...
  index.json
```

### 4. Restart Pi and ask

```
> use context7 to look up the latest AgentScope documentation
```

The agent will:

1. Read the MCP registry block from its **system prompt** (injected via `before_agent_start`). For small registries the full `inputSchema` is already inline; for large ones it sees the server's `folder:` path and reads `<folder>/tools/<tool>.json` on demand.
2. Call `CallMcpTool({server:"context7", toolName:"resolve-library-id", arguments:{...}})`, then `CallMcpTool({server:"context7", toolName:"query-docs", arguments:{...}})`.
3. Receive the result (truncated if large, with a temp-file spill for the full content).

To discover resources first, use `ListMcpResources({server:"..."})`, then `FetchMcpResource({server, uri})`.

## Registry layout

```
~/.pi/agent/mcp-registry/
  <server>/
    meta.json          # server config: command, env, transport, timeouts, instructions
    tools/
      <tool>.json      # one file per tool: name, description, inputSchema
  index.json           # aggregate index (rebuilt by `sync` / `validate`)
```

`meta.json` example (stdio — context7):

```json
{
  "name": "context7",
  "description": "Context7 documentation MCP server",
  "instructions": "Use this server to fetch up-to-date documentation for libraries. Always call resolve-library-id first, then query-docs.",
  "transport": {
    "kind": "stdio",
    "command": "npx",
    "args": ["-y", "@upstash/context7-mcp"],
    "env": {}
  },
  "auth": { "kind": "none" },
  "lifecycle": { "mode": "lazy", "idleTimeoutMinutes": 10 },
  "syncedFrom": "live-server",
  "syncedAt": "2026-07-19T06:00:00.000Z"
}
```

`meta.json` example (HTTP — Streamable HTTP or SSE, same shape):

```json
{
  "name": "everything-http",
  "description": "Everything MCP (Streamable HTTP)",
  "transport": {
    "kind": "http",
    "url": "http://localhost:3000/mcp",
    "headers": {}
  },
  "auth": { "kind": "none" },
  "lifecycle": { "mode": "lazy", "idleTimeoutMinutes": 10 },
  "syncedFrom": "live-server",
  "syncedAt": "2026-07-19T06:00:00.000Z"
}
```

> `instructions` is captured automatically from the MCP server's `initialize` response during `/mcp-bridge sync`. You can also hand-edit it. For HTTP servers, the transport kind is just `"http"` — sync and lazy-connect auto-probe StreamableHTTP then fall back to SSE.

`tools/resolve-library-id.json` example:

```json
{
  "name": "resolve-library-id",
  "description": "Resolve a Context7-compatible library ID from a library name.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "libraryName": { "type": "string" }
    },
    "required": ["query", "libraryName"]
  }
}
```

See [`docs/config-format.md`](./docs/config-format.md) for the full schema reference.

## Context injection (how the model learns about MCP)

The injected block is appended to the **system prompt** on every turn via the `before_agent_start` event. It walks a truncation ladder (most detail first; first level that fits the token budget wins):

| Level | Content | When used |
|-------|---------|-----------|
| 1. `renderWithSchemas` | tool names + descriptions + **full `inputSchema` JSON inline** + server `instructions` | registry ≤ `schemaInjectionToolLimit` tools (default 10) AND fits budget |
| 2. `renderFull(80)` | tool names + 80-char descriptions + server `instructions` | level 1 skipped/overflowed |
| 3. `renderFull(40)` | tool names + 40-char descriptions + `instructions` | level 2 overflowed |
| 4. `renderKeysOnly` | tool keys only + `instructions` | level 3 overflowed |
| 5. `renderCountsOnly` | server names + tool counts | level 4 overflowed |

Each server header includes `folder: <absolute descriptor path>` so the model knows where to `ls`/`read` for schemas. The block also includes a `MANDATORY: read the tool's descriptor file before calling CallMcpTool` instruction (with a caveat that inline schemas let the model skip the read).

**Why system-prompt injection?** It's the most cache-friendly injection point — the system prompt is the stable cache prefix, so the block is cached across turns as long as the registry doesn't change. (Earlier versions prepended a `user` message via the `context` event, which worked but shifted the message array and was less cache-friendly. v0.3.0 switched to `before_agent_start` to match Cursor's approach.)

## Slash commands

The `/mcp-bridge` command is the primary interface for registry management (no separate CLI binary, no PATH setup):

```
/mcp-bridge sync <server> [--env K=V]... [--force] -- <command> [args...]
    Connect to a live MCP server, capture its instructions + tools/resources,
    and write meta.json + tools/*.json into the registry. Auto-reloads the
    agent context for the next turn.

/mcp-bridge add <server> [--env K=V]... -- <command> [args...]
    Add a server and auto-sync its tools/resources in one step.

/mcp-bridge add <server> --url <url> [--description <text>]
    Add an HTTP-transport server and auto-sync against the URL.

/mcp-bridge remove <server> [--keep-config]
    Delete the server's registry directory, close any live connection,
    and remove it from mcp-servers.json (skip JSON edit with --keep-config).
    Aliases: rm, delete.

/mcp-bridge validate
    Validate the registry against the JSON schemas and rebuild index.json.

/mcp-bridge list
    List all servers in the registry and their tools.

/mcp-bridge status
    Show servers/tools, MCP context occupancy (~tokens vs budget),
    and tokens saved vs always-inlining full schemas.

/mcp-bridge reload
    Reconcile optional mcp-servers.json (added/updated/0-tool auto-sync),
    re-read the registry, refresh system-prompt context on the next turn.

/mcp-bridge approve <server>
    (Only when `requireConsent` is on.) Approve a server so CallMcpTool calls go through.

/mcp-bridge revoke <server>
    Revoke consent for a server; future CallMcpTool calls will be blocked until re-approved.
```

An optional `cli.ts` wraps the same logic for scripting/CI:

```bash
npx tsx ./node_modules/@qianhuan-lxs/pi-mcp-bridge/cli.ts <sync|add|validate|list> ...
```

## Configuration

### MCP servers file (OpenCode-aligned, optional)

Hand-edit transport config in a single JSON file — same shape as OpenCode's `mcp` block. The bridge reconciles it into the filesystem registry (`meta.json`) on `session_start` and `/mcp-bridge reload`, then auto-syncs servers that were **added**, had **transport updated**, or are configured but still have **0 tools**.

After `pi update --extensions`, **restart Pi** so the new extension code loads — `/mcp-bridge reload` only reloads the registry + `mcp-servers.json`, not the extension itself.

Paths (project overrides global by server name):
- Global: `~/.pi/agent/mcp-servers.json`
- Project: `.pi/mcp-servers.json`

```jsonc
{
  "mcp": {
    "context7": {
      "type": "local",
      "command": ["npx", "-y", "@upstash/context7-mcp"],
      "enabled": true
    },
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/path/to/root"],
      "environment": { "FOO": "bar" }
    },
    "docs": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "enabled": true
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `type` | `"local"` (stdio) or `"remote"` (HTTP / SSE) |
| `command` | Local only: command + args as a string array (OpenCode style) |
| `environment` / `cwd` | Local only: env vars / working directory |
| `url` / `headers` | Remote only |
| `oauth` | Remote only: OAuth object (stored in `meta.auth` for Phase 2) or `false` |
| `enabled` | `false` skips the server (OpenCode semantics); default enabled |
| `timeout` | Request timeout ms → `meta.lifecycle.requestTimeoutMs` |

Policies: registry servers missing from the file are **warned**, never deleted. `/mcp-bridge add` still works as a shortcut; if `mcp-servers.json` already exists, `add` also upserts an OpenCode-shaped entry into it.

Tool schemas stay in `registry/<server>/tools/*.json` (sync product) — edit the JSON for transport, not for schemas.

### Bridge settings

`~/.pi/agent/mcp-bridge.json` (all fields optional; defaults shown):

```jsonc
{
  "idleTimeout": 10,                  // minutes, default 10, 0 to disable
  "requestTimeoutMs": 0,             // ms, 0 = use SDK default
  "outputGuard": true,               // truncate oversized tool outputs
  "contextBudgetTokens": 4000,       // max tokens for the injected system-prompt block
  "schemaInjectionToolLimit": 10,    // registries with > N tools skip inline schemas
                                     // 0 = disable inline schemas entirely
  "requireConsent": false            // gate CallMcpTool behind /mcp-bridge approve (default false)
}
```

Environment overrides:
- `PI_CODING_AGENT_DIR` — override the Pi agent directory (default `~/.pi/agent`).
- `PI_MCP_BRIDGE_REGISTRY` — override the registry root (default `<agent dir>/mcp-registry`).
- `MCP_OUTPUT_GUARD=0` — disable the output guard.

## License

MIT © 2026 [qianhuan-lxs](https://github.com/qianhuan-lxs)
