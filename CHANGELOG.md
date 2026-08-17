# Changelog

All notable changes to `pi-mcp-bridge` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.7] — 2026-08-18

### Fixed — UI integration: server crash, dead sessions, no result delivery

UI-hosted tools were completely broken: `startUiServer` read `server.address()` synchronously right after the asynchronous `listen()`, so it threw `Cannot read properties of null (reading 'port')` on every startup and the UI server never started. The session plumbing behind it was also unfinished:

- `startUiServer` now awaits the `listening` event before reading the port (startup crash fixed).
- New `registerSession` API on the server handle: sessions are actually registered, so `/s/<token>` serves the host page instead of 404ing and `/proxy/*` callbacks find their session.
- New `GET /events?session=<token>` Server-Sent Events stream: `pushResult` / `pushCancelled` (from `ui-session.ts`) now reach the open UI; the host page forwards them into the iframe via `AppBridge.sendToolResult` / `sendToolCancelled`.
- `/proxy/ui/message` accumulates prompts/notifications/intents into the session (surfaced via `completedUiSessions`); `/proxy/ui/done` and `/proxy/ui/cancel` invoke the session callbacks and tear the session down.
- Glimpse window title interpolation fixed (`${params.toolName}` was missing its braces).
- Session finalization is guarded against double-completion (e.g. Done then window close).

### Fixed — CLI `--` separator

`node:util parseArgs` drops the `--` token from `positionals`, so `cli.ts` never found the command after it: `sync <server> -- <command>` and `add <name> -- <command>` always failed with "no command provided". The command is now taken from everything after the server name, so the documented forms work again.

### Tests

- Added `__tests__/ui-server.test.ts` covering async startup, session page serving, SSE result streaming, message accumulation, and done/cancel teardown.

## [0.5.6] — 2026-07-19

### Added — show tokens saved vs full-schema baseline

Footer and `/mcp-bridge status` now report how much context the compact injection saved compared to always inlining every tool's full `inputSchema`:

- Footer: `… · ~1.2k/4k tok (30%, names) · saved ~8.4k (87%)`
- Status: `Saved vs full schemas: ~8400 tokens (87%) — baseline 9600 → injected 1200`

## [0.5.5] — 2026-07-19

### Added — MCP context occupancy in footer + status

Shows how much system-prompt space the MCP index uses (estimated tokens vs `contextBudgetTokens`):

- Footer: `MCP: 4 servers, 26 tools · ~1.2k/4k tok (30%, names)`
- `/mcp-bridge status`: detailed line with token count, % of budget (color by pressure), and mode (`full schemas inlined` / `names+descriptions` / `truncated`)

Estimates use the same `chars/4` heuristic as `buildContextBlock`.

## [0.5.4] — 2026-07-19

### Added — `/mcp-bridge remove <server>`

Delete a server from the filesystem registry (`mcp-registry/<server>/`), close any live connection, rebuild `index.json`, and by default also drop the entry from `mcp-servers.json` (use `--keep-config` to leave the JSON alone). Aliases: `rm`, `delete`.

## [0.5.3] — 2026-07-19

### Changed — default `schemaInjectionToolLimit` 30 → 10

Inline full `inputSchema` injection now cuts over at **10** tools (was 30). Registries with 11+ tools use names + descriptions and ask the model to read absolute descriptor paths. Override via `~/.pi/agent/mcp-bridge.json` → `schemaInjectionToolLimit`.

## [0.5.2] — 2026-07-19

### Fixed — publish `reconcile-and-sync.ts`

`index.ts` imports `./reconcile-and-sync.ts`, but that file was missing from `package.json` `"files"`, so the npm 0.5.1 install crashed Pi with `Cannot find module './reconcile-and-sync.ts'`. Added the file to the publish list.

## [0.5.1] — 2026-07-19

### Fixed — stability pass (context refresh, lifecycle, auto-sync)

Addresses the “context felt lost after reload” footgun and several silent failures around `mcp-servers.json`.

