// registry-writer.ts - Sync live MCP servers into the filesystem registry.
//
// Implements REQ-R-004..007 of openspec/specs/config-registry/spec.md:
//   - Atomic writes (temp file + rename) for every file we produce.
//   - `sync(serverName)` connects to a live server, lists tools + resources
//     (paginated), and writes `tools/<slug>.json` per tool. Stale tool
//     files (no longer on the server) are removed. `meta.json.syncedAt`
//     and `syncedFrom = "live-server"` are updated. `index.json` is rebuilt.
//   - `validate()` walks the registry root and reports missing required
//     fields, name/directory mismatches, duplicate tool names, and
//     invalid JSON Schemas. Exits non-zero on error (CLI wrapper).
//   - Hand-edited files (`syncedFrom = "manual"`) are not overwritten by
//     `sync` unless `--force` is passed.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { logger } from "../logger.ts";
import { getRegistryRoot } from "../agent-dir.ts";
import { slugifyToolName } from "../resource-tools.ts";
import {
  loadRegistry,
  parseServerMeta,
  parseToolDefinition,
} from "./registry-loader.ts";
import type {
  Registry,
  RegistryIndex,
  RegistryServer,
  ServerMeta,
  ToolDefinition,
} from "./registry-types.ts";

const INDEX_FILENAME = "index.json";
const META_FILENAME = "meta.json";
const TOOLS_DIRNAME = "tools";

export interface SyncOptions {
  /** Overwrite `syncedFrom = "manual"` files. */
  force?: boolean;
  /** Override the registry root (defaults to `getRegistryRoot()`). */
  rootOverride?: string;
}

export interface SyncResult {
  serverName: string;
  toolsWritten: number;
  toolsRemoved: number;
  resourcesIndexed: number;
  skipped?: string;
}

/** Connect to a live MCP server and write its tools/resources to the registry. */
export async function syncServer(
  serverName: string,
  client: Client,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const root = resolve(options.rootOverride ?? getRegistryRoot());
  const serverDir = join(root, serverName);
  const toolsDir = join(serverDir, TOOLS_DIRNAME);
  const metaPath = join(serverDir, META_FILENAME);

  // Load existing meta (if any) and check the manual-edit guard.
  let existingMeta: ServerMeta | null = null;
  if (existsSync(metaPath)) {
    try {
      existingMeta = parseServerMeta(readFileSync(metaPath, "utf-8"), serverName);
    } catch (error) {
      throw new Error(
        `Cannot sync "${serverName}": existing meta.json is unreadable (${error instanceof Error ? error.message : String(error)}). Fix or delete it and retry.`,
      );
    }
    if (existingMeta.syncedFrom === "manual" && !options.force) {
      // Only protect *hand-written* tool descriptors: if tools/ is empty,
      // there's nothing to clobber, so let the first sync proceed.
      // (doSync/doAdd create stubs with syncedFrom="manual" + empty tools/.)
      const hasHandWrittenTools =
        existsSync(toolsDir) &&
        readdirSync(toolsDir).some((f) => f.endsWith(".json"));
      if (hasHandWrittenTools) {
        return {
          serverName,
          toolsWritten: 0,
          toolsRemoved: 0,
          resourcesIndexed: 0,
          skipped: "meta.json.syncedFrom is \"manual\" and tools/ has hand-written descriptors — pass --force to overwrite",
        };
      }
    }
  }

  mkdirSync(toolsDir, { recursive: true });

  // Capture the server's instructions (from the initialize handshake).
  // This is the MCP protocol's designated server→LLM communication
  // channel; we persist it in meta.json and inject it into the context.
  const instructions = client.getInstructions();

  // Discover tools + resources (paginated).
  const tools = await fetchAllTools(client);
  const resources = await fetchAllResources(client);

  // Write one file per tool, slug-encoding the filename.
  const writtenKeys = new Set<string>();
  let toolsWritten = 0;
  for (const tool of tools) {
    if (!tool?.name) continue;
    const key = slugifyToolName(tool.name);
    const def: ToolDefinition = {
      $schema: "https://pi-mcp-bridge.dev/schemas/tool.v1.json",
      name: tool.name,
      title: tool.title,
      description: tool.description ?? "(no description)",
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: extractAnnotations(tool),
      _meta: tool._meta,
    };
    const path = join(toolsDir, `${key}.json`);
    atomicWriteJson(path, def);
    writtenKeys.add(key);
    toolsWritten++;
  }

  // Remove stale tool files (no longer on the server).
  let toolsRemoved = 0;
  if (existsSync(toolsDir)) {
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const key = entry.name.slice(0, -".json".length);
      if (!writtenKeys.has(key)) {
        rmSync(join(toolsDir, entry.name), { force: true });
        toolsRemoved++;
      }
    }
  }

  // Update meta.json (preserve user-edited fields, update sync metadata).
  const meta: ServerMeta = existingMeta
    ? {
        ...existingMeta,
        syncedAt: new Date().toISOString(),
        syncedFrom: "live-server",
        instructions: instructions ?? existingMeta.instructions,
      }
    : {
        $schema: "https://pi-mcp-bridge.dev/schemas/meta.v1.json",
        name: serverName,
        transport: { kind: "stdio", command: "" }, // caller should overwrite
        auth: { kind: "none" },
        instructions: instructions ?? undefined,
        syncedAt: new Date().toISOString(),
        syncedFrom: "live-server",
      };
  atomicWriteJson(metaPath, meta);

  // Rebuild the aggregate index.
  const registry = loadRegistry(root);
  rebuildIndex(registry);

  return {
    serverName,
    toolsWritten,
    toolsRemoved,
    resourcesIndexed: resources.length,
  };
}

