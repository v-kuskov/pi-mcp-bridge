# Architecture

This document describes the module layout, design decisions, and behavior contracts of `pi-mcp-bridge`. It is the canonical reference for contributors. A Chinese version is available at [`architecture.zh-CN.md`](./architecture.zh-CN.md).

## Principles

1. **Two tools, no proxy.** The LLM only ever sees `CallMcpTool` and `FetchMcpResource`. Every MCP tool is reached by name through these two wrappers. There is no per-tool proxy registration that would bloat the system prompt.
2. **Filesystem is the source of truth.** Server config lives in `registry/<server>/meta.json`; tool descriptors live in `registry/<server>/tools/<tool>.json`. The aggregate `index.json` is a derived artifact rebuilt by `sync` / `validate`.
3. **Lazy by default.** MCP servers connect on first tool call and disconnect after an idle timeout. No connection is opened just to read metadata.
4. **Cheap context.** On `session_start` a compact Markdown index of the registry is injected into the system prompt. Full tool schemas stay on disk until the model asks for them.
5. **Brownfield-friendly.** The registry is plain JSON — you can `git diff` it, hand-edit it, or generate it from a live server.
6. **No vendor lock-in.** Nothing about the registry or the wrapper tools is specific to a particular MCP server.

## Module map

```
pi-mcp-bridge/
├── index.ts                  # Pi extension entry point
├── cli.ts                    # `pi-mcp-bridge sync|validate|add|list`
├── agent-dir.ts              # resolve ~/.pi/agent + registry root
├── config.ts                 # load BridgeSettings
├── state.ts                  # McpBridgeState (in-memory session state)
├── types.ts                  # shared types
├── logger.ts                 # leveled logger
├── errors.ts                # McpBridgeError hierarchy
├── abort.ts                  # AbortSignal helpers
├── error-signal.ts          # re-flag tool_result errors for Pi
├── utils.ts                  # env interpolation, path resolve, truncate, parallelLimit
├── npx-resolver.ts          # resolve `npx` → direct binary path
├── resource-tools.ts        # slugify tool/resource names
├── tool-metadata.ts         # build/find/format tool metadata
├── metadata-cache.ts        # persistent cache for fast reconnect
├── server-manager.ts        # MCP client connections (lazy, idle timeout, npx, bearer)
├── lifecycle.ts             # idle disconnect + keep-alive health checks
├── mcp-output-guard.ts     # truncate large outputs + spill to temp file
├── tool-registrar.ts        # MCP content → Pi ContentBlocks
├── tool-result-renderer.ts  # TUI rendering for wrapper tools
├── context-injector.ts      # build + inject registry index into system prompt
├── call-mcp-tool.ts         # CallMcpTool wrapper
├── fetch-mcp-resource.ts    # FetchMcpResource wrapper
├── consent-manager.ts       # per-server tool consent gate
├── registry/
│   ├── registry-types.ts    # meta.json / tools/*.json / index.json types
│   ├── registry-loader.ts  # read registry → in-memory Registry
│   ├── registry-writer.ts  # sync from live server, validate, write atomically
│   └── schemas/
│       ├── meta.v1.json
│       ├── tool.v1.json
│       └── index.v1.json
├── examples/
│   ├── filesystem/meta.json
│   ├── filesystem/tools/*.json
│   └── index.json
└── openspec/
    ├── project.md
    ├── README.md
    ├── specs/{mcp-bridge,wrapper-tools,config-registry,context-injection}/spec.md
    └── changes/phase-1-core/{proposal,design,tasks}.md + delta specs
```

## Lifecycle

```
session_start
  ├─ load BridgeSettings
  ├─ loadRegistry() → Registry (servers Map, tools Map)
  ├─ buildContextBlock(registry) → Markdown block
  ├─ ctx.injectSystemContext(block)
  ├─ new McpServerManager()
  ├─ new McpLifecycleManager() (idle timeout + health checks)
  └─ new ConsentManager()

[tool call: CallMcpTool]
  ├─ resolveTool(server, toolName) → ToolMeta
  ├─ manager.callTool(server, {name, arguments}, signal)
  │    └─ lazy connect (if not connected)
  │       └─ spawn process / open HTTP, listTools, handshake
  ├─ mapResult → ContentBlocks
  ├─ outputGuard (truncate + spill)
  └─ return to Pi

session_shutdown
  └─ lifecycle.gracefulShutdown() (close all connections)
```

## Key design decisions

### Why two tools, not N proxied tools

Registering one Pi tool per MCP tool means the system prompt grows linearly with the number of MCP tools across all servers. With a hundred MCP tools, that's a hundred tool descriptions burned into every request. The two-tool approach keeps the prompt constant regardless of how many MCP servers are configured; the model fetches the specific tool's schema from the registry on demand.

### Why the registry is on the filesystem

A filesystem registry is:
- **diffable** — `git diff` shows exactly what changed when you `sync`.
- **editable** — fix a typo in a tool description without reconnecting to the server.
- **shareable** — commit your registry to a repo and your team gets the same tool surface.
- **offline** — the agent can read schemas without connecting to the MCP server.

The trade-off is staleness: if the live MCP server changes its tools, you must re-`sync`. `pi-mcp-bridge validate` checks the registry against the JSON schemas and rebuilds `index.json`.

### Lazy connect + idle disconnect

`McpServerManager` opens a connection the first time a tool on a given server is called. `McpLifecycleManager` closes it after `idleTimeout` seconds of inactivity, and runs a periodic health check that pings connected servers. This keeps the memory footprint low when many servers are configured but only a few are in active use.

### Output guard

MCP tools can return arbitrarily large outputs (file contents, search results, logs). `mcp-output-guard.ts` truncates text outputs to a configurable limit and writes the full content to a temp file, returning a short summary plus a pointer to the temp file. This prevents one giant tool result from blowing the context window.

### Context injection budget

`context-injector.ts` builds a Markdown block listing each server and its tools (name + one-line description). If the block exceeds `contextBudgetChars`, it drops tool descriptions first, then servers, and finally emits a `… (truncated)` marker. The full schemas are never injected — the model reads `registry/<server>/tools/<tool>.json` when it needs the schema.

### Abort propagation

Both wrappers accept the `AbortSignal` from Pi and thread it through to `McpServerManager.callTool`. If the user cancels a tool call, the in-flight MCP request is cancelled and the connection is closed.

### UI integration

*Removed in v0.6.0* — the MCP UI machinery (ui-server, ui-session, ui-resource-handler, host-html-template, glimpse-ui, app-bridge) was cut. Tools declaring `ui.resourceUri` in their descriptors are no longer rendered; the field is ignored by the bridge.

## Behavior contracts

The authoritative behavior contracts live in [`openspec/specs/`](../openspec/specs/):

- [`mcp-bridge`](../openspec/specs/mcp-bridge/spec.md) — lifecycle, two-tool surface, registry, context injection, lazy connect, output guard, abort, errors.
- [`wrapper-tools`](../openspec/specs/wrapper-tools/spec.md) — `CallMcpTool` and `FetchMcpResource` signatures, resolution, result mapping, UI hooks.
- [`config-registry`](../openspec/specs/config-registry/spec.md) — registry layout, schemas, root resolution, atomic writes, `sync`, `validate`.
- [`context-injection`](../openspec/specs/context-injection/spec.md) — trigger, format, size budget, re-injection, empty registry.

## Verification

The Phase 1 verification plan maps each requirement to a test file. See [`openspec/changes/phase-1-core/design.md`](../openspec/changes/phase-1-core/design.md) § Verification.
