# Registry configuration format

This document is the canonical reference for the `pi-mcp-bridge` registry file formats. A Chinese version is available at [`config-format.zh-CN.md`](./config-format.zh-CN.md).

## Layout

```
<registryRoot>/
  <server>/
    meta.json          # server config (one per server)
    tools/
      <tool>.json      # tool descriptor (one per tool)
  index.json           # aggregate index (derived; rebuilt by sync/validate)
```

The default `registryRoot` is `~/.pi/agent/mcp-bridge/registry`. Override it in `~/.pi/agent/mcp-bridge.json` or with the `PI_MCP_BRIDGE_REGISTRY_ROOT` environment variable.

Server directory names must match the `name` field in `meta.json` and consist of `[a-z0-9-]` only. Tool filenames must be the slugified tool name (see `resource-tools.ts` `slugifyToolName`) with a `.json` extension.

## `meta.json`

JSON Schema: [`registry/schemas/meta.v1.json`](../registry/schemas/meta.v1.json).

```jsonc
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/meta.v1.json",
  "name": "filesystem",                       // required, matches dir name
  "version": "1.0.0",                         // optional
  "description": "Filesystem MCP server",     // optional, shown in the index
  "transport": {                              // required
    "kind": "stdio",                          //   "stdio" | "http"
    "command": "npx",                         //   required for stdio
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"],
    "env": {                                  //   env vars, supports ${VAR} interpolation
      "NODE_OPTIONS": "--no-warnings"
    },
    "cwd": "/Users/me"                        //   optional
  },
  // OR:
  "transport": {
    "kind": "http",                           //   "http" (StreamableHTTP with SSE fallback)
    "url": "http://localhost:3000/mcp",
    "headers": {                              //   optional
      "Authorization": "Bearer ${env.MCP_TOKEN}"
    }
  },
  "auth": {                                   // required
    "kind": "none"                             //   "none" | "bearer" | "oauth"
  },
  // OR:
  "auth": {
    "kind": "bearer",
    "bearerToken": "ghp_xxx",                 //   literal token (not recommended)
    "bearerTokenEnv": "GITHUB_TOKEN"          //   OR read from process.env at connect time
  },
  // OR (Phase 2):
  "auth": {
    "kind": "oauth",
    "grantType": "authorization_code",
    "clientId": "...",
    "scope": "repo"
  },
  "lifecycle": {                              // optional
    "mode": "lazy",                           //   "lazy" | "eager" | "keep-alive", default "lazy"
    "idleTimeoutMinutes": 10,                 //   default from settings
    "requestTimeoutMs": 60000                 //   default from settings
  },
  "capabilities": {                           // optional, capability flags
    "tools": true,
    "resources": true,
    "prompts": false,
    "sampling": false,
    "elicitation": false
  },
  "exposeResources": true,                    // optional, default true
  "excludeTools": ["internal_debug"],         // optional, hide tools from the registry
  "syncedAt": "2026-07-19T05:24:00.000Z",     // set by `sync`
  "syncedFrom": "live-server"                 // "live-server" | "manual"
}
```

### Env interpolation

Values in `transport.env`, `transport.headers`, `transport.url`, `transport.args`, and `transport.command` support `${VAR}` and `${env.VAR}` interpolation against `process.env` at connect time. Unknown variables expand to an empty string.

### `npx` resolution

When `command` is `npx` (or `npm exec`), `npx-resolver.ts` resolves the package to a direct binary path on first connect and caches the result in `metadata-cache`. This avoids the ~1s `npx` startup overhead on every tool call.

## `tools/<tool>.json`

JSON Schema: [`registry/schemas/tool.v1.json`](../registry/schemas/tool.v1.json).

```jsonc
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/tool.v1.json",
  "name": "read_file",                        // required, original MCP tool name
  "description": "Read a file from the filesystem.",  // required
  "inputSchema": {                            // required, JSON Schema for arguments
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute path to the file." }
    },
    "required": ["path"]
  },
  "annotations": {                            // optional, MCP tool annotations
    "title": "Read file",
    "readOnlyHint": true
  }
}
```

The `name` field is the original MCP tool name (what the server expects in `tools/call`). The filename is the slugified version of `name` (so `read_file` → `read_file.json`, `search-repo` → `search-repo.json`).

## `index.json`

JSON Schema: [`registry/schemas/index.v1.json`](../registry/schemas/index.v1.json).

```jsonc
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/index.v1.json",
  "version": 1,
  "generatedAt": "2026-07-19T05:24:00.000Z",
  "servers": [
    {
      "name": "filesystem",
      "description": "Filesystem MCP server",
      "transport": "stdio",
      "toolCount": 2,
      "tools": [
        { "name": "read_file", "description": "Read a file from the filesystem." },
        { "name": "list_files", "description": "List files in a directory." }
      ]
    }
  ]
}
```

`index.json` is a **derived** artifact. Never hand-edit it — run `pi-mcp-bridge validate` or `pi-mcp-bridge sync` to rebuild it from the per-server files.

## Validation

```bash
npx pi-mcp-bridge validate
```

This:

1. Walks the registry root.
2. Validates each `meta.json` and `tools/*.json` against the JSON schemas.
3. Checks that directory names match `meta.json#name`.
4. Checks that tool filenames match `slugifyToolName(tool.name)`.
5. Rebuilds `index.json`.

Exits non-zero on any error.

## Sync from a live server

```bash
npx pi-mcp-bridge sync <server> -- <command> [args...]
```

This:

1. Spawns the MCP server (or connects to the URL).
2. Calls `tools/list`.
3. Writes `meta.json` (from the command/URL you provided) and one `tools/<tool>.json` per tool returned.
4. Rebuilds `index.json`.

Useful for bootstrapping a new server or refreshing after the server adds new tools.

## Adding a server stub

```bash
npx pi-mcp-bridge add <server> [--env K=V]... -- <command> [args...]
```

Writes only `meta.json`. Use `sync` afterwards to fetch tool descriptors.

## Local overrides

Anything in `registry.local/` (sibling of `registry/`) overrides the same path in `registry/`. This is useful for personal tokens and local-only servers. `registry.local/` is in `.gitignore`.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PI_MCP_BRIDGE_REGISTRY_ROOT` | Override the registry root. |
| `PI_MCP_BRIDGE_SETTINGS_PATH` | Override the settings file path. |
| `PI_AGENT_DIR` | Override the Pi agent directory (default `~/.pi/agent`). |
