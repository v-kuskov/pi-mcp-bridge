// ui-server.ts - Local HTTP server hosting MCP UI iframes.
//
// Ported from pi-mcp-adapter (simplified for Phase 1). Each UI session
// gets a unique token; the host HTML page at `/s/<token>` is served from
// `host-html-template.ts`. The iframe inside that page calls back into
// the server's `/proxy/*` endpoints to forward tool calls, messages,
// and context updates to the bridge.
//
// The server also serves the vendored `app-bridge.bundle.js` so the
// iframe can load the MCP SDK + Zod without a CDN.
//
// Results are pushed to the open UI over Server-Sent Events: the bridge
// calls `handle.pushResult` / `handle.pushCancelled` (from ui-session.ts)
// and the host page's EventSource delivers them into the iframe.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerManager } from "./server-manager.ts";
import type { ConsentManager } from "./consent-manager.ts";
import type { SendMessageFn } from "./state.ts";
import { extractUiPromptText, type UiMessageParams, type UiSessionMessages } from "./types.ts";
import { logger } from "./logger.ts";

/** Per-session control handle returned by `registerSession`. */
export interface UiSessionHandle {
  /** Push an MCP CallToolResult to the open UI (delivered via SSE). */
  pushResult: (result: CallToolResult) => void;
  /** Notify the UI that the tool call was cancelled (delivered via SSE). */
  pushCancelled: (reason: string) => void;
  /** Close the session and drop its SSE clients. */
  close: () => void;
  /** Messages accumulated from the UI (prompts/notifications/intents). */
  getMessages: () => UiSessionMessages;
}

/** Registration payload for a UI session (see ui-session.ts). */
export interface UiSessionRegistration {
  token: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  html: string;
  onMessage?: (msg: Record<string, unknown>) => void;
  onDone?: () => void;
  onCancel?: () => void;
}

export interface UiServerHandle {
  port: number;
  baseUrl: string;
  close: (reason?: string) => void;
  /** Register a UI session; returns a handle for pushing results and reading messages. */
  registerSession: (session: UiSessionRegistration) => UiSessionHandle;
}

interface SessionState {
  token: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  html: string;
  consentManager: ConsentManager;
  onMessage: (msg: Record<string, unknown>) => void;
  onDone: () => void;
  onCancel: () => void;
  messages: UiSessionMessages;
  sseClients: Set<ServerResponse>;
}

const APP_BRIDGE_PATH = "/app-bridge.bundle.js";

export async function startUiServer(options: {
  manager: McpServerManager;
  consentManager: ConsentManager;
  onMessage?: SendMessageFn;
  port?: number;
}): Promise<UiServerHandle> {
  const sessions = new Map<string, SessionState>();
  const server = createServer((req, res) => handleRequest(req, res, sessions, options.manager));

  // `listen()` is asynchronous: the port is only known once the server is
  // actually listening. Previously this read `server.address()` synchronously
  // right after `listen()`, which returned null and crashed every startup.
  const port = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const actualPort = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;
  logger.info(`UI server listening on ${baseUrl}`);

  return {
    port: actualPort,
    baseUrl,
    registerSession: (registration: UiSessionRegistration): UiSessionHandle => {
      const session: SessionState = {
        token: registration.token,
        serverName: registration.serverName,
        toolName: registration.toolName,
        toolArgs: registration.toolArgs,
        html: registration.html,
        consentManager: options.consentManager,
        onMessage: registration.onMessage ?? (() => {}),
        onDone: registration.onDone ?? (() => {}),
        onCancel: registration.onCancel ?? (() => {}),
        messages: { prompts: [], notifications: [], intents: [] },
        sseClients: new Set(),
      };
      sessions.set(registration.token, session);
      logger.info(
        `UI session registered: ${registration.serverName}/${registration.toolName} (${registration.token})`,
      );
      return {
        pushResult: (result) =>
          pushSessionEvent(session, "tool-result", {
            serverName: session.serverName,
            toolName: session.toolName,
            result,
          }),
        pushCancelled: (reason) =>
          pushSessionEvent(session, "tool-cancelled", {
            serverName: session.serverName,
            toolName: session.toolName,
            reason,
          }),
        close: () => removeSession(sessions, registration.token),
        getMessages: () => session.messages,
      };
    },
    close: (reason) => {
      logger.info(`UI server closing (${reason ?? "shutdown"})`);
      for (const session of sessions.values()) {
        for (const client of session.sseClients) client.end();
        session.sseClients.clear();
      }
      sessions.clear();
      server.close();
    },
  };
}

