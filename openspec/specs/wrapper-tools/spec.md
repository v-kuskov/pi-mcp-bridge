# Spec: wrapper-tools

> Behavior contract for the two LLM-callable tools `CallMcpTool` and
> `FetchMcpResource`. These are the entire MCP surface exposed to the model.

## `CallMcpTool`

### Signature

```ts
CallMcpTool({
  server: string,        // required — MCP server identifier (matches registry/<server>/meta.json)
  toolName: string,     // required — MCP tool name (matches a tools/<toolName>.json file)
  arguments?: object,   // optional — arguments object as described in the tool's schema
}): AgentToolResult
```

### Requirements

#### REQ-W-001: Parameter shape

The tool's `parameters` schema (registered with Pi) MUST be:

```json
{
  "type": "object",
  "properties": {
    "server": { "type": "string", "description": "Identifier of the MCP server hosting the tool." },
    "toolName": { "type": "string", "description": "Name of the MCP tool to invoke." },
    "arguments": { "type": "object", "description": "Arguments to pass to the MCP tool, as described in the tool descriptor." }
  },
  "required": ["server", "toolName"]
}
```

The schema MUST NOT include server-specific or tool-specific fields. All
such fields live inside `arguments` and are validated by the MCP server, not
by the bridge.

#### REQ-W-002: Server resolution

Given `server`:
- If `server` matches a directory in the registry, the bridge MUST use
  that server.
- If `server` does not match any registry directory, the tool MUST return a
  result with `details.error = "server_not_found"` and a human-readable
  message listing the available servers.

#### REQ-W-003: Tool resolution

Given `server` and `toolName`:
- The bridge MUST look up the tool's `originalName` (the unprefixed MCP
  name) from the registry. The registry's `<toolName>.json` file's `name`
  field is the original MCP name; the filename is the registry key.
- If the tool is not in the registry, the tool MUST return
  `details.error = "tool_not_found"` with a list of available tools on
  that server.
- The bridge MAY attempt a fuzzy match on hyphens/underscores
  (`read-file` ≈ `read_file`) and proceed if the match is unique.

#### REQ-W-004: Lazy connect

If the target server is not currently connected:
- The bridge MUST connect to it (using `meta.json` transport config)
  before forwarding the call.
- If the connection fails, the tool MUST return
  `details.error = "connect_failed"` with the underlying error message.
- If the connection requires auth (Phase 2+), the tool MUST return
  `details.error = "auth_required"` with instructions. (Phase 1: bearer
  tokens from `meta.json` are applied automatically; OAuth is out of
  scope.)

#### REQ-W-005: Argument forwarding

The bridge MUST forward `arguments ?? {}` to the MCP server's `tools/call`
request as `arguments`. The bridge MUST NOT validate `arguments` against
the tool's schema — the MCP server is the validator of record. Schema
errors from the server MUST be surfaced to the model with the server's
error message.

#### REQ-W-006: Result mapping

The MCP `CallToolResult` MUST be mapped to a Pi `AgentToolResult`:
- `result.content` (array of text/image/audio/resource blocks) maps to
  `AgentToolResult.content` with the same block types.
- `result.isError === true` MUST set `details.error = "tool_error"` and
  prefix the content with `Error: `.
- The bridge MUST apply the output guard (see `mcp-bridge` REQ-006) to
  the content before returning.
- `details` MUST include `{ mode: "call", server, tool: <originalName>, ...outputGuardDetails }`.

#### REQ-W-007: Abort handling

When the `AbortSignal` aborts:
- The in-flight `client.callTool` request MUST be cancelled.
- The tool MUST return `details.error = "aborted"` (not throw).
- The server connection MUST remain usable for subsequent calls.

#### REQ-W-008: UI resource hooks

*Removed in v0.6.0* — the MCP UI machinery (ui-server, ui-session,
ui-resource-handler, host-html-template, glimpse-ui, app-bridge) was cut.
Tools declaring `uiResourceUri` in their descriptors are no longer
rendered; the field is ignored by the bridge.

### Scenarios