- **System-prompt injection refresh:** MCP block now ends with `<!-- /pi-mcp-bridge -->`. On registry generation bumps (reload/sync), `before_agent_start` **replaces** the old header…footer span instead of skipping forever when the header was already present.
- **Absolute paths:** truncation note interpolates the real registry root; `CallMcpTool` description no longer recommends relative `registry/...` paths.
- **Unified reconcile + auto-sync:** `reconcile-and-sync.ts` shared by `session_start` and `/mcp-bridge reload`. Auto-syncs **added**, **updated**, and configured **0-tool** servers. Reload notifies when no config file is found (paths checked).
- **Lifecycle wiring:** register each registry server for idle disconnect / keep-alive; `idleTimeout: 0` in `mcp-bridge.json` disables the sweep.
- **Transport fingerprint:** reconnect when definition changed instead of reusing a stale connection.
- **`doSync` env parity** with `McpServerManager.resolveEnv`; broader `toolErrorOverride` codes (`connect_failed`, `server_not_found`, …).
- **Early `session_start` state** so tools are not stuck on `not_initialized` during auto-sync.
- `/mcp-bridge status` notes that extension code updates require a **Pi restart**.
- Tests for injection replace, auto-sync targets, idleTimeout 0, lifecycle idle close, fingerprints, error codes. Package bump to `0.5.1`.

## [0.5.0] — 2026-07-19

### Added — OpenCode-aligned `mcp-servers.json`

Optional single-file transport config matching OpenCode's `mcp` block (`type: "local" | "remote"`, `command` as a string array, `environment`, `enabled`, remote `url`/`headers`/`oauth`). Paths: `~/.pi/agent/mcp-servers.json` (global) and `.pi/mcp-servers.json` (project; overrides by name).

- On `session_start` and `/mcp-bridge reload`, reconcile enabled entries into `registry/<server>/meta.json`, warn about registry orphans (never delete), and auto-sync **newly added** servers only so `tools/*.json` is populated.
- `enabled: false` skips the entry (OpenCode semantics). Disabled names still count as configured for orphan detection.
- `/mcp-bridge add` still works; if `mcp-servers.json` already exists, it upserts an OpenCode-shaped entry into the file as well.
- New module `mcp-servers-config.ts` + `__tests__/mcp-servers-config.test.ts` (8 tests). Tool schemas remain sync products — the JSON file is transport-only, same split as OpenCode (config) vs our registry cache (schemas for lazy CallMcpTool).
- README (EN + zh-CN) documents the file. All tests pass; `tsc` clean.

## [0.4.3] — 2026-07-19

### Fixed — `add` now auto-syncs (eliminates the "0 tools" footgun)

A real Pi session loaded `filesystem` and `memory` via `/mcp-bridge add` but never ran `/mcp-bridge sync`. Result: both servers showed up in the registry with **0 tools** — `CallMcpTool` couldn't find any tools, and `filesystem` even failed to connect on `ListMcpResources` (`MCP error -32000: Connection closed`). The `add` return message did say "Run /mcp-bridge sync …" but the two-step flow was a footgun.

- **`/mcp-bridge add` now chains straight into sync.** After `doAdd` writes the `meta.json` stub, the handler calls the same sync-with-progress path used by the `sync` subcommand. One step produces a fully-populated server: `Added + synced "<server>": N tools, M resources indexed. Ready to call.`
- Extracted a shared `runSync(serverName, command, commandArgs, env, force)` helper inside the command handler so `sync` and `add` share the footer-spinner + `doSync` + registry-reload + status-bar-refresh logic. No behavior change for `sync`.
- If auto-sync fails, the message points at the manual retry command: `Added "<server>" but auto-sync failed: <error>. Run \`/mcp-bridge sync <server> -- <command>\` to retry.`
- If auto-sync is skipped (e.g. `syncedFrom: "manual"` guard), the message tells the user to run sync manually.
- Works for HTTP servers too: `add --url <url>` writes the http-transport stub, then auto-sync probes Streamable HTTP → SSE fallback against that URL (no command needed, per v0.3.1).
- 73 tests pass; `tsc` clean. (No new unit tests — `runSync` is a closure inside the command handler; the underlying `doAdd`/`doSync` are already covered.)

