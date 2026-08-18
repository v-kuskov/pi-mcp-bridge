# Spec: config-registry

> Behavior contract for the filesystem-based MCP registry. The registry is
> the source of truth for *what MCP servers and tools exist*. Live
> connections are only needed for *what to call*.

## Layout

```
<registry-root>/
├── index.json                          ← aggregate index (generated, do not hand-edit)
└── <server-name>/
    ├── meta.json                       ← server identity + transport + capabilities
    └── tools/
        ├── <tool-name>.json            ← one file per tool: name, description, schema
        └── ...
```

`<registry-root>` resolves to (in order):
1. `$PI_MCP_BRIDGE_REGISTRY` if set and non-empty.
2. `<Pi agent dir>/mcp-registry/` (default: `~/.pi/agent/mcp-registry/`).

## `meta.json` schema

```json
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/meta.v1.json",
  "name": "filesystem",
  "version": "0.1.0",
  "description": "MCP server for filesystem access.",
  "transport": {
    "kind": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    "env": { "NODE_OPTIONS": "--enable-source-maps" },
    "cwd": "/workspace"
  },
  "auth": {
    "kind": "none"
  },
  "lifecycle": {
    "mode": "lazy",
    "idleTimeoutMinutes": 10,
    "requestTimeoutMs": 30000
  },
  "capabilities": {
    "tools": true,
    "resources": true,
    "prompts": false,
    "sampling": false,
    "elicitation": false
  },
  "exposeResources": true,
  "excludeTools": [],
  "ui": {
    "viewer": "auto"
  },
  "syncedAt": "2026-07-19T05:24:00.000Z",
  "syncedFrom": "live-server"
}
```

### Field reference

| Field                          | Type     | Required | Description |
|--------------------------------|----------|----------|-------------|
| `name`                         | string   | yes      | Server identifier. MUST match the directory name. |
| `version`                      | string   | no       | Server version (informational). |
| `description`                  | string   | no       | Human-readable description, shown in the context index. |
| `transport.kind`               | enum     | yes      | `"stdio"` or `"http"`. |
| `transport.command`            | string   | stdio    | Executable. |
| `transport.args`               | string[] | stdio    | Args, with `${VAR}` / `$env:VAR` interpolation. |
| `transport.env`                | object   | no       | Env overrides, with interpolation. |
| `transport.cwd`                | string   | no       | Working directory, with interpolation + `~` expansion. |
| `transport.url`                | string   | http     | HTTP endpoint (StreamableHTTP with SSE fallback). |
| `transport.headers`            | object   | no       | HTTP headers, with interpolation. |
| `auth.kind`                    | enum     | yes      | `"none"`, `"bearer"`, or `"oauth"`. Phase 1 supports `none` and `bearer`. |
| `auth.bearerToken`             | string   | bearer   | Literal token (supports interpolation). |
| `auth.bearerTokenEnv`          | string   | bearer   | Env var name holding the token. |
| `lifecycle.mode`               | enum     | no       | `"lazy"` (default), `"eager"`, `"keep-alive"`. |
| `lifecycle.idleTimeoutMinutes` | number   | no       | Idle disconnect timeout. Default 10. 0 disables. |
| `lifecycle.requestTimeoutMs`   | number   | no       | Per-request timeout. 0 / omitted = SDK default. |
| `capabilities`                 | object   | no       | What the server claims to support. Used to skip pointless probes. |
| `exposeResources`               | boolean  | no       | If true (default), resources are exposed as `FetchMcpResource` targets. |
| `excludeTools`                 | string[] | no       | Tool names to hide from the registry index. |
| `syncedAt`                     | string   | no       | ISO timestamp of the last `sync` from a live server. |
| `syncedFrom`                   | string   | no       | `"live-server"` or `"manual"`. |

## `tools/<tool-name>.json` schema

```json
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/tool.v1.json",
  "name": "read_file",
  "title": "Read File",
  "description": "Read the complete contents of a file from the filesystem.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute file path to read." }
    },
    "required": ["path"]
  },
  "outputSchema": { "type": "object" },
  "annotations": {
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": true,
    "openWorldHint": false
  },
  "_meta": {}
}
```

The filename (without `.json`) is the registry key. The `name` field is the
original MCP tool name sent to the server. They MAY differ when a server
exposes tools with characters that are unsafe in filenames; in that case the
filename is a slug and `name` is the canonical identifier.

### Field reference

