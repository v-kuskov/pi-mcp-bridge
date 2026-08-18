// fetch-mcp-resource.ts - Implementation of the FetchMcpResource wrapper.
//
// Implements REQ-W-009..014 of openspec/specs/wrapper-tools/spec.md.
// The wrapper:
//   1. Resolves `server` against the in-memory registry.
//   2. Lazily connects to the server using `meta.json` transport config.
//   3. Forwards `uri` to `client.readResource` (no client-side validation).
//   4. If `downloadPath` is set, writes the content to disk and returns a
//      short confirmation (NOT the content). Path traversal and absolute
//      paths are rejected.
//   5. Otherwise maps `ReadResourceResult.contents` to text blocks,
//      applies the output guard, and returns.
//   6. Honors `AbortSignal` and returns `details.error = "aborted"`.

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ReadResourceResult, ResourceContents } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { McpBridgeState } from "./state.ts";
import type { ContentBlock } from "./types.ts";
import { listServerNames } from "./registry/registry-loader.ts";
import { metaToServerEntry } from "./registry/registry-types.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { authRequiredFailure, connectFailure, formatToolFailure, notFoundResult, serverNotFoundFailure } from "./errors.ts";
import { throwIfAborted } from "./abort.ts";

export interface FetchMcpResourceParams {
  server: string;
  uri: string;
  downloadPath?: string;
}

export type FetchMcpResourceResult = AgentToolResult<Record<string, unknown>>;

/** Execute the FetchMcpResource wrapper. Exported for unit testing. */
export async function executeFetchMcpResource(
  state: McpBridgeState,
  params: FetchMcpResourceParams,
  signal?: AbortSignal,
): Promise<FetchMcpResourceResult> {
  throwIfAborted(signal);

  // --- Server resolution (REQ-W-010) -------------------------------------
  const server = state.registry.servers.get(params.server);
  if (!server) {
    return notFoundResult(
      "fetch",
      "server_not_found",
      serverNotFoundFailure("FetchMcpResource", params.server),
      listServerNames(state.registry),
    );
  }

  // --- Download path validation (REQ-W-012) ------------------------------
  if (params.downloadPath !== undefined) {
    const validation = validateDownloadPath(params.downloadPath);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: validation.message }],
        details: { mode: "fetch", error: "invalid_download_path", server: params.server, uri: params.uri },
      };
    }
  }

  // --- Lazy connect (same as CallMcpTool) --------------------------------
  let connection = state.manager.getConnection(params.server);
  if (!connection || connection.status !== "connected") {
    try {
      connection = await state.manager.connect(params.server, metaToServerEntry(server.meta), signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: connectFailure("FetchMcpResource", params.server, message) }],
        details: { mode: "fetch", error: "connect_failed", server: params.server, message },
      };
    }
  }

  if (connection.status === "needs-auth") {
    const message = authRequiredFailure("FetchMcpResource", params.server);
    return {
      content: [{ type: "text", text: message }],
      details: { mode: "fetch", error: "auth_required", server: params.server, uri: params.uri, message },
    };
  }

  // --- Read forwarding (REQ-W-011) ---------------------------------------
  let result: ReadResourceResult;
  try {
    result = await state.manager.readResource(params.server, params.uri, signal);
  } catch (error) {
    if (signal?.aborted) {
      return {
        content: [{ type: "text", text: "FetchMcpResource aborted." }],
        details: { mode: "fetch", error: "aborted", server: params.server, uri: params.uri },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const guarded = await guardMcpOutput(
      [
        {
          type: "text" as const,
          text: formatToolFailure({
            action: "FetchMcpResource",
            server: params.server,
            what: `Could not read the resource: ${message}`,
            hints: [
              "Check that the URI is correct and the server exposes it.",
              "Run `/mcp-bridge status` to check the server is healthy.",
            ],
          }),
        },
      ],
      { ...resolveMcpOutputGuardOptions(state.settings) },
    );
    return {
      content: guarded.content,
      details: {
        mode: "fetch",
        error: "read_failed",
        server: params.server,
        uri: params.uri,
        message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message,
        ...guardedMcpDetails(guarded),
      },
    };
  }

  const contents = Array.isArray(result.contents) ? result.contents : [];

  // --- Download path (REQ-W-012) -----------------------------------------
  if (params.downloadPath !== undefined) {
    const workspaceRoot = process.cwd();
    const targetPath = resolve(workspaceRoot, params.downloadPath);
    const text = collectText(contents);
    const bytes = Buffer.byteLength(text, "utf8");
    try {
      mkdirSync(join(targetPath, ".."), { recursive: true });
      writeFileSync(targetPath, text, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: formatToolFailure({
              action: "FetchMcpResource",
              server: params.server,
              what: `Could not write to "${params.downloadPath}": ${message}`,
              hints: ["Check the target directory is writable and the path is workspace-relative."],
            }),
          },
        ],
        details: { mode: "fetch", error: "write_failed", server: params.server, uri: params.uri, message },
      };
    }
    return {
      content: [
        { type: "text", text: `Resource ${params.uri} written to ${params.downloadPath} (${bytes} bytes)` },
      ],
      details: {
        mode: "fetch",
        server: params.server,
        uri: params.uri,
        downloadPath: params.downloadPath,
        bytes,
      },
    };
  }

  // --- Result mapping (REQ-W-013) ---------------------------------------
  const content = mapContents(contents);
  const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty resource)" }];
  const guarded = await guardMcpOutput(outputContent, {
    ...resolveMcpOutputGuardOptions(state.settings),
  });
  return {
    content: guarded.content,
    details: {
      mode: "fetch",
      server: params.server,
      uri: params.uri,
      ...guardedMcpDetails(guarded),
    },
  };
}

function validateDownloadPath(downloadPath: string): { ok: true } | { ok: false; message: string } {
  if (!downloadPath) return { ok: false, message: "downloadPath must not be empty" };
  if (isAbsolute(downloadPath)) {
    return { ok: false, message: `downloadPath must be workspace-relative (got absolute: "${downloadPath}")` };
  }
  // Reject `..` traversal. Normalize and check it stays under the workspace root.
  const normalized = normalize(downloadPath).replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.includes("..")) {
    return { ok: false, message: `downloadPath must not escape the workspace (got "${downloadPath}")` };
  }
  return { ok: true };
}

function mapContents(contents: ResourceContents[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const c of contents) {
    if (c === null || typeof c !== "object") continue;
    const record = c as Record<string, unknown>;
    if ("text" in record && typeof record.text === "string") {
      blocks.push({ type: "text", text: record.text });
    } else if ("blob" in record && typeof record.blob === "string") {
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream";
      const bytes = Buffer.byteLength(record.blob, "base64");
      blocks.push({
        type: "text",
        text: `[Binary resource: ${mimeType}, ${bytes} bytes]`,
      });
    }
  }
  return blocks;
}

function collectText(contents: ResourceContents[]): string {
  return mapContents(contents)
    .filter(b => b.type === "text")
    .map(b => (b as { text: string }).text)
    .join("\n");
}