function pushSessionEvent(session: SessionState, event: string, data: unknown): void {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of session.sseClients) {
    client.write(chunk);
  }
}

/** Remove a session: stop serving `/s/<token>`, end its SSE streams. */
function removeSession(sessions: Map<string, SessionState>, token: string): void {
  const session = sessions.get(token);
  if (!session) return;
  sessions.delete(token);
  for (const client of session.sseClients) client.end();
  session.sseClients.clear();
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, SessionState>,
  manager: McpServerManager,
): void {
  const url = req.url ?? "/";
  if (req.method === "GET" && url === APP_BRIDGE_PATH) {
    serveAppBridge(res);
    return;
  }
  if (req.method === "GET" && url.startsWith("/s/")) {
    const token = url.slice("/s/".length);
    const session = sessions.get(token);
    if (!session) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("session not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(session.html);
    return;
  }
  if (req.method === "GET" && url.startsWith("/events")) {
    const parsed = new URL(url, "http://localhost");
    handleEvents(req, res, sessions, parsed.searchParams.get("session"));
    return;
  }
  if (req.method === "POST" && url.startsWith("/proxy/")) {
    handleProxy(req, res, sessions, manager, url.slice("/proxy/".length));
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

/** Server-Sent Events stream: delivers pushed tool results to the host page. */
function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, SessionState>,
  token: string | null,
): void {
  if (!token || !sessions.has(token)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("session not found");
    return;
  }
  const session = sessions.get(token)!;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Initial comment flushes headers and keeps the connection alive.
  res.write(": connected\n\n");
  session.sseClients.add(res);
  const drop = (): void => {
    session.sseClients.delete(res);
  };
  req.on("close", drop);
  req.on("error", drop);
}

function serveAppBridge(res: ServerResponse): void {
  const path = resolveAppBridgePath();
  if (!path || !existsSync(path)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("app-bridge.bundle.js not found");
    return;
  }
  const body = readFileSync(path);
  res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
  res.end(body);
}

function resolveAppBridgePath(): string {
  // Same directory as this module (the bundled file lives next to the
  // compiled output).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "app-bridge.bundle.js");
  } catch {
    return join(process.cwd(), "app-bridge.bundle.js");
  }
}

async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, SessionState>,
  manager: McpServerManager,
  endpoint: string,
): Promise<void> {
  const body = await readJsonBody(req);
  const token = (body as { token?: string })?.token;
  const params = (body as { params?: Record<string, unknown> })?.params ?? {};
  if (!token || !sessions.has(token)) {
    sendJson(res, 400, { ok: false, error: "invalid or missing token" });
    return;
  }
  const session = sessions.get(token)!;

  try {
    switch (endpoint) {
      case "ui/consent": {
        const approved = params.approved === true;
        session.consentManager.registerDecision(session.serverName, approved);
        sendJson(res, 200, { ok: true, result: { approved } });
        return;
      }
      case "ui/message": {
        accumulateMessage(session.messages, params);
        session.onMessage(params);
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }
      case "ui/context":
      case "ui/download-file":
      case "ui/open-link":
      case "ui/request-display-mode": {
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }
      case "ui/done": {
        session.onDone();
        removeSession(sessions, token);
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }
      case "ui/cancel": {
        session.onCancel();
        removeSession(sessions, token);
        sendJson(res, 200, { ok: true, result: {} });
        return;
      }
      case "tools/call": {
        const name = (params as { name?: string }).name;
        const args = (params as { arguments?: Record<string, unknown> }).arguments ?? {};
        if (!name) {
          sendJson(res, 400, { ok: false, error: "missing tool name" });
          return;
        }
        try {
          const result = await manager.callTool(session.serverName, {
            name,
            arguments: args,
          });
          sendJson(res, 200, { ok: true, result });
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      default:
        sendJson(res, 404, { ok: false, error: `unknown endpoint: ${endpoint}` });
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Accumulate UI messages into the session's structured message log. */
function accumulateMessage(messages: UiSessionMessages, msg: Record<string, unknown>): void {
  const type = msg?.type;
  if (type === "prompt") {
    const text = extractUiPromptText(msg as UiMessageParams) ?? JSON.stringify(msg);
    messages.prompts.push(text);
    return;
  }
  if (type === "notify" || type === "notification") {
    const text = typeof msg.message === "string" ? msg.message : JSON.stringify(msg);
    messages.notifications.push(text);
    return;
  }
  if (type === "intent") {
    messages.intents.push({
      intent: typeof msg.intent === "string" ? msg.intent : "unknown",
      params: (msg.params as Record<string, unknown> | undefined) ?? {},
    });
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise(resolve => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
