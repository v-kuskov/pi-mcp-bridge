# Delta: wrapper-tools

> Phase 1 deltas against `openspec/specs/wrapper-tools/spec.md`. All
> requirements are ADDED.

## ADDED Requirements — `CallMcpTool`

- **ADDED REQ-W-001: Parameter shape** — `{ server, toolName, arguments? }`
  with `required: [server, toolName]`. No server/tool-specific fields in
  the registered schema.
- **ADDED REQ-W-002: Server resolution** — match against registry
  directories; `details.error = "server_not_found"` with available list
  on miss.
- **ADDED REQ-W-003: Tool resolution** — look up `originalName` from
  `tools/<toolName>.json`; `details.error = "tool_not_found"` with
  available list on miss; fuzzy match on hyphens/underscores allowed.
- **ADDED REQ-W-004: Lazy connect** — connect using `meta.json`
  transport config; `details.error = "connect_failed"` on failure;
  `details.error = "auth_required"` (Phase 2+; Phase 1 applies bearer
  tokens automatically).
- **ADDED REQ-W-005: Argument forwarding** — forward `arguments ?? {}`
  as-is; server is the validator of record; surface schema errors.
- **ADDED REQ-W-006: Result mapping** — map `CallToolResult` to
  `AgentToolResult`; `isError` → `details.error = "tool_error"`; apply
  output guard; `details.mode = "call"`.
- **ADDED REQ-W-007: Abort handling** — cancel in-flight call; return
  `details.error = "aborted"`; keep connection usable.

## ADDED Requirements — `FetchMcpResource`

- **ADDED REQ-W-009: Parameter shape** — `{ server, uri, downloadPath? }`
  with `required: [server, uri]`.
- **ADDED REQ-W-010: Server resolution** — same as REQ-W-002.
- **ADDED REQ-W-011: Read forwarding** — forward to
  `client.readResource({ uri })`; no client-side URI validation.
- **ADDED REQ-W-012: Download path** — if set, write to
  `<workspace>/<downloadPath>`, return short confirmation (not content);
  reject `..` and absolute paths with
  `details.error = "invalid_download_path"`.
- **ADDED REQ-W-013: Result mapping (no download)** — map
  `ReadResourceResult.contents` to text blocks; blob contents become
  `[Binary resource: <mimeType>, <n> bytes]`; apply output guard;
  `details.mode = "fetch"`.
- **ADDED REQ-W-014: Abort handling** — same as REQ-W-007 but for
  `readResource`.

## ADDED Scenarios

- **ADDED** Call a tool that exists — connect, forward, return guarded
  result.
- **ADDED** Call a tool that does not exist — `tool_not_found`, no
  connection attempted.
- **ADDED** Call a tool on a server that does not exist —
  `server_not_found`, no connection attempted.
- **ADDED** Fetch a text resource — return text content, `mode = "fetch"`.
- **ADDED** Fetch and download — write to disk, return short
  confirmation, no content.
- **ADDED** Reject path traversal — `invalid_download_path`, no file
  written.
