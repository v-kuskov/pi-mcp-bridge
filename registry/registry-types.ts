// registry-types.ts - TypeScript types for the filesystem registry.
//
// Mirrors the JSON Schemas in `registry/schemas/`. These types are the
// in-memory representation of `meta.json`, `tools/<tool>.json`, and
// `index.json`.

/** Transport configuration for `meta.json`. */
export type RegistryTransport =
  | {
      kind: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      kind: "http";
      url: string;
      headers?: Record<string, string>;
    };

/** Auth configuration for `meta.json`. */
export type RegistryAuth =
  | { kind: "none" }
  | { kind: "bearer"; bearerToken?: string; bearerTokenEnv?: string }
  | {
      kind: "oauth";
      grantType?: "authorization_code" | "client_credentials";
      clientId?: string;
      clientSecret?: string;
      scope?: string;
      redirectUri?: string;
      clientName?: string;
      clientUri?: string;
    };

/** Lifecycle configuration for `meta.json`. */
export interface RegistryLifecycle {
  mode?: "lazy" | "eager" | "keep-alive";
  idleTimeoutMinutes?: number;
  requestTimeoutMs?: number;
}

/** Capability flags for `meta.json`. */
export interface RegistryCapabilities {
  tools?: boolean;
  resources?: boolean;
  prompts?: boolean;
  sampling?: boolean;
  elicitation?: boolean;
}

/** Schema for `registry/<server>/meta.json`. */
export interface ServerMeta {
  $schema?: string;
  name: string;
  version?: string;
  description?: string;
  /**
   * Instructions returned by the MCP server in its `initialize` response.
   * Captured at sync time and injected into the agent context so the model
   * understands the server's purpose and how to use its tools. This is the
   * MCP protocol's designated mechanism for server→LLM communication.
   */
  instructions?: string;
  transport: RegistryTransport;
  auth: RegistryAuth;
  lifecycle?: RegistryLifecycle;
  capabilities?: RegistryCapabilities;
  exposeResources?: boolean;
  excludeTools?: string[];
  syncedAt?: string;
  syncedFrom?: "live-server" | "manual";
}

/** MCP standard tool annotations. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Schema for `registry/<server>/tools/<tool-key>.json`. */
export interface ToolDefinition {
  $schema?: string;
  /** Original MCP tool name (sent to `tools/call`). */
  name: string;
  title?: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: unknown;
  /** JSON Schema for the tool's output (informational). */
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

/** A resource entry in `index.json`. */
export interface IndexedResource {
  uri: string;
  name: string;
  description?: string;
}

/** A tool entry in `index.json` (compact, no schema). */
export interface IndexedTool {
  name: string;
  description?: string;
}

/** A server entry in `index.json`. */
export interface IndexedServer {
  name: string;
  description?: string;
  transportKind: "stdio" | "http";
  toolCount: number;
  tools: IndexedTool[];
  resources: IndexedResource[];
}

/** Schema for `registry/index.json`. */
export interface RegistryIndex {
  $schema?: string;
  version: 1;
  generatedAt: string;
  registryRoot: string;
  servers: IndexedServer[];
}

/**
 * In-memory mirror of one server's registry entry.
 * `toolKey` is the filename (slug); `definition` is the parsed JSON.
 */
export interface RegistryServer {
  name: string;
  meta: ServerMeta;
  /** Map from tool key (filename) → tool definition. */
  tools: Map<string, ToolDefinition>;
  /** Path to the server directory on disk. */
  directory: string;
}

/**
 * In-memory mirror of the whole registry.
 * Loaded by `registry-loader.ts` from `<registry-root>/`.
 */
export interface Registry {
  root: string;
  /** Map from server name → server entry. */
  servers: Map<string, RegistryServer>;
  /** The generated aggregate index (rebuilt by `registry-writer.ts`). */
  index: RegistryIndex | null;
}

/** Convert a `ServerMeta` to the legacy `ServerEntry` used by `server-manager`. */
export function metaToServerEntry(meta: ServerMeta): import("../types.ts").ServerEntry {
  const entry: import("../types.ts").ServerEntry = {};
  if (meta.transport.kind === "stdio") {
    entry.command = meta.transport.command;
    entry.args = meta.transport.args;
    entry.env = meta.transport.env;
    entry.cwd = meta.transport.cwd;
  } else {
    entry.url = meta.transport.url;
    entry.headers = meta.transport.headers;
  }
  if (meta.auth.kind === "bearer") {
    entry.auth = "bearer";
    entry.bearerToken = meta.auth.bearerToken;
    entry.bearerTokenEnv = meta.auth.bearerTokenEnv;
  } else if (meta.auth.kind === "oauth") {
    entry.auth = "oauth";
    entry.oauth = {
      grantType: meta.auth.grantType,
      clientId: meta.auth.clientId,
      clientSecret: meta.auth.clientSecret,
      scope: meta.auth.scope,
      redirectUri: meta.auth.redirectUri,
      clientName: meta.auth.clientName,
      clientUri: meta.auth.clientUri,
    };
  } else {
    entry.auth = "none";
  }
  if (meta.lifecycle) {
    entry.lifecycle = meta.lifecycle.mode;
    entry.idleTimeout = meta.lifecycle.idleTimeoutMinutes;
    entry.requestTimeoutMs = meta.lifecycle.requestTimeoutMs;
  }
  entry.exposeResources = meta.exposeResources;
  entry.excludeTools = meta.excludeTools;
  return entry;
}
