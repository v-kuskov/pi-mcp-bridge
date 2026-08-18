# pi-mcp-bridge

> 一个 [Pi Agent](https://pi.dev/docs/latest/extensions) 扩展，把任意 [Model Context Protocol](https://modelcontextprotocol.io/)（MCP）服务器桥接进 Pi，**只暴露三个 LLM 可调用的工具** —— `CallMcpTool`、`FetchMcpResource`、`ListMcpResources` —— 并通过一个**以文件系统为单一事实源的注册表**与**Cursor 风格的系统提示注入**让上下文窗口保持廉价且缓存友好。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/Node-%3E%3D20.19-green.svg)](./package.json)
[![Specs: OpenSpec](https://img.shields.io/badge/OpenSpec-phase--1--core-orange)](./openspec/)

[English](./README.md) · **简体中文**

---

## 为什么做这个

Cursor 的 [Dynamic Context Discovery](https://cursor.com/cn/blog/dynamic-context-discovery) 一文提出了一个尖锐的观察：把每个 MCP 工具都直接暴露给 LLM，会让系统提示膨胀、烧光上下文。解法是**只暴露少数通用工具**，让模型按需从一份紧凑、可发现的注册表里读取具体工具的 schema。

`pi-mcp-bridge` 把这个模式带到 Pi Agent —— 并对齐 Cursor 的实际做法：

- **`CallMcpTool`** —— 通过 `server` + `toolName` + `arguments` 调用任意 MCP 工具。
- **`FetchMcpResource`** —— 通过 `server` + `uri` 读取任意 MCP 资源，可选保存到磁盘。
- **`ListMcpResources`** —— 列出某个服务器暴露的资源（先发现再读取）。
- **Filesystem is everything** —— 每个 MCP 服务器由 `registry/<server>/meta.json` + `registry/<server>/tools/<tool>.json` 描述。模型读取这些文件来学习*如何*调用工具，再用正确参数调用 `CallMcpTool`。
- **Cursor 风格的系统提示注入** —— 每轮对话时，把注册表的一份紧凑 Markdown 索引**追加到系统提示**（经 `before_agent_start` 事件，不是插 user message）。系统提示是最稳定的缓存前缀，所以只要注册表不变，这块就跨轮缓存。小注册表（默认 ≤ 10 个工具）会内联完整 `inputSchema`，模型一次就能调对；大注册表退化到名字 + 描述，模型按需读 schema 文件。
- **捕获服务器 `instructions`** —— MCP 协议 `InitializeResult.instructions`（服务器自己声明的用途与用法）在 sync 时被抓取、持久化到 `meta.json`，并作为 blockquote 渲染在每个服务器标题下 —— 模型能看到服务器自己的用法指引，而不只是我们写的工具描述。
- **Lazy by default** —— MCP 服务器只在工具被调用时才连接，空闲超过可配置阈值后自动断开。
- **No vendor lock-in** —— 注册表是纯 JSON。可以 `git diff`、手改，或用 `/mcp-bridge sync` 从一个在线 MCP 服务器生成。

## 架构（60 秒速览）

```
┌──────────────────────────────────────────────────────────────────┐
│  Pi Agent (LLM)                                                  │
│    system prompt  ◀──  经 before_agent_start 追加的 MCP 注册表块   │
│                       （Cursor 风格）                              │
│    tools: [CallMcpTool, FetchMcpResource, ListMcpResources]       │
└───────────────┬──────────────────────────────────────────────────┘
                │ CallMcpTool({server, toolName, arguments})
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  pi-mcp-bridge                                                   │
│   1. 解析 (server, toolName) → registry/<server>/tools/*.json     │
│   2. 懒连接到对应 MCP 服务器（空闲超时）                          │
│   3. 转发参数，等待结果                                           │
│   4. 输出守卫：截断 + 溢出到临时文件                               │
│   5. 把 ContentBlocks 返回给 Pi                                   │
└───────────────┬──────────────────────────────────────────────────┘
                │ MCP 协议（stdio / HTTP / SSE）
                ▼
┌──────────────────────────────────────────────────────────────────┐
│  MCP 服务器（filesystem、github、slack……）                        │
└──────────────────────────────────────────────────────────────────┘
```

完整模块图、设计决策与行为契约见 [`docs/architecture.zh-CN.md`](./docs/architecture.zh-CN.md)。

## 快速开始

### 1. 安装

```bash
pi install npm:@qianhuan-lxs/pi-mcp-bridge
```

这会把包装到 `~/.pi/agent/npm/` 下，并通过包里的 `pi.extensions` manifest 自动注册扩展 —— 不用手动改配置。

> **注意：** `pi install` 需要 Pi v0.74+。如果你用的是旧版 Pi，或想手动管理，把 `"@qianhuan-lxs/pi-mcp-bridge"` 加到 `~/.pi/agent/settings.json` 的 `packages` 数组里即可。

### 2. 注册扩展

在 Pi agent 配置（如 `~/.pi/agent.json`）里加入：

```jsonc
{
  "extensions": [
    "pi-mcp-bridge"
  ]
}
```

### 3. 往注册表里添加一个 MCP 服务器

#### stdio —— context7（库文档查询）

```
# 在 Pi 内部 —— 将一个真实 MCP 服务器的工具同步到注册表（主路径）
/mcp-bridge sync context7 -- npx -y @upstash/context7-mcp

# 或者先添加一个服务器存根（带环境变量），再同步
/mcp-bridge add github --env GITHUB_PERSONAL_ACCESS_TOKEN -- npx -y @modelcontextprotocol/server-github
/mcp-bridge sync github

# 校验 / 列出 / 查看状态
/mcp-bridge validate
/mcp-bridge list
/mcp-bridge status
```

#### Streamable HTTP（现代 MCP HTTP 传输）

在另一个终端启动服务器：

```bash
npx -y @modelcontextprotocol/server-everything streamableHttp
# 服务在 http://localhost:3000/mcp
```

然后在 Pi 里：

```
/mcp-bridge add everything-http --url http://localhost:3000/mcp --description "Everything MCP (Streamable HTTP)"
/mcp-bridge sync everything-http
```

#### SSE（旧版 HTTP 传输）

在另一个终端启动服务器：

```bash
npx -y @modelcontextprotocol/server-everything sse
# 服务在 http://localhost:3001/sse
```

然后在 Pi 里：

```
/mcp-bridge add everything-sse --url http://localhost:3001/sse --description "Everything MCP (SSE)"
/mcp-bridge sync everything-sse
```

> **传输自动探测：** 对 `kind: "http"` 的服务器，`/mcp-bridge sync` 和懒连接都会**先试 StreamableHTTP，失败回退到 SSE** —— 不用手选传输方式，给 URL 就行。

> **为什么用斜杠命令？** 注册表管理在 Pi 内通过 `/mcp-bridge ...` 完成，无需配置 PATH，也无需安装单独的 CLI 二进制。仍保留可选的 `cli.ts` 供脚本化使用 —— 通过 `npx tsx ./node_modules/@qianhuan-lxs/pi-mcp-bridge/cli.ts <cmd>` 调用。

会生成：

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

### 4. 重启 Pi 并提问

```
> 用 context7 查一下 AgentScope 的最新文档
```

模型会：

1. 从**系统提示**里读取 MCP 注册表块（经 `before_agent_start` 注入）。小注册表时完整 `inputSchema` 已内联；大注册表时看到服务器的 `folder:` 路径，按需读 `<folder>/tools/<tool>.json`。
2. 调用 `CallMcpTool({server:"context7", toolName:"resolve-library-id", arguments:{...}})`，再调 `CallMcpTool({server:"context7", toolName:"query-docs", arguments:{...}})`。
3. 收到结果（过大时截断，完整内容溢出到临时文件）。

要发现资源，先用 `ListMcpResources({server:"..."})`，再 `FetchMcpResource({server, uri})`。

## 注册表布局

```
~/.pi/agent/mcp-registry/
  <server>/
    meta.json          # 服务器配置：command、env、transport、超时、instructions
    tools/
      <tool>.json      # 每个工具一个文件：name、description、inputSchema
  index.json           # 聚合索引（由 sync / validate 重建）
```

`meta.json` 示例（stdio —— context7）：

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

`meta.json` 示例（HTTP —— Streamable HTTP 或 SSE，结构相同）：

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

> `instructions` 在 `/mcp-bridge sync` 时自动从 MCP 服务器的 `initialize` 响应抓取。也可以手改。HTTP 服务器的传输 kind 就是 `"http"` —— sync 和懒连接会自动先试 StreamableHTTP，失败回退到 SSE。

`tools/resolve-library-id.json` 示例：

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

完整 schema 参考：[`docs/config-format.zh-CN.md`](./docs/config-format.zh-CN.md)。

## 上下文注入（模型怎么知道 MCP）

注入块在每轮对话时经 `before_agent_start` 事件**追加到系统提示**。它走截断阶梯（从最详细到最简略，第一个能塞进 token budget 的就用）：

| 级别 | 内容 | 何时使用 |
|------|------|----------|
| 1. `renderWithSchemas` | 工具名 + 描述 + **完整 `inputSchema` JSON 内联** + 服务器 `instructions` | 注册表 ≤ `schemaInjectionToolLimit` 个工具（默认 10）且塞得下 budget |
| 2. `renderFull(80)` | 工具名 + 80 字描述 + 服务器 `instructions` | 级别 1 跳过/溢出 |
| 3. `renderFull(40)` | 工具名 + 40 字描述 + `instructions` | 级别 2 溢出 |
| 4. `renderKeysOnly` | 仅工具键 + `instructions` | 级别 3 溢出 |
| 5. `renderCountsOnly` | 服务器名 + 工具计数 | 级别 4 溢出 |

每个服务器标题带 `folder: <绝对描述符路径>`，模型知道去哪 `ls`/`read` 拿 schema。块里还有一条 `MANDATORY: 调 CallMcpTool 前先读工具描述符文件` 的指令（内联 schema 时允许跳过读文件）。

**为什么注入系统提示？** 这是最缓存友好的注入点 —— 系统提示是最稳定的缓存前缀，只要注册表不变就跨轮缓存。（早期版本经 `context` 事件插 user message，能用但会挪动消息数组、缓存不友好。v0.3.0 改用 `before_agent_start` 对齐 Cursor。）

## 斜杠命令

`/mcp-bridge` 是注册表管理的主接口（无单独 CLI 二进制，无需配 PATH）：

```
/mcp-bridge sync <server> [--env K=V]... [--force] -- <command> [args...]
    连接一个在线 MCP 服务器，抓取它的 instructions + 工具/资源，
    把 meta.json + tools/*.json 写进注册表。自动 reload 下一轮的上下文。

/mcp-bridge add <server> [--env K=V]... -- <command> [args...]
    添加服务器并自动 sync 工具/资源（一步完成）。

/mcp-bridge add <server> --url <url> [--description <text>]
    添加 HTTP 传输服务器并对该 URL 自动 sync。

/mcp-bridge remove <server> [--keep-config]
    删除该服务器的注册表目录、关闭已有连接，并从 mcp-servers.json
    去掉对应条目（加 --keep-config 则不动 JSON）。别名：rm、delete。

/mcp-bridge validate
    按 JSON Schema 校验注册表，重建 index.json。

/mcp-bridge list
    列出注册表里所有服务器及其工具。

/mcp-bridge status
    查看服务器/工具数量、MCP 上下文占用（~tokens / budget），
    以及相对「全量内联 schema」节约了多少 token。

/mcp-bridge reload
    协调可选的 mcp-servers.json（新加/更新/0-tool 自动 sync），
    重读注册表，下一轮刷新系统提示中的上下文。

/mcp-bridge approve <server>
    （仅在 `requireConsent` 开启时生效。）批准某服务器，放行后续的 CallMcpTool 调用。

/mcp-bridge revoke <server>
    撤销对某服务器的授权；之后的 CallMcpTool 调用会被拦截，直到再次 approve。
```

可选的 `cli.ts` 包装同一套逻辑，供脚本/CI 使用：

```bash
npx tsx ./node_modules/@qianhuan-lxs/pi-mcp-bridge/cli.ts <sync|add|validate|list> ...
```

## 配置

### MCP 服务器配置文件（对齐 OpenCode，可选）

用单个 JSON 手写传输配置 —— 形状与 OpenCode 的 `mcp` 块一致。`session_start` 和 `/mcp-bridge reload` 时会协调进文件系统注册表（`meta.json`），并对**新加的**、**传输配置有更新的**、或已配置但仍是 **0 tools** 的服务器自动 sync。

`pi update --extensions` 之后请**重启 Pi** 以加载新扩展代码——`/mcp-bridge reload` 只重读注册表和 `mcp-servers.json`，不会热替换扩展本身。

路径（同名时项目级覆盖全局）：
- 全局：`~/.pi/agent/mcp-servers.json`
- 项目：`.pi/mcp-servers.json`

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

| 字段 | 含义 |
| --- | --- |
| `type` | `"local"`（stdio）或 `"remote"`（HTTP / SSE） |
| `command` | 仅 local：命令 + 参数字符串数组（OpenCode 风格） |
| `environment` / `cwd` | 仅 local：环境变量 / 工作目录 |
| `url` / `headers` | 仅 remote |
| `oauth` | 仅 remote：OAuth 对象（写入 `meta.auth` 供 Phase 2）或 `false` |
| `enabled` | `false` 跳过该服务器（OpenCode 语义）；默认启用 |
| `timeout` | 请求超时毫秒 → `meta.lifecycle.requestTimeoutMs` |

策略：注册表里有、文件里没有的服务器只**警告**、不删除。`/mcp-bridge add` 仍可用；若已存在 `mcp-servers.json`，`add` 会同时 upsert 一条 OpenCode 形状的条目。

工具 schema 仍在 `registry/<server>/tools/*.json`（sync 产物）——手改 JSON 只改传输，不改 schema。

### Bridge 设置

`~/.pi/agent/mcp-bridge.json`（所有字段可选，默认值如下）：

```jsonc
{
  "idleTimeout": 10,                  // 分钟，默认 10，0 表示禁用
  "requestTimeoutMs": 0,             // 毫秒，0 = 用 SDK 默认值
  "outputGuard": true,               // 截断过大的工具输出
  "contextBudgetTokens": 4000,       // 注入系统提示块的最大 token 数
  "schemaInjectionToolLimit": 10,    // 工具数 > N 的注册表跳过内联 schema
                                     // 0 = 完全禁用内联 schema
  "requireConsent": false            // 在 CallMcpTool 前加 /mcp-bridge approve 闸门（默认 false）
}
```

环境变量覆盖：
- `PI_CODING_AGENT_DIR` —— 覆盖 Pi agent 目录（默认 `~/.pi/agent`）。
- `PI_MCP_BRIDGE_REGISTRY` —— 覆盖注册表根目录（默认 `<agent dir>/mcp-registry`）。
- `MCP_OUTPUT_GUARD=0` —— 禁用输出守卫。

## License

MIT © 2026 [qianhuan-lxs](https://github.com/qianhuan-lxs)
