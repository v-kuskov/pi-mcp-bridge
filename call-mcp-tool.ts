// call-mcp-tool.ts - Implementation of the CallMcpTool wrapper.
//
// Implements REQ-W-001..008 of openspec/specs/wrapper-tools/spec.md.
// The wrapper:
//   1. Resolves `server` against the in-memory registry.
//   2. Resolves `toolName` (registry key, slug, or original MCP name).
//   3. Lazily connects to the server using `meta.json` transport config.
//   4. Forwards `arguments` to `client.callTool` (no client-side validation).
//   5. Maps the MCP `CallToolResult` to a Pi `AgentToolResult`, applies
//      the output guard, and returns.
//   6. Honors `AbortSignal` and returns `details.error = "aborted"`.
//
// The bridge never validates `arguments` against the tool's schema —
// the MCP server is the validator of record. Schema errors from the
// server are surfaced to the model with the server's error message.

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpBridgeState } from "./state.ts";
import type { McpContent, ToolMetadata } from "./types.ts";
import { findToolInRegistry, listServerNames, listToolKeys } from "./registry/registry-loader.ts";
import { metaToServerEntry } from "./registry/registry-types.ts";
import { buildToolMetadata, findToolByName, formatSchema, getToolNames } from "./tool-metadata.ts";
import { resolveMcpResultContent, transformMcpContent } from "./tool-registrar.ts";
import { guardMcpOutput, guardedMcpDetails, resolveMcpOutputGuardOptions } from "./mcp-output-guard.ts";
import { logger } from "./logger.ts";
import { throwIfAborted } from "./abort.ts";

export interface CallMcpToolParams {
  server: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export type CallMcpToolResult = AgentToolResult<Record<string, unknown>>;

/** Execute the CallMcpTool wrapper. Exported for unit testing. */
export async function executeCallMcpTool(
  state: McpBridgeState,
  params: CallMcpToolParams,
  signal?: AbortSignal,
): Promise<CallMcpToolResult> {
  throwIfAborted(signal);

  // --- Server resolution (REQ-W-002) -------------------------------------
  const server = state.registry.servers.get(params.server);
  if (!server) {
    return notFound("server_not_found", `Server "${params.server}" not found.`, listServerNames(state.registry));
  }

  // --- Tool resolution (REQ-W-003) --------------------------------------
  const match = findToolInRegistry(state.registry, params.server, params.toolName);
  if (!match) {
    const available = listToolKeys(state.registry, params.server);
    return notFound(
      "tool_not_found",
      `Tool "${params.toolName}" not found on "${params.server}".`,
      available,
    );
  }
  const tool = match.tool;

  // --- Consent gate (opt-in via settings.requireConsent) ----------------
  if (state.settings.requireConsent && state.consentManager.requiresPrompt(params.server)) {
    const hint = `Server "${params.server}" requires user consent before tool calls. Run \`/mcp-bridge approve ${params.server}\` in the Pi prompt to approve it, then retry.`;
    state.ui?.notify?.(hint, "warning");
    return {
      content: [{ type: "text", text: hint }],
      details: { mode: "call", error: "consent_required", server: params.server },
    };
  }

  // --- Lazy connect (REQ-W-004) -----------------------------------------
  let connection = state.manager.getConnection(params.server);
  if (!connection || connection.status !== "connected") {
    try {
      connection = await state.manager.connect(params.server, metaToServerEntry(server.meta), signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          { type: "text", text: `Failed to connect to "${params.server}": ${message}` },
        ],
        details: { mode: "call", error: "connect_failed", server: params.server, message },
      };
    }
  }

  if (connection.status === "needs-auth") {
    const message = `Server "${params.server}" requires authentication. Phase 1 supports bearer tokens only (set them in registry/${params.server}/meta.json). OAuth is Phase 2.`;
    return {
      content: [{ type: "text", text: message }],
      details: { mode: "call", error: "auth_required", server: params.server, message },
    };
  }

  // --- Forward (REQ-W-005) ----------------------------------------------
  const outputGuardOptions = resolveMcpOutputGuardOptions(state.settings);

  try {
    state.manager.touch(params.server);
    state.manager.incrementInFlight(params.server);

    const result = (await state.manager.callTool(
      params.server,
      {
        name: tool.name,
        arguments: params.arguments ?? {},
      },
      signal,
    )) as CallToolResult;

    // --- Result mapping (REQ-W-006) --------------------------------------
    if (result.isError) {
      const mcpContent = (result.content ?? []) as McpContent[];
      const content = transformMcpContent(mcpContent);
      const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
      const schemaText = tool.inputSchema
        ? `\n\nExpected parameters:\n${formatSchema(tool.inputSchema)}`
        : "";
      const guarded = await guardMcpOutput(outputContent, {
        ...outputGuardOptions,
        prefix: "Error: ",
        suffix: schemaText,
        emptyTextFallback: "Tool execution failed",
        rawMcpResult: result,
      });
      return {
        content: guarded.content,
        details: { mode: "call", error: "tool_error", ...guardedMcpDetails(guarded) },
      };
    }

    const content = resolveMcpResultContent(result as Record<string, unknown>);
    const outputContent = content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }];
    const guarded = await guardMcpOutput(outputContent, {
      ...outputGuardOptions,
      rawMcpResult: result,
    });
    return {
      content: guarded.content,
      details: {
        mode: "call",
        ...guardedMcpDetails(guarded),
        server: params.server,
        tool: tool.name,
      },
    };
  } catch (error) {
    // --- Abort handling (REQ-W-007) -------------------------------------
    if (signal?.aborted) {
      return {
        content: [{ type: "text", text: "CallMcpTool aborted." }],
        details: { mode: "call", error: "aborted", server: params.server, tool: tool.name },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    const schemaText = tool.inputSchema
      ? `\n\nExpected parameters:\n${formatSchema(tool.inputSchema)}`
      : "";
    const guarded = await guardMcpOutput(
      [{ type: "text" as const, text: message }],
      { ...outputGuardOptions, prefix: "Failed to call tool: ", suffix: schemaText },
    );
    return {
      content: guarded.content,
      details: {
        mode: "call",
        error: "call_failed",
        message: guarded.outputGuard ? "output truncated; see outputGuard.fullOutputPath" : message,
        ...guardedMcpDetails(guarded),
      },
    };
  } finally {
    state.manager.decrementInFlight(params.server);
    state.manager.touch(params.server);
  }
}

function notFound(error: string, message: string, available: string[]): CallMcpToolResult {
  const suffix = available.length > 0 ? ` Available: ${available.join(", ")}` : "";
  return {
    content: [{ type: "text", text: `${message}${suffix}` }],
    details: { mode: "call", error, available },
  };
}

/**
 * Build a `ToolMetadata` entry for a registry tool, so the rest of the
 * bridge (which expects `ToolMetadata[]`) can use it. This is used when
 * the in-memory `toolMetadata` map is queried by other modules.
 */
export function registryToolToMetadata(
  serverName: string,
  toolKey: string,
  tool: import("./registry/registry-types.ts").ToolDefinition,
): ToolMetadata {
  return {
    name: tool.name,
    originalName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