| Field           | Type    | Required | Description |
|-----------------|---------|----------|-------------|
| `name`          | string  | yes      | Original MCP tool name (sent to `tools/call`). |
| `title`         | string  | no       | Human-readable title. |
| `description`   | string  | yes      | Description shown to the model. |
| `inputSchema`   | object  | yes      | JSON Schema for the tool's arguments. The model reads this to know how to fill `CallMcpTool.arguments`. |
| `outputSchema`  | object  | no       | JSON Schema for the tool's output (informational). |
| `annotations`   | object  | no       | MCP standard tool annotations (`readOnlyHint`, etc.). |
| `_meta`         | object  | no       | Pass-through metadata from the MCP server. |

## `index.json` (generated)

```json
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/index.v1.json",
  "version": 1,
  "generatedAt": "2026-07-19T05:24:00.000Z",
  "registryRoot": "<absolute path>",
  "servers": [
    {
      "name": "filesystem",
      "description": "MCP server for filesystem access.",
      "transportKind": "stdio",
      "toolCount": 8,
      "tools": [
        { "name": "read_file", "description": "Read the complete contents of a file..." },
        { "name": "list_files", "description": "List files in a directory." }
      ],
      "resources": [
        { "uri": "file:///workspace", "name": "workspace", "description": "Workspace root." }
      ]
    }
  ]
}
```

`index.json` is regenerated by `registry-writer` after every `sync` and is
the file the context injector reads on `session_start`. It MUST stay small
(target: < 50 tokens per server, < 1 token per tool).

## Requirements

### REQ-R-001: Registry root resolution

The registry loader MUST resolve the registry root in this order:
1. `$PI_MCP_BRIDGE_REGISTRY` if set and non-empty (after `~` expansion).
2. `<Pi agent dir>/mcp-registry/`.

If neither exists on disk, the loader MUST return an empty registry (not
throw). The injector then injects an empty index.

### REQ-R-002: Server directory naming

A server is "present" in the registry iff `<registry-root>/<server-name>/meta.json`
exists and parses as valid JSON with a `name` field matching the directory
name. Mismatches MUST be reported as warnings (not errors) and the server
MUST be skipped.

### REQ-R-003: Tool file naming

A tool is "present" for a server iff
`<registry-root>/<server-name>/tools/<tool-key>.json` exists and parses as
valid JSON with a non-empty `name` field. The filename `<tool-key>` MAY
differ from `name` (e.g., for slug-encoding); both MUST be tracked so the
model can find the file by `ls` and the bridge can call the server by
`name`.

### REQ-R-004: Atomic writes

`registry-writer` MUST write all files via a temp-file + rename pattern so
that a concurrent reader never sees a half-written file.

### REQ-R-005: Sync from live server

`registry-writer.sync(serverName)` MUST:
1. Connect to the server using `meta.json` transport config.
2. Call `tools/list` (paginated) and `resources/list` (paginated).
3. For each tool, write `tools/<slug>.json` with `name`, `description`,
   `inputSchema`, `annotations`, `ui`, `_meta`.
4. Update `meta.json.syncedAt` and `meta.json.syncedFrom = "live-server"`.
5. Regenerate `index.json`.

### REQ-R-006: Validate command

`pi-mcp-bridge validate` MUST:
- Walk the registry root.
- For each server: parse `meta.json`, parse every `tools/*.json`.
- Report: missing required fields, `name`/directory mismatches, duplicate
  tool names within a server, schema files that are not valid JSON Schema
  objects.
- Exit non-zero if any error is found.

### REQ-R-007: Hand-editing

Users MAY hand-edit `meta.json` and `tools/*.json`. The loader MUST NOT
overwrite hand-edited files except during `sync`. `sync` MUST refuse to
run on a server whose `meta.json.syncedFrom = "manual"` unless called with
`--force`.

## Scenarios

```gherkin
Scenario: Empty registry
Given the registry root does not exist
When the loader loads the registry
Then it returns an empty registry object
And no error is thrown

Scenario: Slug-encoded tool name
Given server "github" exposes a tool named "search_repositories"
And the registry has github/tools/search-repositories.json with name "search_repositories"
When the loader loads the github server
Then the tool is registered under key "search-repositories" with originalName "search_repositories"
And CallMcpTool({ server: "github", toolName: "search-repositories" }) resolves to originalName "search_repositories"

Scenario: Sync overwrites stale tools
Given registry/github/tools/ has [old_tool.json]
And the live server now exposes [new_tool, search_repositories]
When registry-writer.sync("github") runs
Then registry/github/tools/ contains exactly [new_tool.json, search-repositories.json]
And old_tool.json is removed
And meta.json.syncedAt is updated

Scenario: Validate catches a bad schema
Given registry/filesystem/tools/read_file.json has inputSchema = "not-an-object"
When pi-mcp-bridge validate runs
Then it reports "filesystem/tools/read_file.json: inputSchema must be a JSON Schema object"
And exits with code 1
```
