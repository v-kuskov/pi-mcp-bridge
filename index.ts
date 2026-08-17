// index.ts - Pi extension entry point.
//
// Registers exactly two LLM-callable tools (CallMcpTool, FetchMcpResource)
// and hooks session_start (load registry, inject context, init server
// manager + lifecycle) and session_shutdown (flush + close).
//
// Implements REQ-001..008 of openspec/specs/mcp-bridge/spec.md.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import type { McpBridgeState } from "./state.ts";
import { loadBridgeSettings } from "./config.ts";
import { loadRegistry } from "./registry/registry-loader.ts";
import { buildContextBlock, replaceOrAppendMcpBlock } from "./context-injector.ts";
import { executeCallMcpTool } from "./call-mcp-tool.ts";
import { executeFetchMcpResource } from "./fetch-mcp-resource.ts";
import { executeListMcpResources } from "./list-mcp-resources.ts";
import { renderWrapperToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
import { McpServerManager } from "./server-manager.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import { ConsentManager } from "./consent-manager.ts";
import { UiResourceHandler } from "./ui-resource-handler.ts";
import { startUiServer, type UiServerHandle } from "./ui-server.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { logger } from "./logger.ts";
import { doSync, doValidate, doAdd, doList, doRemove } from "./registry-commands.ts";
import { parseSyncArgs, parseAddArgs } from "./slash-parser.ts";
import {
  refreshStatusBar,
  clearStatusBar,
  renderListTable,
  renderStatusLine,
  formatStatusLine,
  updateContextStats,
  STATUS_KEY,
} from "./status-bar.ts";
import {
  upsertMcpServersConfigEntry,
  removeMcpServersConfigEntry,
  getMcpServersConfigPaths,
} from "./mcp-servers-config.ts";
import { reconcileAndAutoSync } from "./reconcile-and-sync.ts";
import { metaToServerEntry } from "./registry/registry-types.ts";
import type { Registry } from "./registry/registry-types.ts";
import type { ToolMetadata } from "./types.ts";

function buildToolMetadata(registry: Registry): Map<string, ToolMetadata[]> {
  const toolMetadata = new Map<string, ToolMetadata[]>();
  for (const server of registry.servers.values()) {
    const metadata: ToolMetadata[] = [];
    for (const def of server.tools.values()) {
      metadata.push({
        name: def.name,
        originalName: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        uiResourceUri: def.ui?.resourceUri ?? undefined,
        uiStreamMode: def.ui?.streamMode ?? undefined,
      });
    }
    toolMetadata.set(server.name, metadata);
  }
  return toolMetadata;
}

function registerLifecycleServers(lifecycle: McpLifecycleManager, registry: Registry): void {
  lifecycle.clearServers();
  for (const server of registry.servers.values()) {
    const entry = metaToServerEntry(server.meta);
    lifecycle.registerServer(server.name, entry, {
      idleTimeout: server.meta.lifecycle?.idleTimeoutMinutes,
    });
    if (server.meta.lifecycle?.mode === "keep-alive") {
      lifecycle.markKeepAlive(server.name, entry);
    }
  }
}

export default function mcpBridge(pi: ExtensionAPI) {
  let state: McpBridgeState | null = null;
  let initPromise: Promise<McpBridgeState> | null = null;
  let lifecycleGeneration = 0;
  /** Generation last written into the system prompt via `before_agent_start`. */
  let lastInjectedGeneration = -1;

  async function shutdownState(current: McpBridgeState | null, reason: string): Promise<void> {
    if (!current) return;
    if (current.uiServer) {
      current.uiServer.close(reason);
    }
    try {
      await current.lifecycle.gracefulShutdown();
    } catch (error) {
      logger.error(`graceful shutdown failed (${reason})`, error instanceof Error ? error : undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    try {
      await shutdownState(previousState, "session_restart");
    } catch (error) {
      logger.error("failed to shut down previous session state", error instanceof Error ? error : undefined);
    }

    if (generation !== lifecycleGeneration) return;

    // Load settings + registry (read-only, never throws).
    const settings = loadBridgeSettings();
    let registry = loadRegistry();

    // Wire up the server manager + lifecycle early so tools are not stuck on
    // `not_initialized` while mcp-servers.json auto-sync runs.
    const manager = new McpServerManager(process.cwd());
    manager.setDefaultRequestTimeoutMs(settings.requestTimeoutMs || undefined);
    const lifecycle = new McpLifecycleManager(manager);
    lifecycle.setGlobalIdleTimeout(settings.idleTimeout ?? 10);
    lifecycle.startHealthChecks();
    registerLifecycleServers(lifecycle, registry);

    const consentManager = new ConsentManager("once-per-server");
    const uiResourceHandler = new UiResourceHandler(manager);
    let uiServer: UiServerHandle | null = null;
    try {
      uiServer = await startUiServer({ manager, consentManager });
    } catch (error) {
      logger.warn(
        `UI server did not start (UI integration disabled): ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const nextState: McpBridgeState = {
      manager,
      lifecycle,
      toolMetadata: buildToolMetadata(registry),
      registry,
      registryGeneration: 1,
      contextStats: null,
      settings,
      failureTracker: new Map(),
      uiResourceHandler,
      consentManager,
      uiServer,
      completedUiSessions: [],
      openBrowser: async (url: string) => {
        const open = (await import("open")).default;
        await open(url);
      },
      ui: ctx.ui,
    };

    state = nextState;
    initPromise = Promise.resolve(nextState);
    lastInjectedGeneration = -1;
    refreshStatusBar(nextState);

    // Reconcile mcp-servers.json + auto-sync added/updated/zero-tool servers.
    // State is already live; refresh registry when sync finishes.
    if (generation === lifecycleGeneration) {
      const synced = await reconcileAndAutoSync({
        sync: (name) => doSync(name, undefined, [], {}),
      });
      if (generation !== lifecycleGeneration || state !== nextState) return;
      registry = synced.registry;
      nextState.registry = registry;
      nextState.toolMetadata = buildToolMetadata(registry);
      nextState.registryGeneration += 1;
      registerLifecycleServers(lifecycle, registry);
      refreshStatusBar(nextState);
    }

    logger.info(
      `session_start: ${registry.servers.size} servers, ${[...registry.servers.values()].reduce((n, s) => n + s.tools.size, 0)} tools`,
    );
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const current = state;
    state = null;
    initPromise = null;
    lastInjectedGeneration = -1;
    clearStatusBar(current);
    try {
      await shutdownState(current, "session_shutdown");
    } catch (error) {
      logger.error("session shutdown cleanup failed", error instanceof Error ? error : undefined);
    }
  });

  // Re-flag returned MCP tool failures so Pi registers them as errors.
  pi.on("tool_result", event => toolErrorOverride(event.details));

  // --- Context injection (REQ-C-001..006) --------------------------------
  // Cursor-style: append/replace the compact MCP registry index on the
  // SYSTEM PROMPT via `before_agent_start`. When the registry generation
  // changes (reload/sync), replace the previous header…footer span so the
  // model does not keep a stale index for the rest of the session.
  pi.on("before_agent_start", (event, _ctx) => {
    if (!state) return;
    const existing = event.systemPrompt ?? "";
    if (lastInjectedGeneration === state.registryGeneration && existing.includes("## MCP servers (via pi-mcp-bridge)")) {
      return;
    }

    let block: string;
    try {
      const result = buildContextBlock(state.registry, state.settings);
      block = result.block;
      const stats = updateContextStats(state);
      if (state.ui?.setStatus) {
        state.ui.setStatus(STATUS_KEY, formatStatusLine(state, state.ui.theme as { fg: (n: string, t: string) => string }));
      }
      if (result.truncated) logger.warn("context injection was truncated to fit the budget");
      else if (result.schemasIncluded) logger.info("context injection: full schemas included");
      else logger.info("context injection: descriptions only (model will read schema files on demand)");
      logger.info(
        `context injection size: ~${stats.estimatedTokens}/${stats.budgetTokens} tokens (${stats.percentOfBudget}%)` +
          (stats.tokensSaved > 0
            ? `; saved ~${stats.tokensSaved} vs full schemas (${stats.percentSaved}%)`
            : ""),
      );
    } catch (error) {
      logger.error("context injection failed", error instanceof Error ? error : undefined);
      return;
    }

    lastInjectedGeneration = state.registryGeneration;
    return { systemPrompt: replaceOrAppendMcpBlock(existing, block) };
  });

  // --- Register CallMcpTool (REQ-W-001..008) -----------------------------
  (pi.registerTool as (tool: unknown) => unknown)({
    name: "CallMcpTool",
    label: "MCP: Call tool",
    description:
      "Call an MCP tool by server identifier and tool name with arbitrary JSON arguments. " +
      "Prefer the inputSchema already inlined in the MCP servers system-prompt block when present. " +
      "Otherwise read the absolute tool descriptor at the `folder:` path shown for that server " +
      "(`<folder>/tools/<toolName>.json`). Do NOT use relative paths like `registry/<server>/...` — " +
      "they resolve against the agent cwd and miss the real registry. The `arguments` object must match the tool's inputSchema.",
    promptSnippet: "Call any MCP tool by server + toolName + arguments",
    parameters: Type.Object({
      server: Type.String({ description: "Identifier of the MCP server hosting the tool." }),
      toolName: Type.String({ description: "Name of the MCP tool to invoke (registry key, slug, or original MCP name)." }),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description: "Arguments to pass to the MCP tool, as described in the tool descriptor.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: { server: string; toolName: string; arguments?: Record<string, unknown> }, signal?: AbortSignal) {
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "pi-mcp-bridge not initialized." }],
          details: { mode: "call", error: "not_initialized" },
        };
      }
      return executeCallMcpTool(state, params, signal);
    },
    renderCall(args: { server: string; toolName: string; arguments?: Record<string, unknown> }, theme: unknown) {
      return renderWrapperToolCall(
        {
          displayTitle: `CallMcpTool → ${args.toolName} @ ${args.server}`,
          argsJson: args.arguments ? JSON.stringify(args.arguments) : undefined,
        },
        theme as never,
      );
    },
    renderResult(result: { details?: { error?: unknown } }, options: never, theme: unknown) {
      return renderMcpToolResult(result as never, options, theme as never, {
        isError: Boolean(result.details?.error),
      });
    },
  });

  // --- Register FetchMcpResource (REQ-W-009..014) -----------------------
  (pi.registerTool as (tool: unknown) => unknown)({
    name: "FetchMcpResource",
    label: "MCP: Fetch resource",
    description:
      "Read a specific resource from an MCP server, identified by server name and resource URI. " +
      "Optionally set downloadPath (relative to the workspace) to save the resource to disk; " +
      "when set, the resource is written to disk and is NOT returned to the model.",
    promptSnippet: "Read any MCP resource by server + uri (+ optional downloadPath)",
    parameters: Type.Object({
      server: Type.String({ description: "The MCP server identifier" }),
      uri: Type.String({ description: "The resource URI to read" }),
      downloadPath: Type.Optional(
        Type.String({
          description:
            "Optional relative path in the workspace to save the resource to. When set, the resource is written to disk and is not returned to the model.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { server: string; uri: string; downloadPath?: string },
      signal?: AbortSignal,
    ) {
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "pi-mcp-bridge not initialized." }],
          details: { mode: "fetch", error: "not_initialized" },
        };
      }
      return executeFetchMcpResource(state, params, signal);
    },
    renderCall(args: { server: string; uri: string; downloadPath?: string }, theme: unknown) {
      return renderWrapperToolCall(
        {
          displayTitle: `FetchMcpResource → ${args.uri} @ ${args.server}`,
          argsJson: args.downloadPath ? JSON.stringify({ downloadPath: args.downloadPath }) : undefined,
        },
        theme as never,
      );
    },
    renderResult(result: { details?: { error?: unknown } }, options: never, theme: unknown) {
      return renderMcpToolResult(result as never, options, theme as never, {
        isError: Boolean(result.details?.error),
      });
    },
  });

  // --- Register ListMcpResources (Cursor parity) -------------------------
  (pi.registerTool as (tool: unknown) => unknown)({
    name: "ListMcpResources",
    label: "MCP: List resources",
    description:
      "List the resources exposed by an MCP server, identified by server name. " +
      "Returns each resource's URI, name, description, and mimeType. Use this to " +
      "discover what resources are available before calling FetchMcpResource.",
    promptSnippet: "List available MCP resources by server",
    parameters: Type.Object({
      server: Type.String({ description: "The MCP server identifier" }),
    }),
    async execute(_toolCallId: string, params: { server: string }, signal?: AbortSignal) {
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "pi-mcp-bridge not initialized." }],
          details: { mode: "list-resources", error: "not_initialized" },
        };
      }
      return executeListMcpResources(state, params, signal);
    },
    renderCall(args: { server: string }, theme: unknown) {
      return renderWrapperToolCall({ displayTitle: `ListMcpResources → list @ ${args.server}` }, theme as never);
    },
    renderResult(result: { details?: { error?: unknown } }, options: never, theme: unknown) {
      return renderMcpToolResult(result as never, options, theme as never, {
        isError: Boolean(result.details?.error),
      });
    },
  });

  // --- /mcp-bridge slash command (primary registry management) ----------
  pi.registerCommand("mcp-bridge", {
    description: "Manage the pi-mcp-bridge registry (sync / validate / add / remove / list / status / reload / approve / revoke)",
    handler: async (args, ctx) => {
      const input = (args ?? "").trim();
      const parts = input.split(/\s+/);
      const subcommand = parts[0] ?? "";
      const rest = input.slice(subcommand.length).trim();
      const notify = (msg: string, level: "info" | "error" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(msg, level);
        else console.log(msg);
      };

      // Shared sync-with-progress helper used by both the `sync` subcommand
      // and the auto-sync chained after `add`. Drives the footer spinner,
      // runs doSync, reloads the registry, and refreshes the status bar.
      // Returns the SyncResult so callers can branch on ok/skipped/error.
      const runSync = async (
        serverName: string,
        command: string | undefined,
        commandArgs: string[],
        env: Record<string, string> | undefined,
        force: boolean,
      ) => {
        const theme = ctx.hasUI ? (ctx.ui.theme as { fg: (n: string, t: string) => string }) : null;
        const spinFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinIdx = 0;
        let spinTimer: ReturnType<typeof setInterval> | null = null;
        let currentStep = "starting…";
        const paint = () => {
          if (!ctx.hasUI || !theme) return;
          const spinner = theme.fg("accent", spinFrames[spinIdx % spinFrames.length]!);
          ctx.ui.setStatus(STATUS_KEY, `${spinner} ${theme.fg("dim", `Syncing "${serverName}": ${currentStep}`)}`);
        };
        if (ctx.hasUI) {
          paint();
          spinTimer = setInterval(() => { spinIdx++; paint(); }, 80);
        } else {
          notify(`Syncing "${serverName}" (connecting to live server)...`);
        }
        const result = await doSync(serverName, command, commandArgs, {
          force,
          env,
          onProgress: (step) => { currentStep = step; paint(); },
        });
        if (spinTimer) clearInterval(spinTimer);
        if (!result.ok || result.skipped) {
          if (state) refreshStatusBar(state);
          return result;
        }
        // Auto-reload so the new tools are visible to the model immediately.
        if (state) {
          const registry = loadRegistry();
          state.registry = registry;
          state.toolMetadata = buildToolMetadata(registry);
          state.registryGeneration += 1;
          registerLifecycleServers(state.lifecycle, registry);
          lastInjectedGeneration = -1;
          refreshStatusBar(state);
          const total = [...registry.servers.values()].reduce((n, s) => n + s.tools.size, 0);
          notify(`MCP registry reloaded: ${registry.servers.size} servers, ${total} tools. Next turn will use the updated context.`);
        }
        return result;
      };

      switch (subcommand) {
        case "sync": {
          const parsed = parseSyncArgs(rest);
          if ("error" in parsed) {
            notify(parsed.error, "error");
            return;
          }
          const result = await runSync(
            parsed.serverName,
            parsed.command,
            parsed.commandArgs,
            Object.keys(parsed.env).length > 0 ? parsed.env : undefined,
            parsed.force,
          );
          if (!result.ok) {
            notify(`Sync failed: ${result.error}`, "error");
            return;
          }
          if (result.skipped) {
            notify(`Skipped "${result.serverName}": ${result.skipped}`);
            return;
          }
          notify(
            `Synced "${result.serverName}": ${result.toolsWritten} tools written, ${result.toolsRemoved} removed, ${result.resourcesIndexed} resources indexed.`,
          );
          return;
        }

        case "validate": {
          const result = doValidate();
          if (result.ok) {
            notify("Registry is valid.");
            return;
          }
          notify(`Registry has ${result.issues.length} issue(s):`, "error");
          for (const issue of result.issues) {
            notify(`  ${issue.server}/${issue.file}: ${issue.message}`, "error");
          }
          return;
        }

        case "add": {
          const parsed = parseAddArgs(rest);
          if ("error" in parsed) {
            notify(parsed.error, "error");
            return;
          }
          const result = doAdd(parsed.serverName, {
            command: parsed.command,
            args: parsed.commandArgs,
            url: parsed.url,
            description: parsed.description,
            env: Object.keys(parsed.env).length > 0 ? parsed.env : undefined,
          });
          if (!result.ok) {
            notify(`Add failed: ${result.error}`, "error");
            return;
          }
          // If the user has adopted the OpenCode-style `mcp-servers.json`
          // workflow (file exists), keep it as the source of truth by
          // upserting this entry there too (OpenCode shape). No-op if the
          // file is absent (meta.json-only flow).
          const configPaths = getMcpServersConfigPaths();
          if (existsSync(configPaths.global) || existsSync(configPaths.project)) {
            const scope = existsSync(configPaths.project) ? "project" : "global";
            try {
              const entry = parsed.url
                ? {
                    type: "remote" as const,
                    url: parsed.url,
                    description: parsed.description,
                    enabled: true,
                  }
                : {
                    type: "local" as const,
                    command: [parsed.command!, ...(parsed.commandArgs ?? [])],
                    environment: Object.keys(parsed.env).length > 0 ? parsed.env : undefined,
                    description: parsed.description,
                    enabled: true,
                  };
              const writtenTo = upsertMcpServersConfigEntry(parsed.serverName, entry, scope);
              notify(`Also upserted "${parsed.serverName}" into ${writtenTo}.`);
            } catch (error) {
              notify(`Could not upsert into mcp-servers.json: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          }
          // Auto-sync: `add` only writes a meta.json stub. Without sync the
          // server shows up in the registry with 0 tools — a footgun where
          // CallMcpTool can't find any tools and ListMcpResources may even
          // fail to connect. Chain straight into sync so the user gets a
          // fully-populated server in one step.
          notify(`Added "${result.serverName}" → ${result.metaPath}. Auto-syncing tools…`);
          const env = Object.keys(parsed.env).length > 0 ? parsed.env : undefined;
          const syncResult = await runSync(
            parsed.serverName,
            parsed.command,
            parsed.commandArgs,
            env,
            false,
          );
          if (!syncResult.ok) {
            notify(`Added "${result.serverName}" but auto-sync failed: ${syncResult.error}. Run \`/mcp-bridge sync ${parsed.serverName} -- <command>\` to retry.`, "error");
            return;
          }
          if (syncResult.skipped) {
            notify(`Added "${result.serverName}" (sync skipped: ${syncResult.skipped}). Run \`/mcp-bridge sync ${parsed.serverName}\` to populate tools.`);
            return;
          }
          notify(
            `Added + synced "${result.serverName}": ${syncResult.toolsWritten} tools, ${syncResult.resourcesIndexed} resources indexed. Ready to call.`,
          );
          return;
        }

        case "list": {
          const entries = doList();
          if (ctx.hasUI) {
            ctx.ui.notify(renderListTable(entries, ctx.ui.theme as never), "info");
          } else {
            // Plain-text fallback for non-TUI modes.
            if (entries.length === 0) {
              notify("(no servers in registry). Run /mcp-bridge add <server> -- <command> to add one.");
              return;
            }
            const lines: string[] = [];
            for (const e of entries) {
              const desc = e.description ? ` — ${e.description}` : "";
              lines.push(`${e.name} [${e.transportKind}] (${e.toolCount} tools, ${e.syncedFrom ?? "manual"})${desc}`);
              for (const t of e.tools) lines.push(`  - ${t}`);
            }
            notify(lines.join("\n"));
          }
          return;
        }

        case "remove":
        case "rm":
        case "delete": {
          if (!state) {
            notify("pi-mcp-bridge not initialized", "error");
            return;
          }
          const tokens = rest.trim().split(/\s+/).filter(Boolean);
          const keepConfig = tokens.includes("--keep-config");
          const serverName = tokens.find((t) => !t.startsWith("--"));
          if (!serverName) {
            notify("Usage: /mcp-bridge remove <server> [--keep-config]", "error");
            return;
          }
          // Drop live connection first so we don't leave a dangling process.
          try {
            await state.manager.close(serverName);
          } catch (error) {
            logger.warn(
              `close before remove "${serverName}" failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const result = doRemove(serverName);
          if (!result.ok) {
            notify(`Remove failed: ${result.error}`, "error");
            return;
          }
          let configNote = "";
          if (!keepConfig) {
            const rewritten = removeMcpServersConfigEntry(serverName);
            if (rewritten.length > 0) {
              configNote = ` Also removed from: ${rewritten.join(", ")}.`;
            }
          } else {
            configNote = " Left mcp-servers.json unchanged (--keep-config).";
          }
          const registry = loadRegistry();
          state.registry = registry;
          state.toolMetadata = buildToolMetadata(registry);
          state.registryGeneration += 1;
          registerLifecycleServers(state.lifecycle, registry);
          lastInjectedGeneration = -1;
          refreshStatusBar(state);
          const total = [...registry.servers.values()].reduce((n, s) => n + s.tools.size, 0);
          if (result.missingRegistry) {
            notify(
              `No registry directory for "${serverName}"${configNote} Registry now: ${registry.servers.size} servers, ${total} tools.`,
            );
          } else {
            notify(
              `Removed "${serverName}" (${result.removedDir}).${configNote} Registry now: ${registry.servers.size} servers, ${total} tools. Next turn will use the updated context.`,
            );
          }
          return;
        }

        case "reload": {
          if (!state) {
            notify("pi-mcp-bridge not initialized", "error");
            return;
          }
          const previousCount = state.registry.servers.size;
          const synced = await reconcileAndAutoSync({
            notify,
            sync: (name) => runSync(name, undefined, [], undefined, false),
          });
          state.registry = synced.registry;
          state.toolMetadata = buildToolMetadata(synced.registry);
          state.registryGeneration += 1;
          registerLifecycleServers(state.lifecycle, synced.registry);
          lastInjectedGeneration = -1;
          refreshStatusBar(state);
          const newCount = synced.registry.servers.size;
          const total = [...synced.registry.servers.values()].reduce((n, s) => n + s.tools.size, 0);
          notify(
            `MCP registry reloaded: ${newCount} servers, ${total} tools${newCount !== previousCount ? ` (was ${previousCount})` : ""}. Next turn will use the updated context.`,
          );
          return;
        }

        case "status":
        case "":
        default: {
          if (!state) {
            notify("pi-mcp-bridge not initialized", "error");
            return;
          }
          if (ctx.hasUI) {
            ctx.ui.notify(renderStatusLine(state, ctx.ui.theme as never), "info");
          } else {
            const total = [...state.registry.servers.values()].reduce((n, s) => n + s.tools.size, 0);
            notify(`pi-mcp-bridge: ${state.registry.servers.size} servers, ${total} tools`);
          }
          notify(
            "Note: after `pi update --extensions`, restart Pi so new extension code loads. `/mcp-bridge reload` only reloads the registry + mcp-servers.json.",
            "info",
          );
          return;
        }

        case "approve": {
          if (!state) {
            notify("pi-mcp-bridge not initialized", "error");
            return;
          }
          const serverName = rest.trim();
          if (!serverName) {
            notify("Usage: /mcp-bridge approve <server>", "error");
            return;
          }
          if (!state.registry.servers.has(serverName)) {
            notify(`Server "${serverName}" not found in registry.`, "error");
            return;
          }
          state.consentManager.registerDecision(serverName, true);
          notify(`Approved "${serverName}". Future CallMcpTool calls will go through.`);
          return;
        }

        case "revoke": {
          if (!state) {
            notify("pi-mcp-bridge not initialized", "error");
            return;
          }
          const serverName = rest.trim();
          if (!serverName) {
            notify("Usage: /mcp-bridge revoke <server>", "error");
            return;
          }
          state.consentManager.registerDecision(serverName, false);
          notify(`Revoked consent for "${serverName}". Future CallMcpTool calls will be blocked until re-approved.`);
          return;
        }
      }
    },
  });
}
