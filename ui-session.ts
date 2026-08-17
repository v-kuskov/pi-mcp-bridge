// ui-session.ts - Per-tool UI session lifecycle.
//
// Ported from pi-mcp-adapter (simplified for Phase 1). When CallMcpTool
// targets a tool whose registry descriptor declares `ui.resourceUri`,
// the bridge:
//   1. Fetches the UI HTML from the MCP server (via UiResourceHandler).
//   2. Builds the host HTML page (via host-html-template.ts).
//   3. Registers a session with the local UI server (ui-server.ts).
//   4. Opens the resulting URL in the browser or a Glimpse native window.
//   5. Forwards the MCP CallToolResult to the iframe once it arrives.
//   6. Collects messages from the iframe and stores them on
//      `state.completedUiSessions` when the session closes.
//
// If the same tool is called again while its UI is still open, the
// bridge reuses the session and pushes the new result to the existing
// iframe (live updates).

import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpBridgeState } from "./state.ts";
import type { UiStreamMode } from "./types.ts";
import type { UiSessionHandle } from "./ui-server.ts";
import { buildHostHtmlTemplate } from "./host-html-template.ts";
import { isGlimpseAvailable, openGlimpseWindow } from "./glimpse-ui.ts";
import { logger } from "./logger.ts";
import { extractUiPromptText, type UiMessageParams, type UiSessionMessages } from "./types.ts";

export interface UiSessionRuntime {
  /** Whether this session reused an already-open UI window. */
  reused: boolean;
  /** Send the MCP CallToolResult to the iframe. */
  sendToolResult: (result: CallToolResult) => void;
  /** Notify the iframe that the tool call was cancelled. */
  sendToolCancelled: (reason: string) => void;
  /** Close the UI window. */
  close: () => void;
  /** The request `_meta` to attach to the MCP `tools/call` request. */
  requestMeta: Record<string, unknown> | undefined;
}

interface ActiveSession {
  token: string;
  serverName: string;
  toolName: string;
  messages: UiSessionMessages;
  startedAt: Date;
  closeWindow: () => void;
  pushResult: (result: CallToolResult) => void;
  /** Guard against double-finalize (e.g. Done then window close). */
  finalized: boolean;
}

