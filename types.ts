// types.ts - Core type definitions for pi-mcp-bridge
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";

// Transport type (stdio + HTTP)
export type Transport =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport;

// Tool definition from MCP server
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown; // JSON Schema
  _meta?: Record<string, unknown>;
}

// Resource definition from MCP server
export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

// Content types from MCP
export interface McpContent {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    text?: string;
    blob?: string;
  };
  uri?: string;
  name?: string;
  description?: string;
}

// Pi content block type
export type ContentBlock = TextContent | ImageContent;

// OAuth configuration (Phase 2+ — kept here so the registry type system is forward-compatible).
export interface OAuthConfig {
  grantType?: "authorization_code" | "client_credentials";
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  clientName?: string;
  clientUri?: string;
}

// Server configuration (mirrors `registry/<server>/meta.json`)
export interface ServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // HTTP fields
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | "none";
  bearerToken?: string;
  bearerTokenEnv?: string;
  oauth?: OAuthConfig | false;
  lifecycle?: "keep-alive" | "lazy" | "eager";
  idleTimeout?: number; // minutes, overrides global setting
  requestTimeoutMs?: number; // ms, overrides global request timeout when > 0
  exposeResources?: boolean;
  excludeTools?: string[];
  debug?: boolean;
}

// Output guard tuning (settings.outputGuard object form)
export interface McpOutputGuardSettings {
  maxBytes?: number;
  maxLines?: number;
  detailsMaxBytes?: number;
}

// Bridge-wide settings (mirrors `~/.pi/agent/mcp-bridge.json` if present)
export interface BridgeSettings {
  idleTimeout?: number; // minutes, default 10, 0 to disable
  requestTimeoutMs?: number; // ms, overrides SDK default when > 0
  outputGuard?: boolean | McpOutputGuardSettings;
  /** Token budget for the session-start context injection. Default 4000. */
  contextBudgetTokens?: number;
  /**
   * Maximum total tool count for which full inputSchemas are injected
   * inline. Registries with more tools fall back to descriptions-only
   * (the model reads schema files on demand). Default 10. Set to 0 to
   * disable schema injection entirely; set to a large number to always
   * include schemas when they fit the token budget.
   */
  schemaInjectionToolLimit?: number;
  /**
   * When true, CallMcpTool blocks on the first call to each server until the
   * user runs `/mcp-bridge approve <server>`. Default false (no consent gate).
   */
  requireConsent?: boolean;
}

// Tool metadata used by the bridge (in-memory representation of registry tools)
export interface ToolMetadata {
  name: string; // Prefixed tool name (e.g., "xcodebuild_list_sims")
  originalName: string; // Original MCP tool name (e.g., "list_sims")
  description: string;
  resourceUri?: string; // For resource tools: the URI to read
  inputSchema?: unknown; // JSON Schema for parameters
}

/**
 * Get server prefix based on tool prefix mode.
 *
 * In pi-mcp-bridge the prefix mode is always "server" (the original MCP
 * tool name is preserved in the registry's `name` field, and the prefixed
 * name is used only for display and disambiguation). The function is kept
 * for parity with the upstream adapter.
 */
export function getServerPrefix(
  serverName: string,
  mode: "server" | "none" | "short" = "server",
): string {
  if (mode === "none") return "";
  if (mode === "short") {
    let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    if (!short) short = "mcp";
    return short;
  }
  return serverName.replace(/-/g, "_");
}

/** Format a tool name with server prefix. */
export function formatToolName(
  toolName: string,
  serverName: string,
  prefix: "server" | "none" | "short" = "server",
): string {
  const p = getServerPrefix(serverName, prefix);
  return p ? `${p}_${toolName}` : toolName;
}

function normalizeToolName(value: string): string {
  return value.replace(/-/g, "_");
}

/** Check if a tool is excluded by `excludeTools`. Matches both original and prefixed names. */
export function isToolExcluded(
  toolName: string,
  serverName: string,
  prefix: "server" | "none" | "short" = "server",
  excludeTools?: unknown,
): boolean {
  if (!Array.isArray(excludeTools) || excludeTools.length === 0) return false;

  const candidates = new Set<string>([
    normalizeToolName(toolName),
    normalizeToolName(formatToolName(toolName, serverName, prefix)),
    normalizeToolName(formatToolName(toolName, serverName, "server")),
    normalizeToolName(formatToolName(toolName, serverName, "short")),
  ]);

  for (const excluded of excludeTools) {
    if (typeof excluded !== "string") continue;
    if (candidates.has(normalizeToolName(excluded))) {
      return true;
    }
  }
  return false;
}
