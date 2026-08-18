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


