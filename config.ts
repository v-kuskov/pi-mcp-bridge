// config.ts - Bridge-wide settings loader.
//
// Unlike pi-mcp-adapter, pi-mcp-bridge does NOT load an `mcp.json` file.
// Server definitions live in the filesystem registry
// (`<agent dir>/mcp-registry/<server>/meta.json`). This module only loads
// the small `BridgeSettings` document that controls bridge-wide behavior
// (output guard, context budget, idle timeout).

import { existsSync, readFileSync } from "node:fs";
import { getAgentPath } from "./agent-dir.ts";
import type { BridgeSettings } from "./types.ts";
import { envKillSwitch } from "./mcp-output-guard.ts";

const SETTINGS_FILENAME = "mcp-bridge.json";

/** Default settings if no file is present. */
export const DEFAULT_SETTINGS: BridgeSettings = {
  idleTimeout: 10,
  requestTimeoutMs: 0,
  outputGuard: true,
  contextBudgetTokens: 4000,
};

/** Resolve the settings file path (`<agent dir>/mcp-bridge.json` by default). */
export function getSettingsPath(): string {
  return getAgentPath(SETTINGS_FILENAME);
}

/**
 * Load `BridgeSettings` from `<agent dir>/mcp-bridge.json`.
 *
 * Missing or unparseable files fall back to `DEFAULT_SETTINGS`. Env kill
 * switches (`MCP_OUTPUT_GUARD=0`) are applied on top of file settings.
 */
export function loadBridgeSettings(): BridgeSettings {
  const path = getSettingsPath();
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };

  let parsed: Partial<BridgeSettings> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      parsed = raw as Partial<BridgeSettings>;
    }
  } catch {
    return { ...DEFAULT_SETTINGS };
  }

  const envGuard = envKillSwitch("MCP_OUTPUT_GUARD");
  const outputGuard =
    envGuard !== undefined
      ? envGuard
      : parsed.outputGuard ?? DEFAULT_SETTINGS.outputGuard;

  return {
    // 0 is a valid "disable idle sweep" value (documented in README / types).
    idleTimeout:
      parsed.idleTimeout === 0
        ? 0
        : positiveInt(parsed.idleTimeout) ?? DEFAULT_SETTINGS.idleTimeout,
    requestTimeoutMs: positiveInt(parsed.requestTimeoutMs) ?? DEFAULT_SETTINGS.requestTimeoutMs!,
    outputGuard,
    contextBudgetTokens:
      positiveInt(parsed.contextBudgetTokens) ?? DEFAULT_SETTINGS.contextBudgetTokens!,
    schemaInjectionToolLimit:
      parsed.schemaInjectionToolLimit === 0
        ? 0
        : positiveInt(parsed.schemaInjectionToolLimit) ?? undefined,
    requireConsent: parsed.requireConsent === true,
  };
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}
