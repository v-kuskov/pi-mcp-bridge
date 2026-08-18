/**
 * Centralized logging for pi-mcp-bridge operations.
 * Provides structured, contextual logs with levels.
 *
 * Console format (human-readable, no all-caps prefix):
 *
 *   [mcp-bridge] session_start: 2 servers, 5 tools
 *   [mcp-bridge] warn: context injection truncated to fit the budget
 *   [mcp-bridge] error: graceful shutdown failed (reason=session_restart): boom
 *       at <first stack frame>
 *
 * The error message rides on the log line (deduped if the message already
 * mentions it); the first stack frame — the throw site — follows indented.
 * The full stack prints only in debug mode (`MCP_BRIDGE_DEBUG=1`). Colors
 * are applied only when the output is a TTY so piped logs stay ANSI-free.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  server?: string;
  session?: string;
  tool?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: Error;
  timestamp: Date;
}

type LogHandler = (entry: LogEntry) => void;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ANSI styling — applied only when writing to a TTY so piped logs stay ANSI-free.
const ANSI = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", yellow: "\x1b[33m", gray: "\x1b[90m" };
const LEVEL_STYLE: Record<LogLevel, { label: string; color?: string }> = {
  debug: { label: "debug", color: ANSI.gray },
  info: { label: "" },
  warn: { label: "warn", color: ANSI.yellow },
  error: { label: "error", color: ANSI.red },
};

const useColorForLevel = (level: LogLevel): boolean =>
  level === "error" || level === "warn" ? Boolean(process.stderr.isTTY) : Boolean(process.stdout.isTTY);

function paint(text: string, code: string | undefined, color: boolean): string {
  return color && code ? `${code}${text}${ANSI.reset}` : text;
}

class Logger {
  private minLevel: LogLevel = "info";
  private handlers: LogHandler[] = [];
  private defaultContext: LogContext = {};

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  setDefaultContext(context: LogContext): void {
    this.defaultContext = context;
  }

  addHandler(handler: LogHandler): void {
    this.handlers.push(handler);
  }

  clearHandlers(): void {
    this.handlers = [];
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private emit(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      context: { ...this.defaultContext, ...context },
      error,
      timestamp: new Date(),
    };

    const line = formatLogLine(entry, useColorForLevel(level));
    const stack = error?.stack
      ? this.minLevel === "debug"
        ? formatFullStack(error.stack)
        : formatFirstFrame(error.stack)
      : "";
    const output = `${line}${stack}`;

    if (level === "error") {
      console.error(output);
    } else if (level === "warn") {
      console.warn(output);
    } else if (level === "debug") {
      console.debug(output);
    } else {
      console.log(output);
    }

    for (const handler of this.handlers) {
      try {
        handler(entry);
      } catch {
        // Ignore handler errors
      }
    }
  }

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.emit("error", message, context, error);
  }

  /** Create a child logger with additional default context. */
  child(context: LogContext): ChildLogger {
    return new ChildLogger(this, context);
  }
}

class ChildLogger {
  constructor(
    private parent: Logger,
    private context: LogContext,
  ) {}

  debug(message: string, context?: LogContext): void {
    this.parent.debug(message, { ...this.context, ...context });
  }

  info(message: string, context?: LogContext): void {
    this.parent.info(message, { ...this.context, ...context });
  }

  warn(message: string, context?: LogContext): void {
    this.parent.warn(message, { ...this.context, ...context });
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.parent.error(message, error, { ...this.context, ...context });
  }

  child(context: LogContext): ChildLogger {
    return new ChildLogger(this.parent, { ...this.context, ...context });
  }
}

function formatContext(context?: LogContext, color = false): string {
  if (!context || Object.keys(context).length === 0) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null) {
      parts.push(`${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return parts.length > 0 ? ` ${paint(`(${parts.join(", ")})`, ANSI.dim, color)}` : "";
}

function formatLogLine(entry: LogEntry, color: boolean): string {
  const { level, message, context, error } = entry;
  const style = LEVEL_STYLE[level];
  const prefix = paint("[mcp-bridge]", ANSI.dim, color);
  const levelWord = style.label ? `${paint(`${style.label}:`, style.color, color)} ` : "";
  const contextStr = formatContext(context, color);
  const errorSuffix = error ? formatErrorSuffix(message, error) : "";
  return `${prefix} ${levelWord}${message}${contextStr}${errorSuffix}`;
}

/** Append `: <error message>` unless the log message already mentions it. */
function formatErrorSuffix(message: string, error: Error): string {
  const errText = error.message || String(error);
  if (!errText || message.includes(errText)) return "";
  return `: ${errText}`;
}

/** Stack lines minus a leading `Error: message` header, if any. */
function stackFrames(stack: string): string[] {
  const lines = stack.split("\n").map(line => line.trim()).filter(Boolean);
  const hasHeader = lines.length > 0 && /^[A-Za-z][\w.]*Error: /.test(lines[0]!);
  return hasHeader ? lines.slice(1) : lines;
}

/** First stack frame (the throw site), indented on its own line. */
function formatFirstFrame(stack: string): string {
  const frame = stackFrames(stack).find(line => line.startsWith("at "));
  return frame ? `\n    ${frame}` : "";
}

/** Full stack minus the leading `Error: message` line, indented. */
function formatFullStack(stack: string): string {
  const frames = stackFrames(stack);
  return frames.length > 0 ? `\n${frames.map(frame => `    ${frame}`).join("\n")}` : "";
}

// Singleton instance
export const logger = new Logger();

// Enable debug mode via environment variable
if (process.env.MCP_BRIDGE_DEBUG === "1" || process.env.MCP_BRIDGE_DEBUG === "true") {
  logger.setLevel("debug");
}