## [0.4.2] — 2026-07-19

### Changed — make the wrapper indirection visible in `renderCall`

A real Pi session showed `resolve-library-id @ context7` for a `CallMcpTool` invocation — the v0.4.0 `renderCall` wiring rendered it so cleanly that it was indistinguishable from a native tool call, prompting "why is it directly calling the MCP's original tool?" The wrapper indirection is the project's core design and should be visible on every call.

- `CallMcpTool` now renders as `CallMcpTool → <toolName> @ <server>`.
- `FetchMcpResource` now renders as `FetchMcpResource → <uri> @ <server>`.
- `ListMcpResources` now renders as `ListMcpResources → list @ <server>`.
- The model still calls the same three wrapper tools; only the TUI display prefix changed. No existing tests asserted the old format, so no test updates needed. 73 tests pass; `tsc` clean.

## [0.4.1] — 2026-07-19

### Fixed — context-block instruction wording (model wasted round-trips)

Spotted in a real Pi session: with a small registry (context7, 2 tools) the model still tried to `read registry/context7/tools/<tool>.json` (a **relative** path) before calling `CallMcpTool`, hit ENOENT, then called `CallMcpTool` with missing required params, and only learned the schema from the error message. Two wasted round-trips before a successful call.

Root cause: `renderWithSchemas` (the inline-schema level used for small registries) emitted `READ_FIRST_INSTRUCTION`, which led with "MANDATORY: read the tool's descriptor file" and buried the "schemas are inlined, skip the read" caveat in parentheses. The model latched onto "MANDATORY read", tried a relative path, and failed.

- **Split the instruction into two variants.** `INSTRUCTION_INLINE` (used by `renderWithSchemas`): "Full input schemas are inlined below each tool. Call CallMcpTool / FetchMcpResource directly with the arguments shown — do NOT read schema files first." `INSTRUCTION_READ_FILES` (used by `renderFull` and `renderKeysOnly`): "Read the tool's descriptor file to confirm its parameters. Each server's descriptor folder (absolute path) is shown under its name above — use `read <folder>/tools/<toolName>.json`. Do NOT use relative paths like `registry/<server>/...`; they resolve against the agent cwd and will miss the registry."
- The files-level instruction now **explicitly warns against relative paths** and points at the absolute `folder:` path already rendered under each server header.
- Updated `__tests__/context-injector.test.ts`: the old "includes the MANDATORY read-schema-first instruction" test (which asserted the inline level said MANDATORY) is replaced by two tests — one asserting the inline level says "do NOT read schema files", one asserting the files level (31-tool registry, over the limit) says "read the descriptor file" + "Do NOT use relative paths" + includes the absolute folder path. All 73 tests pass; `tsc` clean.

## [0.4.0] — 2026-07-19

### Added — Wrapper tool rendering, UI session wiring, consent gate

Three UI-layer gaps where code existed but was never invoked are now wired up, bringing the bridge's TUI experience in line with Cursor's.

- **Custom `renderCall` / `renderResult` hooks are now attached to all three wrapper tools** (`CallMcpTool`, `FetchMcpResource`, `ListMcpResources`). Previously `tool-result-renderer.ts` exported `renderWrapperToolCall` / `renderMcpToolResult` but `index.ts` registered the tools without passing them, so Pi fell back to its default renderer and tool calls showed as a generic `CallMcpTool` + a JSON blob. Calls now render as `resolve-library-id @ context7` with a folded argument block, and results show a `Ctrl+O to expand` hint when truncated. Errors auto-expand.
- **MCP UI sessions are now actually started.** `call-mcp-tool.ts` detects `tool.ui?.resourceUri` and calls `maybeStartUiSession(...)` before forwarding, attaches the session's `requestMeta` to the `tools/call` request, pushes the `CallToolResult` to the iframe once it arrives, and notifies the iframe on abort. Previously the entire UI integration (`consent-manager`, `ui-resource-handler`, `ui-server`, `ui-session`, `glimpse-ui`, `host-html-template`) was initialized in `session_start` but never invoked — tools with interactive UIs silently fell back to text. `McpServerManager.callTool` now accepts `_meta` on the request so the session token can be forwarded.
- **Opt-in consent gate.** New `BridgeSettings.requireConsent` (default `false`, set in `~/.pi/agent/mcp-bridge.json`). When `true`, `CallMcpTool` blocks the first call to each server with `error: "consent_required"` and a hint pointing at `/mcp-bridge approve <server>`. New `/mcp-bridge approve <server>` and `/mcp-bridge revoke <server>` subcommands drive the `ConsentManager`. Off by default so existing behavior is unchanged.
- New test file `__tests__/call-mcp-tool.test.ts` (3 tests) covering the consent gate's block / pass / disabled paths.