/** Rebuild `index.json` from the loaded registry. Writes atomically. */
export function rebuildIndex(registry: Registry): RegistryIndex {
  const index: RegistryIndex = {
    $schema: "https://pi-mcp-bridge.dev/schemas/index.v1.json",
    version: 1,
    generatedAt: new Date().toISOString(),
    registryRoot: registry.root,
    servers: [...registry.servers.values()].map(server => ({
      name: server.name,
      description: server.meta.description,
      transportKind: server.meta.transport.kind,
      toolCount: server.tools.size,
      tools: [...server.tools.entries()].map(([key, def]) => ({
        name: key,
        description: def.description,
      })),
      resources: [],
    })),
  };
  atomicWriteJson(join(registry.root, INDEX_FILENAME), index);
  registry.index = index;
  return index;
}

export interface ValidationIssue {
  server: string;
  file: string;
  message: string;
}

/** Walk the registry and report issues. Returns an empty array on success. */
export function validateRegistry(rootOverride?: string): ValidationIssue[] {
  const root = resolve(rootOverride ?? getRegistryRoot());
  const issues: ValidationIssue[] = [];

  if (!existsSync(root)) {
    return issues; // empty registry is valid
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const serverDir = join(root, entry.name);
    validateServer(serverDir, entry.name, issues);
  }

  return issues;
}

function validateServer(serverDir: string, dirName: string, issues: ValidationIssue[]): void {
  const metaPath = join(serverDir, META_FILENAME);
  if (!existsSync(metaPath)) {
    issues.push({ server: dirName, file: META_FILENAME, message: "missing meta.json" });
    return;
  }

  let meta: ServerMeta | null = null;
  try {
    meta = parseServerMeta(readFileSync(metaPath, "utf-8"), dirName);
  } catch (error) {
    issues.push({
      server: dirName,
      file: META_FILENAME,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (meta!.name !== dirName) {
    issues.push({
      server: dirName,
      file: META_FILENAME,
      message: `meta.name "${meta!.name}" does not match directory name "${dirName}"`,
    });
  }

  const toolsDir = join(serverDir, TOOLS_DIRNAME);
  if (!existsSync(toolsDir)) return;

  const seenNames = new Set<string>();
  for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const key = entry.name.slice(0, -".json".length);
    const path = join(toolsDir, entry.name);
    try {
      const def = parseToolDefinition(readFileSync(path, "utf-8"), key);
      if (seenNames.has(def.name)) {
        issues.push({
          server: dirName,
          file: `tools/${entry.name}`,
          message: `duplicate tool name "${def.name}" (also defined in another file)`,
        });
      }
      seenNames.add(def.name);
    } catch (error) {
      issues.push({
        server: dirName,
        file: `tools/${entry.name}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// --- internals -------------------------------------------------------------

async function fetchAllTools(client: Client): Promise<import("../types.ts").McpTool[]> {
  const all: import("../types.ts").McpTool[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    all.push(...(result.tools ?? []));
    cursor = result.nextCursor;
  } while (cursor);
  return all;
}

async function fetchAllResources(client: Client): Promise<import("../types.ts").McpResource[]> {
  try {
    const all: import("../types.ts").McpResource[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listResources(cursor ? { cursor } : undefined);
      all.push(...(result.resources ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    return all;
  } catch {
    return [];
  }
}

function extractAnnotations(tool: import("../types.ts").McpTool): ToolDefinition["annotations"] {
  const meta = tool._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const annotations = (meta as Record<string, unknown>).annotations;
  if (!annotations || typeof annotations !== "object") return undefined;
  return annotations as ToolDefinition["annotations"];
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, path);
}
