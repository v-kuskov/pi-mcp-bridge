/**
 * Custom error types for pi-mcp-bridge operations.
 * Provides structured errors with context and recovery hints.
 */

export interface McpBridgeErrorContext {
  server?: string;
  tool?: string;
  uri?: string;
  [key: string]: unknown;
}

/** Base error class for pi-mcp-bridge errors. */
export class McpBridgeError extends Error {
  readonly code: string;
  readonly context: McpBridgeErrorContext;
  readonly recoveryHint?: string;
  readonly cause?: Error;

  constructor(
    message: string,
    options: {
      code: string;
      context?: McpBridgeErrorContext;
      recoveryHint?: string;
      cause?: Error;
    },
  ) {
    super(message);
    this.name = "McpBridgeError";
    this.code = options.code;
    this.context = options.context ?? {};
    this.recoveryHint = options.recoveryHint;
    this.cause = options.cause;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      context: this.context,
      recoveryHint: this.recoveryHint,
      stack: this.stack,
    };
  }
}

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Build a model-facing failure message with a consistent, actionable shape:
 *
 *   CallMcpTool failed on "my-server"
 *
 *   The MCP server refused the connection.
 *
 *   What to try:
 *     • Check the server is running: /mcp-bridge status
 *     • Retry the call — the bridge reconnects automatically
 *
 * Used by the wrapper tools so every failure reads the same way whether the
 * model sees it or it renders in the TUI.
 */
export function formatToolFailure(options: {
  action: string;
  server: string;
  what: string;
  hints?: string[];
}): string {
  const lines: string[] = [`${options.action} failed on "${options.server}"`, "", options.what];
  if (options.hints && options.hints.length > 0) {
    lines.push("", "What to try:");
    for (const hint of options.hints) lines.push(`  • ${hint}`);
  }
  return lines.join("\n");
}

/** Failure message for an unknown server (shared by all wrapper tools). */
export function serverNotFoundFailure(action: string, server: string): string {
  return formatToolFailure({
    action,
    server,
    what: `No server named "${server}" is registered.`,
    hints: [`Run \`/mcp-bridge add ${server} -- <command>\` to add it.`],
  });
}

/** Failure message for a connection error (shared by all wrapper tools). */
export function connectFailure(action: string, server: string, message: string): string {
  return formatToolFailure({
    action,
    server,
    what: message ? `Could not connect to the MCP server: ${message}` : "Could not connect to the MCP server.",
    hints: [
      "Check the server's command or URL in its meta.json is correct and reachable.",
      "Run `/mcp-bridge status` to see the server's connection state.",
    ],
  });
}

/** Failure message for a server that needs a bearer token (shared by all wrapper tools). */
export function authRequiredFailure(action: string, server: string): string {
  return formatToolFailure({
    action,
    server,
    what: "The server requires a bearer token to authenticate.",
    hints: [
      `Set auth.bearerTokenEnv in registry/${server}/meta.json to the env var holding the token, then restart Pi.`,
    ],
  });
}

/** Build the not-found result shared by all wrapper tools (message + `Available:` listing). */
export function notFoundResult(
  mode: string,
  error: string,
  message: string,
  available: string[],
): AgentToolResult<Record<string, unknown>> {
  const suffix = available.length > 0 ? `\n\nAvailable: ${available.join(", ")}` : "";
  return {
    content: [{ type: "text", text: `${message}${suffix}` }],
    details: { mode, error, available },
  };
}

/** Error related to user consent for tool calls. */
export class ConsentError extends McpBridgeError {
  readonly denied: boolean;

  constructor(
    server: string,
    options: { denied?: boolean; requiresApproval?: boolean },
  ) {
    const message = options.denied
      ? `Tool calls for "${server}" were denied for this session`
      : `Tool call approval required for "${server}"`;

    super(message, {
      code: options.denied ? "CONSENT_DENIED" : "CONSENT_REQUIRED",
      context: { server },
      recoveryHint: options.denied
        ? "The user denied tool access. Start a new session to try again."
        : "Prompt the user for consent before calling tools.",
    });
    this.name = "ConsentError";
    this.denied = options.denied ?? false;
  }
}


