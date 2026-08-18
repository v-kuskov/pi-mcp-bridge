// __tests__/status-bar.test.ts
//
// Tests for the footer status line + themed list table renderers.

import { describe, it, expect } from "vitest";
import {
  formatStatusLine,
  formatTokenCount,
  renderListTable,
  renderStatusLine,
  totalToolCount,
  updateContextStats,
} from "../status-bar.ts";
import type { McpBridgeState } from "../state.ts";
import type { ListEntry } from "../registry-commands.ts";

// A passthrough theme: wraps text in [] so tests can assert on styling
// without depending on real ANSI codes.
function makeTheme() {
  return {
    fg: (name: string, text: string) => `[${name}:${text}]`,
    bold: (text: string) => `*${text}*`,
  };
}

function makeRegistry(servers: { name: string; tools: string[] }[]) {
  const serversMap = new Map(
    servers.map(s => [
      s.name,
      {
        name: s.name,
        meta: {
          name: s.name,
          transport: { kind: "stdio" as const, command: "x", args: [] },
          auth: { kind: "none" as const },
        },
        tools: new Map(s.tools.map(t => [t, { name: t, description: "", inputSchema: {} }])),
        directory: `/tmp/${s.name}`,
      },
    ]),
  );
  return { root: "/tmp", servers: serversMap, index: null };
}

function makeState(servers: { name: string; tools: string[] }[]): McpBridgeState {
  return {
    manager: {} as never,
    lifecycle: {} as never,
    toolMetadata: new Map(),
    registry: makeRegistry(servers) as never,
    registryGeneration: 1,
    contextStats: null,
    settings: { contextBudgetTokens: 4000 } as never,
    failureTracker: new Map(),
    consentManager: {} as never,
  };
}

describe("status-bar", () => {
  it("counts tools across all servers", () => {
    expect(totalToolCount(makeState([]))).toBe(0);
    expect(totalToolCount(makeState([{ name: "a", tools: ["t1"] }]))).toBe(1);
    expect(
      totalToolCount(makeState([
        { name: "a", tools: ["t1", "t2"] },
        { name: "b", tools: ["t3"] },
      ])),
    ).toBe(3);
  });

  it("formatStatusLine pluralizes correctly", () => {
    const theme = makeTheme();
    const one = formatStatusLine(makeState([{ name: "a", tools: ["t1"] }]), theme);
    expect(one).toContain("1 server");
    expect(one).not.toContain("1 servers");
    expect(one).toContain("1 tool");
    const two = formatStatusLine(
      makeState([{ name: "a", tools: ["t1", "t2"] }, { name: "b", tools: ["t3"] }]),
      theme,
    );
    expect(two).toContain("2 servers");
    expect(two).toContain("3 tools");
  });

  it("formatTokenCount abbreviates thousands", () => {
    expect(formatTokenCount(850)).toBe("850");
    expect(formatTokenCount(1200)).toBe("1.2k");
    expect(formatTokenCount(12000)).toBe("12k");
  });

  it("formatStatusLine includes context occupancy when stats are present", () => {
    const theme = makeTheme();
    const state = makeState([{ name: "a", tools: ["t1", "t2"] }]);
    updateContextStats(state);
    const line = formatStatusLine(state, theme);
    expect(line).toContain("tok");
    expect(line).toMatch(/\d+%/);
    expect(line).toMatch(/schemas|names/);
  });

  it("reports tokens saved vs full-schema baseline when over the inline limit", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}` }));
    // makeState expects tools: string[]
    const state = makeState([{ name: "big", tools: tools.map(t => t.name) }]);
    // Give each tool a fat schema so full-schema baseline is clearly larger.
    const server = state.registry.servers.get("big")!;
    for (const [key, def] of server.tools) {
      server.tools.set(key, {
        ...def,
        description: `Tool ${key}`,
        inputSchema: {
          type: "object",
          properties: {
            a: { type: "string", description: "aaaaaaaaaaaaaaaaaaaaaaaa" },
            b: { type: "number", description: "bbbbbbbbbbbbbbbbbbbbbbbb" },
          },
          required: ["a", "b"],
        },
      });
    }
    const stats = updateContextStats(state);
    expect(stats.schemasIncluded).toBe(false);
    expect(stats.fullSchemaTokens).toBeGreaterThan(stats.estimatedTokens);
    expect(stats.tokensSaved).toBeGreaterThan(0);
    expect(stats.percentSaved).toBeGreaterThan(0);
    const line = formatStatusLine(state, makeTheme());
    expect(line).toContain("saved");
  });

  it("renderListTable shows an empty-registry hint", () => {
    const out = renderListTable([], makeTheme());
    expect(out).toContain("no servers in registry");
    expect(out).toContain("/mcp-bridge add");
  });

  it("renderListTable renders a header + per-server rows", () => {
    const entries: ListEntry[] = [
      {
        name: "context7",
        description: "docs lookup",
        toolCount: 2,
        tools: ["resolve-library-id", "get-docs"],
        transportKind: "stdio",
        syncedFrom: "live-server",
      },
    ];
    const out = renderListTable(entries, makeTheme());
    expect(out).toContain("dim:server");
    expect(out).toContain("[accent:*context7*]");
    expect(out).toContain("[success:2");
    expect(out).toContain("resolve-library-id");
    expect(out).toContain("get-docs");
    // syncedFrom "live-server" → success color
    expect(out).toContain("[success:live-server");
  });

  it("renderStatusLine highlights the counts and context occupancy", () => {
    const out = renderStatusLine(
      makeState([{ name: "a", tools: ["t1", "t2"] }]),
      makeTheme(),
    );
    expect(out).toContain("[accent:*1*]");
    expect(out).toContain("[accent:*2*]");
    expect(out).toContain("servers");
    expect(out).toContain("tools");
    expect(out).toContain("MCP context block");
    expect(out).toContain("tokens");
    expect(out).toContain("Saved vs full schemas");
  });
});
