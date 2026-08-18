import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerEntry } from "./types.ts";

/**
 * Interpolate `${VAR}` and `$env:VAR` references from `process.env` into a
 * single string. Missing variables expand to the empty string.
 */
export function interpolateEnvVars(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
    .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
}

/** Interpolate every value in a string record. Returns `undefined` for `undefined` input. */
export function interpolateEnvRecord(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!values) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    resolved[key] = interpolateEnvVars(value);
  }
  return resolved;
}

/**
 * Resolve a config path with env interpolation and `~` expansion.
 * - `undefined` → `undefined`
 * - `~` → home directory
 * - `~/foo` → `<home>/foo`
 * - everything else → interpolated as-is
 */
export function resolveConfigPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const resolved = interpolateEnvVars(value);
  if (resolved === "~") return homedir();
  if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
    return join(homedir(), resolved.slice(2));
  }
  return resolved;
}

/** Resolve a bearer token from either a literal value or an env var name. */
export function resolveBearerToken(
  definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">,
): string | undefined {
  if (definition.bearerToken !== undefined) {
    return interpolateEnvVars(definition.bearerToken);
  }
  return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

/** Truncate text at the last word boundary before `target` chars, with ellipsis. */
export function truncateAtWord(text: string, target: number): string {
  if (!text || text.length <= target) return text;
  const truncated = text.slice(0, target);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > target * 0.6) {
    return truncated.slice(0, lastSpace) + "...";
  }
  return truncated + "...";
}

/**
 * Normalize a tool's input schema for registration with Pi:
 * - drops `$schema` and `additionalProperties` (Pi handles these itself)
 * - falls back to an empty object schema for non-object input
 */
export function normalizeDirectToolInputSchema(schema: unknown): Record<string, unknown> {
  const inputSchema =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Record<string, unknown>)
      : { type: "object", properties: {} };
  const { $schema, additionalProperties, ...normalized } = inputSchema;
  return normalized;
}

/** Run async `fn` over `items` with at most `limit` workers in flight. */
export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);
  return results;
}