### Added — Footer status bar, sync progress, themed command output

- **Persistent footer status indicator** via `ctx.ui.setStatus("mcp-bridge", …)`. Shows `MCP: N servers, M tools` (correctly pluralized) in the Pi footer, refreshed on `session_start`, after `/mcp-bridge sync`, and after `/mcp-bridge reload`; cleared on `session_shutdown`. New `status-bar.ts` module centralizes the rendering (`formatStatusLine`, `refreshStatusBar`, `clearStatusBar`).
- **Live sync progress.** `/mcp-bridge sync` now drives the footer with an animated braille spinner + step label (`Connecting (stdio)…` → `Listing tools & resources…` → `Writing registry files…`) via a new `onProgress` callback on `doSync`/`SyncOptions`. Falls back to the old single-notify behavior in non-TUI modes. The footer is restored to the summary line when sync finishes (or fails).
- **Themed `/mcp-bridge list` and `/mcp-bridge status` output.** `list` now renders an aligned table (server | trans | tools | synced | description) with themed colors, plus an indented tool list per server. `ListEntry` gained `transportKind` and `syncedFrom` fields to populate the new columns. `status` highlights the server/tool counts. Both fall back to plain text in non-TUI modes.
- New test file `__tests__/status-bar.test.ts` (5 tests) covering pluralization, the empty-registry hint, table rendering, and the themed status line. All 72 tests pass; `tsc` clean.

## [0.3.1] — 2026-07-19

### Added — HTTP transport support for `/mcp-bridge sync`

- **`/mcp-bridge sync` now works with HTTP servers** (Streamable HTTP and SSE), not just stdio. Previously `doSync` returned `"HTTP transport sync not implemented in Phase 1 — use stdio."` for any `kind: "http"` server; HTTP servers could be added as stubs but never synced, so their `tools/` stayed empty. Sync now creates a `StreamableHTTPClientTransport` (probing first) and falls back to `SSEClientTransport` — the same auto-detection logic `McpServerManager` uses for lazy-connect.
- **`/mcp-bridge sync <server>` without a `-- <command>` is now valid** for HTTP servers added via `--url`. The slash parser no longer requires a command after `--`; if absent, sync proceeds against the existing `meta.json` URL. (For stdio servers with no existing meta and no command, sync still errors with a helpful message.)
- `cli.ts` sync path updated to match (command after `--` now optional).

### Changed — README examples

- README (EN + zh-CN) examples switched from `filesystem` to **`context7`** (the server the maintainer actually tests with).
- Added **Streamable HTTP** and **SSE** examples using `@modelcontextprotocol/server-everything` (run in a separate terminal, then `/mcp-bridge add --url ... && /mcp-bridge sync ...`).
- Added a second `meta.json` example showing the `kind: "http"` shape.
- Documented the StreamableHTTP-first-SSE-fallback auto-detection.

### Tests

- Updated slash-parser test for the new optional-command behavior. Total suite: **64 tests across 6 files, all green**. Typecheck: 0 errors.

## [0.3.0] — 2026-07-19

### Changed — Cursor-style system-prompt injection (major)

Reviewed Cursor's actual MCP prompt and aligned our injection mechanism with it. The previous approach (prepend a `user` message via the `context` event) was functional but suboptimal for caching and conversation structure. The new approach appends to the **system prompt** via the `before_agent_start` event — the same mechanism Cursor uses.

