// lifecycle.ts - Idle-disconnect sweep + keep-alive health checks.
//
// Ported from pi-mcp-adapter with sampling/elicitation wiring removed.
// The lifecycle manager owns a single `setInterval` (unref'd) that:
//   - reconnects dropped `keep-alive` servers
//   - disconnects idle `lazy` servers after their per-server or global
//     idle timeout

import type { ServerEntry as ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { logger } from "./logger.ts";

export type ReconnectCallback = (serverName: string) => void;

export class McpLifecycleManager {
  private manager: McpServerManager;
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout: number = 10 * 60 * 1000;
  private healthCheckInterval?: NodeJS.Timeout;
  private onReconnect?: ReconnectCallback;
  private onIdleShutdown?: (serverName: string) => void;

  constructor(manager: McpServerManager) {
    this.manager = manager;
  }

  /** Set callback invoked after a successful auto-reconnect. */
  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }

  /** Set callback invoked when an idle server is disconnected. */
  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  markKeepAlive(name: string, definition: ServerDefinition): void {
    this.keepAliveServers.set(name, definition);
  }

  registerServer(
    name: string,
    definition: ServerDefinition,
    settings?: { idleTimeout?: number },
  ): void {
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) {
      this.serverSettings.set(name, settings);
    }
  }

  /** Drop all registered server entries (used before re-registering after reload). */
  clearServers(): void {
    this.keepAliveServers.clear();
    this.allServers.clear();
    this.serverSettings.clear();
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  startHealthChecks(intervalMs = 30_000): void {
    this.healthCheckInterval = setInterval(() => {
      void this.checkConnections();
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  private async checkConnections(): Promise<void> {
    for (const [name, definition] of this.keepAliveServers) {
      const connection = this.manager.getConnection(name);
      if (!connection || connection.status !== "connected") {
        try {
          await this.manager.connect(name, definition);
          logger.debug(`Reconnected to ${name}`);
          this.onReconnect?.(name);
        } catch (error) {
          logger.error("failed to reconnect", error instanceof Error ? error : undefined, { server: name });
        }
      }
    }

    for (const [name] of this.allServers) {
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        this.onIdleShutdown?.(name);
      }
    }
  }

  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) return perServer * 60 * 1000;
    return this.globalIdleTimeout;
  }

  async gracefulShutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    await this.manager.closeAll();
  }
}
