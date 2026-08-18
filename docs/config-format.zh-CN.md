# 注册表配置格式

本文档是 `pi-mcp-bridge` 注册表文件格式的权威参考。中文版见 [`config-format.md`](./config-format.md)。

## 布局

```
<registryRoot>/
  <server>/
    meta.json          # 服务器配置（每服务器一个）
    tools/
      <tool>.json      # 工具描述（每工具一个）
  index.json           # 聚合索引（派生；由 sync/validate 重建）
```

默认 `registryRoot` 是 `~/.pi/agent/mcp-bridge/registry`。可在 `~/.pi/agent/mcp-bridge.json` 里覆盖，或用环境变量 `PI_MCP_BRIDGE_REGISTRY_ROOT`。

服务器目录名必须与 `meta.json` 里的 `name` 字段一致，且只能含 `[a-z0-9-]`。工具文件名必须是工具名 slug 化（见 `resource-tools.ts` 的 `slugifyToolName`）后加 `.json`。

## `meta.json`

JSON Schema：[`registry/schemas/meta.v1.json`](../registry/schemas/meta.v1.json)。

```jsonc
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/meta.v1.json",
  "name": "filesystem",                       // 必填，与目录名一致
  "version": "1.0.0",                         // 可选
  "description": "Filesystem MCP server",     // 可选，会出现在索引里
  "transport": {                              // 必填
    "kind": "stdio",                          //   "stdio" | "http"
    "command": "npx",                         //   stdio 必填
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"],
    "env": {                                  //   环境变量，支持 ${VAR} 插值
      "NODE_OPTIONS": "--no-warnings"
    },
    "cwd": "/Users/me"                        //   可选
  },
  // 或：
  "transport": {
    "kind": "http",                           //   "http"（StreamableHTTP，带 SSE 回退）
    "url": "http://localhost:3000/mcp",
    "headers": {                              //   可选
      "Authorization": "Bearer ${env.MCP_TOKEN}"
    }
  },
  "auth": {                                   // 必填
    "kind": "none"                             //   "none" | "bearer" | "oauth"
  },
  // 或：
  "auth": {
    "kind": "bearer",
    "bearerToken": "ghp_xxx",                 //   字面量 token（不推荐）
    "bearerTokenEnv": "GITHUB_TOKEN"          //   或连接时从 process.env 读
  },
  // 或（Phase 2）：
  "auth": {
    "kind": "oauth",
    "grantType": "authorization_code",
    "clientId": "...",
    "scope": "repo"
  },
  "lifecycle": {                              // 可选
    "mode": "lazy",                           //   "lazy" | "eager" | "keep-alive"，默认 "lazy"
    "idleTimeoutMinutes": 10,                 //   默认取 settings
    "requestTimeoutMs": 60000                 //   默认取 settings
  },
  "capabilities": {                           // 可选，能力标志
    "tools": true,
    "resources": true,
    "prompts": false,
    "sampling": false,
    "elicitation": false
  },
  "exposeResources": true,                    // 可选，默认 true
  "excludeTools": ["internal_debug"],         // 可选，从注册表里隐藏工具
  "syncedAt": "2026-07-19T05:24:00.000Z",     // 由 `sync` 写入
  "syncedFrom": "live-server"                 // "live-server" | "manual"
}
```

### 环境变量插值

`transport.env`、`transport.headers`、`transport.url`、`transport.args`、`transport.command` 里的值在连接时支持 `${VAR}` 与 `${env.VAR}` 插值，来源是 `process.env`。未知变量展开为空字符串。

### `npx` 解析

当 `command` 是 `npx`（或 `npm exec`）时，`npx-resolver.ts` 在首次连接时把包解析为直接二进制路径，结果缓存进 `metadata-cache`。避免每次工具调用都付 ~1s 的 `npx` 启动开销。

## `tools/<tool>.json`

JSON Schema：[`registry/schemas/tool.v1.json`](../registry/schemas/tool.v1.json)。

```jsonc
{
  "$schema": "https://pi-mcp-bridge.dev/schemas/tool.v1.json",
  "name": "read_file",                        // 必填，原始 MCP 工具名
  "description": "Read a file from the filesystem.",  // 必填
  "inputSchema": {                            // 必填，参数的 JSON Schema
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute path to the file." }
    },
    "required": ["path"]
  },
  "annotations": {                            // 可选，MCP 工具注解
    "title": "Read file",
    "readOnlyHint": true
  }
}
```

`name` 字段是原始 MCP 工具名（服务器在 `tools/call` 里期望的名字）。文件名是 `name` slug 化后的版本（`read_file` → `read_file.json`，`search-repo` → `search-repo.json`）。

## `index.json`

JSON Schema：[`registry/schemas/index.v1.json`](../registry/schemas/index.v1.json)。

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

`index.json` 是**派生**产物。不要手改 —— 跑 `pi-mcp-bridge validate` 或 `pi-mcp-bridge sync` 从各服务器文件重建。

## 校验

```bash
npx pi-mcp-bridge validate
```

它会：

1. 遍历注册表根。
2. 用 JSON Schema 校验每个 `meta.json` 与 `tools/*.json`。
3. 检查目录名与 `meta.json#name` 一致。
4. 检查工具文件名与 `slugifyToolName(tool.name)` 一致。
5. 重建 `index.json`。

任何错误都会非零退出。

## 从在线服务器同步

```bash
npx pi-mcp-bridge sync <server> -- <command> [args...]
```

它会：

1. 拉起 MCP 服务器（或连接 URL）。
2. 调用 `tools/list`。
3. 写 `meta.json`（来自你给的 command/URL）和每个工具一个 `tools/<tool>.json`。
4. 重建 `index.json`。

适合给新服务器引导，或在服务器加了新工具后刷新。

## 添加服务器桩

```bash
npx pi-mcp-bridge add <server> [--env K=V]... -- <command> [args...]
```

只写 `meta.json`。之后用 `sync` 抓工具描述。

## 本地覆盖

`registry.local/`（`registry/` 的兄弟目录）里同路径的文件会覆盖 `registry/` 里的。适合放个人 token 和只在本机用的服务器。`registry.local/` 在 `.gitignore` 里。

## 环境变量

| 变量 | 用途 |
|------|------|
| `PI_MCP_BRIDGE_REGISTRY_ROOT` | 覆盖注册表根。 |
| `PI_MCP_BRIDGE_SETTINGS_PATH` | 覆盖 settings 文件路径。 |
| `PI_AGENT_DIR` | 覆盖 Pi agent 目录（默认 `~/.pi/agent`）。 |