export async function maybeStartUiSession(
  state: McpBridgeState,
  params: {
    serverName: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    uiResourceUri: string;
    streamMode?: UiStreamMode;
  },
): Promise<UiSessionRuntime | null> {
  if (!state.uiResourceHandler || !state.uiServer || !state.consentManager) {
    return null;
  }

  // Reuse an existing open session for the same server+tool.
  const existing = findActiveSession(state, params.serverName, params.toolName);
  if (existing) {
    return {
      reused: true,
      sendToolResult: (result) => existing.pushResult(result),
      sendToolCancelled: () => existing.pushResult({ isError: true, content: [{ type: "text", text: "Cancelled" }] }),
      close: () => {},
      requestMeta: undefined,
    };
  }

  // Fetch the UI HTML.
  let resource;
  try {
    resource = await state.uiResourceHandler.readUiResource(params.serverName, params.uiResourceUri);
  } catch (error) {
    logger.warn(
      `Failed to load UI resource ${params.uiResourceUri}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  // Build the host HTML.
  const token = randomBytes(16).toString("hex");
  const requireConsent = state.consentManager.requiresPrompt(params.serverName);
  const cacheConsent = state.consentManager.shouldCacheConsent();
  const html = buildHostHtmlTemplate({
    sessionToken: token,
    serverName: params.serverName,
    toolName: params.toolName,
    toolArgs: params.toolArgs,
    resource,
    allowAttribute: "allow-scripts allow-forms allow-popups allow-same-origin",
    requireToolConsent: requireConsent,
    cacheToolConsent: cacheConsent,
  });

  // Register the session with the local UI server. This serves `/s/<token>`,
  // receives the iframe's `/proxy/*` callbacks, and streams pushed results
  // to the host page over SSE.
  const messages: UiSessionMessages = { prompts: [], notifications: [], intents: [] };
  const session: ActiveSession = {
    token,
    serverName: params.serverName,
    toolName: params.toolName,
    messages,
    startedAt: new Date(),
    closeWindow: () => {},
    pushResult: () => {},
    finalized: false,
  };

  let sessionHandle: UiSessionHandle | null = null;
  try {
    sessionHandle = state.uiServer.registerSession({
      token,
      serverName: params.serverName,
      toolName: params.toolName,
      toolArgs: params.toolArgs,
      html,
      onMessage: (msg) => forwardUiMessage(state, msg),
      onDone: () =>
        finalizeSession(state, session, "done", sessionHandle?.getMessages() ?? session.messages),
      onCancel: () =>
        finalizeSession(state, session, "cancelled", sessionHandle?.getMessages() ?? session.messages),
    });
  } catch (error) {
    logger.warn(
      `Failed to register UI session: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  session.closeWindow = () => sessionHandle!.close();
  session.pushResult = (result) => sessionHandle!.pushResult(result);

  // Open the URL.
  const url = `${state.uiServer.baseUrl}/s/${token}`;
  const viewer = state.settings.uiViewer ?? "auto";
  const useGlimpse = viewer === "glimpse" || (viewer === "auto" && isGlimpseAvailable());
  if (useGlimpse) {
    try {
      const win = await openGlimpseWindow(html, {
        title: `MCP UI — ${params.serverName} / ${params.toolName}`,
        onClosed: () =>
          finalizeSession(state, session, "closed", sessionHandle?.getMessages() ?? session.messages),
      });
      session.closeWindow = () => win.close();
    } catch (error) {
      logger.warn(`Glimpse open failed, falling back to browser: ${error instanceof Error ? error.message : String(error)}`);
      await state.openBrowser(url);
    }
  } else {
    await state.openBrowser(url);
  }

  return {
    reused: false,
    sendToolResult: (result) => session.pushResult(result),
    sendToolCancelled: (reason) => sessionHandle!.pushCancelled(reason),
    close: () => {
      session.closeWindow();
      finalizeSession(state, session, "closed", sessionHandle?.getMessages() ?? session.messages);
    },
    requestMeta: undefined,
  };
}

function findActiveSession(
  state: McpBridgeState,
  serverName: string,
  toolName: string,
): ActiveSession | null {
  // Phase 1 simplified: we do not track long-lived sessions across calls.
  // Reuse is handled by the caller via the registry's UI session map.
  // A full implementation would maintain a `Map<string, ActiveSession>`
  // on `state` keyed by `${serverName}/${toolName}`.
  return null;
}

function finalizeSession(
  state: McpBridgeState,
  session: ActiveSession,
  reason: string,
  messages?: UiSessionMessages,
): void {
  if (session.finalized) return;
  session.finalized = true;
  state.completedUiSessions.push({
    serverName: session.serverName,
    toolName: session.toolName,
    completedAt: new Date(),
    reason,
    messages: messages ?? session.messages,
  });
}

function forwardUiMessage(
  state: McpBridgeState,
  msg: Record<string, unknown>,
): void {
  // Prompts/intents/notifications from the iframe are forwarded to the host
  // session when a message channel is available. Messages are also
  // accumulated by the UI server and surface via `completedUiSessions`.
  if (!state.sendMessage) return;
  const type = msg?.type;
  if (type === "prompt") {
    const text = extractUiPromptText(msg as UiMessageParams);
    if (text) {
      state.sendMessage(
        { customType: "mcp_ui_prompt", content: [{ type: "text", text }] },
        { triggerTurn: true },
      );
    }
  } else if (type === "intent") {
    const text = `[intent] ${String(msg.intent ?? "unknown")}${
      msg.params ? ` ${JSON.stringify(msg.params)}` : ""
    }`;
    state.sendMessage({ customType: "mcp_ui_intent", content: [{ type: "text", text }] });
  } else if (type === "notify" || type === "notification") {
    const text = typeof msg.message === "string" ? msg.message : JSON.stringify(msg);
    state.sendMessage({ customType: "mcp_ui_notification", content: [{ type: "text", text }] });
  }
}