```gherkin
Scenario: Call a tool that exists
Given registry/filesystem/tools/read_file.json exists
And server "filesystem" is configured for stdio transport
When the LLM calls CallMcpTool({ server: "filesystem", toolName: "read_file", arguments: { path: "/a" } })
Then the bridge connects to "filesystem"
And forwards tools/call with name "read_file" and arguments { path: "/a" }
And returns the mapped, guarded result

Scenario: Call a tool that does not exist
Given registry/filesystem/ has tools [read_file, list_files]
When the LLM calls CallMcpTool({ server: "filesystem", toolName: "delete_file" })
Then the bridge returns content "Tool \"delete_file\" not found on \"filesystem\". Available: read_file, list_files"
And details.error = "tool_not_found"
And no server connection is attempted

Scenario: Call a tool on a server that does not exist
Given registry/ has servers [filesystem, github]
When the LLM calls CallMcpTool({ server: "slack", toolName: "send_message" })
Then the bridge returns content "Server \"slack\" not found. Available: filesystem, github"
And details.error = "server_not_found"
And no server connection is attempted
```

## `FetchMcpResource`

### Signature

```ts
FetchMcpResource({
  server: string,                // required — MCP server identifier
  uri: string,                   // required — resource URI to read
  downloadPath?: string,         // optional — workspace-relative path; if set, write to disk instead of returning to model
}): AgentToolResult
```

### Requirements

#### REQ-W-009: Parameter shape

The tool's `parameters` schema MUST be:

```json
{
  "type": "object",
  "properties": {
    "server": { "type": "string", "description": "The MCP server identifier" },
    "uri": { "type": "string", "description": "The resource URI to read" },
    "downloadPath": { "type": "string", "description": "Optional relative path in the workspace to save the resource to. When set, the resource is written to disk and is not returned to the model." }
  },
  "required": ["server", "uri"]
}
```

#### REQ-W-010: Server resolution

Same as REQ-W-002.

#### REQ-W-011: Read forwarding

The bridge MUST forward to `client.readResource({ uri })`. The bridge MUST
NOT validate `uri` against the server's declared resource list — the
server is the validator of record.

#### REQ-W-012: Download path

If `downloadPath` is set:
- The bridge MUST write the resource content to
  `<workspace root>/<downloadPath>` (creating parent directories).
- The bridge MUST NOT return the content to the model. Instead, the
  result content MUST be a short confirmation: `Resource <uri> written to <downloadPath> (<n> bytes)`.
- The bridge MUST reject paths that escape the workspace root (`..`,
  absolute paths) with `details.error = "invalid_download_path"`.

#### REQ-W-013: Result mapping (no download)

If `downloadPath` is not set:
- `result.contents` (array of `TextResourceContents` /
  `BlobResourceContents`) maps to `AgentToolResult.content`.
- Text contents become `{ type: "text", text: <contents.text> }`.
- Blob contents become `{ type: "text", text: "[Binary resource: <mimeType>, <n> bytes]" }`.
  (Phase 1 does not surface binary resources as image blocks.)
- The output guard applies.
- `details` MUST include `{ mode: "fetch", server, uri, ...outputGuardDetails }`.

#### REQ-W-014: Abort handling

Same as REQ-W-007 but for `client.readResource`.

### Scenarios

```gherkin
Scenario: Fetch a text resource
Given server "filesystem" is connected
When the LLM calls FetchMcpResource({ server: "filesystem", uri: "file:///tmp/notes.txt" })
Then the bridge returns content with the file text
And details.mode = "fetch"

Scenario: Fetch and download
Given server "filesystem" is connected
When the LLM calls FetchMcpResource({ server: "filesystem", uri: "file:///tmp/notes.txt", downloadPath: "notes/notes.txt" })
Then the bridge writes the content to <workspace>/notes/notes.txt
And returns content "Resource file:///tmp/notes.txt written to notes/notes.txt (<n> bytes)"
And does NOT include the resource text in the returned content

Scenario: Reject path traversal
When the LLM calls FetchMcpResource({ server: "s", uri: "u", downloadPath: "../escape.txt" })
Then the bridge returns details.error = "invalid_download_path"
And does not write any file
```
