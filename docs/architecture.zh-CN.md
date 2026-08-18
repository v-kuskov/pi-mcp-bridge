# 架构

本文档描述 `pi-mcp-bridge` 的模块布局、设计决策与行为契约，是贡献者的权威参考。中文版见 [`architecture.md`](./architecture.md)。

## 原则

1. **两个工具，不做代理。** LLM 只看到 `CallMcpTool` 和 `FetchMcpResource`。所有 MCP 工具都通过这两个包装器按名字调用，不会为每个工具注册一个代理而撑爆系统提示。
2. **文件系统是单一事实源。** 服务器配置在 `registry/<server>/meta.json`，工具描述在 `registry/<server>/tools/<tool>.json`。聚合的 `index.json` 是派生产物，由 `sync` / `validate` 重建。
3. **默认懒加载。** MCP 服务器在第一次工具调用时才连接，空闲超时后断开。不会为了读元数据而预先连接。
4. **廉价上下文。** `session_start` 时把注册表的一份紧凑 Markdown 索引注入系统提示；完整工具 schema 留在磁盘上，模型需要时再读。
5. **对存量友好。** 注册表是纯 JSON —— 可以 `git diff`、手改，或从一个在线服务器生成。
6. **不绑定厂商。** 注册表和包装器工具都不针对特定 MCP 服务器。

## 模块图

```
pi-mcp-bridge/
├── index.ts                  # Pi 扩展入口
├── cli.ts                    # `pi-mcp-bridge sync|validate|add|list`
├── agent-dir.ts              # 解析 ~/.pi/agent + 注册表根
├── config.ts                 # 加载 BridgeSettings
├── state.ts                  # McpBridgeState（内存中的会话状态）
├── types.ts                  # 共享类型
├── logger.ts                 # 分级日志
├── errors.ts                # McpBridgeError 错误层级
├── abort.ts                  # AbortSignal 辅助
├── error-signal.ts          # 把 tool_result 错误重新标记给 Pi
├── utils.ts                  # env 插值、路径解析、截断、parallelLimit
├── npx-resolver.ts          # 把 `npx` 解析为直接二进制路径
├── resource-tools.ts        # 把工具/资源名字 slug 化
├── tool-metadata.ts         # 构建/查找/格式化工具元数据
├── metadata-cache.ts        # 持久化缓存，用于快速重连
├── server-manager.ts        # MCP 客户端连接（懒连接、空闲超时、npx、bearer）
├── lifecycle.ts             # 空闲断开 + 保活健康检查
├── mcp-output-guard.ts     # 截断大输出 + 溢出到临时文件
├── tool-registrar.ts        # MCP content → Pi ContentBlocks
├── tool-result-renderer.ts  # 包装器工具的 TUI 渲染
├── context-injector.ts      # 构建 + 注入注册表索引到系统提示
├── call-mcp-tool.ts         # CallMcpTool 包装器
├── fetch-mcp-resource.ts    # FetchMcpResource 包装器
├── consent-manager.ts       # 每服务器工具同意门
├── registry/
│   ├── registry-types.ts    # meta.json / tools/*.json / index.json 类型
│   ├── registry-loader.ts  # 读注册表 → 内存中的 Registry
│   ├── registry-writer.ts  # 从在线服务器同步、校验、原子写
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

## 生命周期

```
session_start
  ├─ 加载 BridgeSettings
  ├─ loadRegistry() → Registry（servers Map、tools Map）
  ├─ buildContextBlock(registry) → Markdown 块
  ├─ ctx.injectSystemContext(block)
  ├─ new McpServerManager()
  ├─ new McpLifecycleManager()（空闲超时 + 健康检查）
  └─ new ConsentManager()

[工具调用：CallMcpTool]
  ├─ resolveTool(server, toolName) → ToolMeta
  ├─ manager.callTool(server, {name, arguments}, signal)
  │    └─ 懒连接（若未连接）
  │       └─ 拉起进程 / 打开 HTTP，listTools，握手
  ├─ mapResult → ContentBlocks
  ├─ outputGuard（截断 + 溢出）
  └─ 返回给 Pi

session_shutdown
  └─ lifecycle.gracefulShutdown()（关闭所有连接）
```

## 关键设计决策

### 为什么是两个工具，而不是 N 个代理工具

为每个 MCP 工具注册一个 Pi 工具，意味着系统提示随 MCP 工具总数线性增长。一百个 MCP 工具就是一百条工具描述烧进每次请求。两个工具的方案让提示大小与配置的 MCP 服务器数量无关；模型按需从注册表读取具体工具的 schema。

### 为什么注册表在文件系统上

文件系统注册表：
- **可 diff** —— `git diff` 一眼看出 `sync` 后改了什么。
- **可编辑** —— 不用重连服务器就能改工具描述里的错别字。
- **可分享** —— 把注册表提交到仓库，团队就拿到相同的工具面。
- **可离线** —— agent 不连 MCP 服务器也能读 schema。

代价是会过时：在线 MCP 服务器改了工具，必须重新 `sync`。`pi-mcp-bridge validate` 按JSON Schema 校验注册表并重建 `index.json`。

### 懒连接 + 空闲断开

`McpServerManager` 在某个服务器的工具第一次被调用时才打开连接。`McpLifecycleManager` 在空闲超过 `idleTimeout` 秒后关闭它，并周期性对已连接的服务器做健康检查 ping。这样在配置了很多服务器但只活跃用几个时，内存占用保持很低。

### 输出守卫

MCP 工具可能返回任意大的输出（文件内容、搜索结果、日志）。`mcp-output-guard.ts` 把文本输出截断到可配置上限，并把完整内容写到临时文件，返回一个简短摘要 + 临时文件指针。防止一次巨大的工具结果撑爆上下文窗口。

### 上下文注入预算

`context-injector.ts` 构建一个 Markdown 块，列出每个服务器及其工具（名字 + 一行描述）。若超过 `contextBudgetChars`，先丢工具描述，再丢服务器，最后输出 `… (truncated)` 标记。完整 schema 永不注入 —— 模型需要时自己读 `registry/<server>/tools/<tool>.json`。

### 中断传播

两个包装器都接受 Pi 传来的 `AbortSignal`，并把它一路传到 `McpServerManager.callTool`。用户取消工具调用时，在飞的 MCP 请求被取消，连接被关闭。

### UI 集成

*已在 v0.6.0 移除* —— MCP UI 机制（ui-server、ui-session、ui-resource-handler、host-html-template、glimpse-ui、app-bridge）已被裁剪。在描述符里声明 `ui.resourceUri` 的工具不再被渲染；该字段会被桥接器忽略。

## 行为契约

权威行为契约在 [`openspec/specs/`](../openspec/specs/)：

- [`mcp-bridge`](../openspec/specs/mcp-bridge/spec.md) —— 生命周期、两工具面、注册表、上下文注入、懒连接、输出守卫、中断、错误。
- [`wrapper-tools`](../openspec/specs/wrapper-tools/spec.md) —— `CallMcpTool` 与 `FetchMcpResource` 的签名、解析、结果映射、UI 钩子。
- [`config-registry`](../openspec/specs/config-registry/spec.md) —— 注册表布局、schema、根解析、原子写、`sync`、`validate`。
- [`context-injection`](../openspec/specs/context-injection/spec.md) —— 触发、格式、大小预算、重新注入、空注册表。

## 验证

Phase 1 的验证计划把每条需求映射到一个测试文件。见 [`openspec/changes/phase-1-core/design.md`](../openspec/changes/phase-1-core/design.md) § Verification。