- **Injection moved from `context` event → `before_agent_start` event.** `BeforeAgentStartEvent.systemPrompt` exposes the fully-assembled system prompt; returning `{ systemPrompt }` replaces it for the turn. We append our MCP block to it. This is the most cache-friendly injection point: the system prompt is the stable cache prefix, so our block is cached across turns as long as the registry doesn't change. No more `timestamp: Date.now()` user message, no more shifting the message array by one position.
- **Block format aligned with Cursor:**
  - Each server header now includes `folder: \`<absolute descriptor path>\`` (Cursor's `folderPath` equivalent) so the model knows where to `ls`/`read` for tool schemas.
  - Added a `MANDATORY: read the tool's descriptor file before calling CallMcpTool` instruction (Cursor's "MANDATORY - Always Check Tool Schema First"), with a caveat that inline schemas (small registries) let the model skip the read.
- **Idempotency** now checks `event.systemPrompt` for our `INJECTION_HEADER` instead of scanning the message array.

### Added — `ListMcpResources` tool (Cursor parity)

- Cursor exposes both `ListMcpResources` and `FetchMcpResource`; we previously only had the fetch half. Added `ListMcpResources` (`list-mcp-resources.ts`) — takes a `server`, lazily connects, paginates `client.listResources()`, and returns a compact `uri — name: description (mimeType)` listing. Lets the model discover what resources a server exposes before fetching one.

### Why this matters for caching

- **Before (v0.2.x):** MCP block was a `user` message at index 0. Every turn re-prepended it (with a fresh `timestamp`), shifting all real messages by one position. Content was cacheable on Anthropic (which strips `timestamp`), but the message-array shift was unfriendly to Pi's cache breakpoints and structurally unnatural (two consecutive `user` messages).
- **After (v0.3.0):** MCP block is appended to the system prompt. System prompt is the canonical stable cache prefix. No message-array shift, no timestamp, no structural oddity. Same content stability, better cache behavior.

### Tests

- 2 new tests covering the per-server `folder:` path and the MANDATORY read-first instruction. Total suite: **64 tests across 6 files, all green**. Typecheck: 0 errors.

## [0.2.5] — 2026-07-19

### Added — capture and inject MCP server `instructions` (aligns with Cursor's dynamic context discovery)

The MCP protocol's `InitializeResult` includes an optional `instructions` string — the server's own description of its purpose and how to use its tools, explicitly meant to be shown to the LLM. We were ignoring it. Cursor's dynamic-context-discovery approach uses this; we now do too.

- **`syncServer` captures `client.getInstructions()`** at connect time and persists it to `meta.json.instructions`. Re-syncs preserve existing instructions when the server returns none.
- **`ServerMeta.instructions?: string`** added to the registry type and the `meta.v1.json` JSON Schema.
- **The context block now renders each server's `instructions` as a markdown blockquote** under the `### <server>` header, in every truncation level except `renderCountsOnly`. Instructions are truncated to 320 chars to bound the budget; the full text remains in `meta.json`.

### Why this matters

Before: the model saw only the tool names/descriptions we wrote to the registry. It never saw the server's own guidance (e.g. "always call resolve-library-id before query-docs"). Now the model gets the server's intended usage pattern directly, which meaningfully improves first-try call accuracy.

### Tests

- 3 new tests covering instructions rendering, long-instruction truncation, and the no-instructions case. Total suite: **62 tests across 6 files, all green**. Typecheck: 0 errors.

## [0.2.4] — 2026-07-19

### Changed — hard tool-count limit for inline schema injection

- **Registries with more than 30 tools now skip the `renderWithSchemas` level entirely** and fall back to descriptions-only injection. Previously the only gate was the token budget, which made behavior unpredictable: a registry could fit full schemas one turn and not the next (when tools were added), and the injector would build a large schema block only to discard it. The new rule is a hard, predictable cutoff at 30 tools.
- New `BridgeSettings.schemaInjectionToolLimit` (default `30`) controls the threshold. Set it to `0` to disable inline schema injection entirely; set it to a large number to fall back to the pure token-budget behavior.
- Boundary behavior: exactly 30 tools → schemas included; 31 tools → descriptions only.

### Tests

- 4 new tests covering the 30-tool boundary, a custom limit, and `limit=0` (disabled). Total suite: **59 tests across 6 files, all green**. Typecheck: 0 errors.

## [0.2.3] — 2026-07-19

### Fixed — context block path + full-schema injection (review follow-up)

Review of a real `/mcp-bridge sync context7` session exposed two issues in the context-injection design:

- **The schema-file path in the context block was relative (`registry/<server>/tools/<tool>.json`), so the model's `read` resolved it against the agent cwd and got ENOENT.** The actual files live at `getRegistryRoot()` = `~/.pi/agent/mcp-registry/`. The model could never read a schema file and only recovered because the MCP server happened to embed the schema in its validation error. Fix: the footer now uses the absolute `registry.root` (e.g. `~/.pi/agent/mcp-registry/<server>/tools/<tool>.json`), so `read`/`grep`/`ls` actually find the file.

- **The "read the schema file before calling" pattern doubled round-trips and the model often skipped it** (calling with empty params, failing, then reading the schema from the error). Fix: added a new top truncation level `renderWithSchemas` that includes each tool's full `inputSchema` as compact JSON inline. When the registry fits the token budget (default 4000), the model gets every schema directly in the context block and can call `CallMcpTool` correctly on the first try — no extra `read`, no failed-then-retry. When the registry is too large, the injector falls back to the existing description-only levels (which now point at the correct absolute path). `InjectionResult` gains a `schemasIncluded` boolean so callers can tell which mode was used.

### Result

For a small registry (e.g. just `context7` with 2 tools), the call chain becomes:
```
1. model reads schema from the context block (no tool call needed)
2. CallMcpTool(resolve-library-id, {query, libraryName})  → succeeds first try
3. CallMcpTool(query-docs, {libraryId, query})            → succeeds first try
```
2 calls, 0 failures (was 4 calls, 2 failures in v0.2.2).

### Tests

- 3 new tests covering the `renderWithSchemas` level, the fallback-to-descriptions path, and the absolute-path footer. Total suite: **55 tests across 6 files, all green**. Typecheck: 0 errors.

## [0.2.2] — 2026-07-19

### Fixed — context injection actually works now (critical)

- **MCP registry was never injected into the agent context.** `index.ts` called `ctx.injectSystemContext(...)`, but `ExtensionContext` / `ExtensionCommandContext` have no such method — the call was guarded by `if (ctx.injectSystemContext)` which was always falsy, so the compact registry index was never sent to the model. Symptom: the model didn't know `CallMcpTool` / `FetchMcpResource` existed or which MCP tools were available, so it fell back to shell commands (`find /`, etc.) instead of calling MCP tools. Fix: hook the documented `pi.on("context", ...)` event (the SDK's supported "injecting context from external sources" hook), which fires before every provider request with the `AgentMessage[]` and lets the handler return a replacement array. We prepend a user message containing the registry block. Injection is idempotent (skips if a message containing our `## MCP servers (via pi-mcp-bridge)` header is already present), so it's safe whether or not the result is persisted across turns.
- **`/mcp-bridge reload` no longer calls the non-existent `ctx.injectSystemContext`.** It now just updates `state.registry` and clears the cached block; the next `context` event rebuilds the block from the new registry automatically.
- **`/mcp-bridge sync` now auto-reloads the registry after a successful sync.** Previously the user had to run `/mcp-bridge reload` separately, and even then the (broken) injection didn't reach the model. Now sync updates `state.registry` in place, so the next turn sees the new tools immediately.

### Fixed — pre-existing runtime crashes surfaced by the review

- **`FetchMcpResource` imported a non-existent type `ReadResourceResultContents`.** The MCP SDK exports `ResourceContents` (and `ReadResourceResult.contents` is `ResourceContents[]`); the wrong import name would have crashed `FetchMcpResource` the first time it was invoked. Replaced both usages with `ResourceContents`.
- **`host-html-template.ts` called `applyCspMeta(...)` but the function is named `applyCspMetaContent`.** Undefined reference — would have crashed the MCP UI host page builder the first time a tool with a `ui.resourceUri` was invoked. Renamed the call site.
- **`lifecycle.ts` / `server-manager.ts` imported `ServerDefinition` from `types.ts`, which only exports `ServerEntry`.** Type-only import (no runtime crash), but the type annotations were wrong. Aliased `ServerEntry as ServerDefinition` to preserve call sites.
- **`server-manager.callTool` passed `_meta: undefined` explicitly**, which the MCP SDK's stricter type rejects. Omitted the field instead.
- **`index.ts` tool `execute` params had implicit `any` types** (`_toolCallId`, `signal`) because the `registerTool` cast bypassed inference. Added explicit `string` / `AbortSignal` annotations.

### Changed

- **Empty-registry context message** now points at `/mcp-bridge add <server> -- <command>` (the v0.2.0 slash-command flow) instead of the removed `pi-mcp-bridge add` CLI.
- **Typecheck is now clean: 0 errors** (was 13 in v0.2.1, all pre-existing from the 0.1.x port). Tests: 52 passing across 6 files.

## [0.2.1] — 2026-07-19

### Fixed

- **First-time `/mcp-bridge sync <server>` no longer skips with `syncedFrom is "manual"`.** The manual-edit guard in `syncServer` was too coarse: it skipped *any* server whose `meta.json.syncedFrom === "manual"`, including the freshly-created stubs that `doSync`/`doAdd` write (which have `syncedFrom: "manual"` + an empty `tools/` directory). The very first sync therefore never ran, leaving the registry empty and the agent with no MCP tools to call. The guard now only skips when `syncedFrom === "manual"` **and** `tools/` already contains hand-written `.json` descriptors — i.e., only when there's actually something to protect. `--force` still overrides everything.

## [0.2.0] — 2026-07-19

### Changed — registry management is now Pi-idiomatic

- **`/mcp-bridge` is now the primary path for registry management.** `sync`, `validate`, `add`, `list`, `status`, and `reload` are all subcommands of the existing `/mcp-bridge` slash command inside Pi — no separate binary on PATH, no `command not found` after `pi install`. This matches how `pi-mcp-adapter` (the project we ported from) does it: the slash command is the user-facing surface; the CLI is auxiliary.
- **Removed the `bin` field from `package.json` and deleted `bin/pi-mcp-bridge.mjs`.** The published package no longer ships a CLI binary; `pi install npm:@qianhuan-lxs/pi-mcp-bridge` followed by `/mcp-bridge ...` inside Pi is the supported flow.
- **`cli.ts` is now an optional, no-bin wrapper** around the shared `registry-commands.ts` module, kept for scripting / CI. Run it via `npx tsx ./node_modules/@qianhuan-lxs/pi-mcp-bridge/cli.ts <cmd>`. It and the slash command share the exact same logic, so the two paths never diverge.
- **`tsx` moved back to `devDependencies`** — the runtime no longer needs it (no bin shim).
- README (EN + zh-CN) updated to document `/mcp-bridge sync|validate|add|list|status|reload` as the primary flow.

### Added

- **`registry-commands.ts`** — shared `doSync` / `doValidate` / `doAdd` / `doList` logic used by both the slash command and the optional CLI.
- **`slash-parser.ts`** — parses `/mcp-bridge sync|add` argument strings (handles `--env K=V`, `--env K`, `--force`, `--url`, `--description`, and the `-- <command> [args...]` separator).
- **`__tests__/slash-parser.test.ts`** — 9 new tests covering the parser; total suite now 52 tests across 6 files.

### Migration from 0.1.x

If you previously called `pi-mcp-bridge sync ...` from a shell, switch to `/mcp-bridge sync ...` inside Pi. The argument format is identical (`<server> [--env K=V]... [--force] -- <command> [args...]`).

## [0.1.1] — 2026-07-19

### Fixed

- **Bin entry now survives `npm publish`.** The CLI shim `bin/pi-mcp-bridge.mjs` lacked the executable bit, causing npm to strip the `bin` field at publish time with the warning `bin[pi-mcp-bridge] script name ... was invalid and removed`. `chmod +x` the shim so `pi-mcp-bridge` registers on the consumer's PATH after `pi install`.

### Changed

- **Package name is now scoped:** `@qianhuan-lxs/pi-mcp-bridge`. The unscoped `pi-mcp-bridge` name was already taken on npm by another author; the scoped name under the maintainer's GitHub username avoids the collision while staying installable via `pi install npm:@qianhuan-lxs/pi-mcp-bridge`.
- **Pi core packages moved to `peerDependencies` with `"*` range** (`@earendil-works/pi-ai`, `-pi-coding-agent`, `-pi-tui`, `typebox`). They are provided by the pi runtime; bundling them would cause version conflicts. Real versions retained in `devDependencies` for local typechecking.
- **`tsx` moved to `dependencies`** — the CLI bin shim needs it at runtime to load `cli.ts`.
- **`engines: node >=20.19`** declared.
- **`publishConfig: { access: public }`** set for scoped-name safety.
- README install commands updated to `pi install npm:@qianhuan-lxs/pi-mcp-bridge`.

## [0.1.0] — 2026-07-19

### Added — Phase 1 (core)

- **Two-tool surface.** The LLM only sees `CallMcpTool` and `FetchMcpResource`. Every MCP tool is reached by `server` + `toolName` (+ `arguments`); every MCP resource is read by `server` + `uri` (with optional `downloadPath`).
- **Filesystem-first registry.** Server config lives in `registry/<server>/meta.json`; tool descriptors live in `registry/<server>/tools/<tool>.json`; the aggregate `index.json` is derived and rebuilt by `sync` / `validate`. JSON Schemas for all three formats live in `registry/schemas/`.
- **Context injection.** On `session_start`, a compact Markdown index of the registry is injected into the system prompt. Full tool schemas stay on disk until the model asks for them. A configurable `contextBudgetChars` budget truncates the block gracefully.
- **Lazy connections.** MCP servers connect on first tool call and disconnect after a configurable `idleTimeout`. `McpLifecycleManager` runs periodic keep-alive health checks.
- **Output guard.** Large tool outputs are truncated and the full content is spilled to a temp file, with a short summary + pointer returned to the model.
- **Abort propagation.** Both wrappers thread Pi's `AbortSignal` through to `McpServerManager.callTool`; cancelling a tool call cancels the in-flight MCP request and closes the connection.
- **`npx` resolution.** `npx` / `npm exec` commands are resolved to direct binary paths on first connect and cached, avoiding the per-call `npx` startup overhead.
- **Bearer token auth.** `meta.json#bearerToken` (and `headers.Authorization`) support `${env.VAR}` interpolation for HTTP/SSE servers.
- **StreamableHTTP + SSE fallback.** HTTP transport tries StreamableHTTP first and falls back to SSE.
- **CLI.** `pi-mcp-bridge sync | validate | add | list` for managing the registry from the shell.
- **UI integration.** Tools that declare `ui.resourceUri` render in a sandboxed iframe served by a local HTTP server. The iframe communicates back via `/proxy/*` endpoints, which forward tool calls through `McpServerManager` (gated by `ConsentManager`). Optional native macOS window viewer via Glimpse.
- **Slash commands.** `/mcp-bridge reload` re-reads the registry and re-injects the context block; `/mcp-bridge status` prints connection state.
- **OpenSpec.** Behavior contracts for `mcp-bridge`, `wrapper-tools`, `config-registry`, and `context-injection`, plus the Phase 1 proposal/design/tasks in `openspec/changes/phase-1-core/`.
- **Bilingual docs.** `README.md` (EN), `README.zh-CN.md` (中文), `docs/architecture.md` / `architecture.zh-CN.md`, `docs/config-format.md` / `config-format.zh-CN.md`.

### Non-goals for Phase 1

- OAuth 2.1 flow (Phase 2).
- Server-initiated `sampling/createMessage` (Phase 3).
- Server-initiated `elicitation/create` (Phase 4).
- A `directTools` mode that registers one Pi tool per MCP tool (out of scope by design).
