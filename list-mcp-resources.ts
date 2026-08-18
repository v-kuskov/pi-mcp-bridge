// list-mcp-resources.ts - Implementation of the ListMcpResources wrapper.
//
// Cursor-parity tool: Cursor exposes both `ListMcpResources` and
// `FetchMcpResource`. We previously only had the fetch half; this adds
// the list half so the model can discover what resources a server exposes
// before fetching one.
//
// Behavior:
//   1. Resolve `server` against the in-memory registry.
//   2. Lazily connect (same as CallMcpTool / FetchMcpResource).
//   3. Call `client.listResources()` (paginated).
//   4. Return a compact text listing: one line per resource with
//      `uri — name: description (mimeType)`.
//   5. Honor AbortSignal.

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { McpResource } from "./types.ts";
import type { McpBridgeState } from "./state.ts";
import { listServerNames } from "./registry/registry-loader.ts";
import { metaToServerEntry } from "./registry/registry-types.ts";
import { authRequiredFailure, connectFailure, formatToolFailure, notFoundResult, serverNotFoundFailure } from "./errors.ts";
import { logger } from "./logger.ts";
import { throwIfAborted } from "./abort.ts";

export interface ListMcpResourcesParams {
  server: string;
}

export type ListMcpResourcesResult = AgentToolResult<Record<string, unknown>>;

/** Execute the ListMcpResources wrapper. Exported for unit testing. */
export async function executeListMcpResources(
  state: McpBridgeState,
  params: ListMcpResourcesParams,
  signal?: AbortSignal,
): Promise<ListMcpResourcesResult> {
  throwIfAborted(signal);

  // --- Server resolution ---
  const server = state.registry.servers.get(params.server);
  if (!server) {
    return notFoundResult(
      "list-resources",
      "server_not_found",
      serverNotFoundFailure("ListMcpResources", params.server),
      listServerNames(state.registry),
    );
  }

  // --- Lazy connect ---
  let connection = state.manager.getConnection(params.server);
  if (!connection || connection.status !== "connected") {
    try {
      connection = await state.manager.connect(params.server, metaToServerEntry(server.meta), signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: connectFailure("ListMcpResources", params.server, message) }],
        details: { mode: "list-resources", error: "connect_failed", server: params.server, message },
      };
    }
  }

  if (connection.status === "needs-auth") {
    const message = authRequiredFailure("ListMcpResources", params.server);
    return {
      content: [{ type: "text", text: message }],
      details: { mode: "list-resources", error: "auth_required", server: params.server, message },
    };
  }

  // --- List resources (paginated) ---
  try {
    state.manager.touch(params.server);
    state.manager.incrementInFlight(params.server);

    const resources: McpResource[] = [];
    let cursor: string | undefined;
    do {
      throwIfAborted(signal);
      const client = connection.client;
      const result = await client.listResources(cursor ? { cursor } : undefined);
      resources.push(...(result.resources ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    if (resources.length === 0) {
      return {
        content: [{ type: "text", text: `Server "${params.server}" exposes no resources.` }],
        details: { mode: "list-resources", server: params.server, count: 0 },
      };
    }

    const lines = resources.map(r => {
      const name = r.name ?? "";
      const desc = r.description ?? "";
      const mime = r.mimeType ? ` (${r.mimeType})` : "";
      const descPart = desc ? `: ${desc}` : name ? "" : "";
      return `- ${r.uri} — ${name}${descPart}${mime}`;
    });
    const header = `Server "${params.server}" exposes ${resources.length} resource(s):`;
    return {
      content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
      details: { mode: "list-resources", server: params.server, count: resources.length },
    };
  } catch (error) {
    if (signal?.aborted) {
      return {
        content: [{ type: "text", text: "ListMcpResources aborted." }],
        details: { mode: "list-resources", error: "aborted", server: params.server },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: formatToolFailure({
            action: "ListMcpResources",
            server: params.server,
            what: `Could not list resources: ${message}`,
            hints: ["Run `/mcp-bridge status` to check the server is healthy."],
          }),
        },
      ],
      details: { mode: "list-resources", error: "list_failed", server: params.server, message },
    };
  } finally {
    state.manager.decrementInFlight(params.server);
    state.manager.touch(params.server);
  }
}

// Suppress unused-import warning for logger (kept for future diagnostic logging).
void logger;
