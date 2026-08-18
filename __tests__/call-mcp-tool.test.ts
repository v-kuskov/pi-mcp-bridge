// __tests__/call-mcp-tool.test.ts
//
// Focused tests for the consent gate in executeCallMcpTool. The full
// connect/forward path is integration territory; here we only verify that
// the gate blocks (or doesn't) before any network activity.

import { describe, it, expect } from "vitest";
import { executeCallMcpTool } from "../call-mcp-tool.ts";
import { ConsentManager } from "../consent-manager.ts";
import type { McpBridgeState } from "../state.ts";
import type { Registry } from "../registry/registry-types.ts";
import type { ToolDefinition } from "../registry/registry-types.ts";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
}

function makeRegistry(): Registry {
  const tools = new Map<string, ToolDefinition>([
    ["echo", makeTool("echo")],
  ]);
  return {
    root: "/tmp/test-registry",
    servers: new Map([
      [
        "test",
        {
          name: "test",
          meta: {
            name: "test",
            transport: { kind: "stdio", command: "echo", args: [] },
            auth: { kind: "none" },
            syncedFrom: "manual",
          },
          tools,
          directory: "/tmp/test-registry/test",
        },
      ],
    ]),
    index: null,
  };
}

function makeState(opts: { requireConsent: boolean; approved?: boolean }): McpBridgeState {
  const consentManager = new ConsentManager("once-per-server");
  if (opts.approved) consentManager.registerDecision("test", true);
  const manager = {
    getConnection: () => null,
    connect: async () => {
      throw new Error("should not reach connect in gated tests");
    },
    callTool: async () => {
      throw new Error("should not reach callTool in gated tests");
    },
    touch: () => {},
    incrementInFlight: () => {},
    decrementInFlight: () => {},
  };
  return {
    manager: manager as never,
    lifecycle: {} as never,
    toolMetadata: new Map(),
    registry: makeRegistry(),
    registryGeneration: 1,
    contextStats: null,
    settings: { requireConsent: opts.requireConsent } as never,
    failureTracker: new Map(),
    consentManager,
    ui: { notify: () => {} } as never,
  };
}

describe("executeCallMcpTool consent gate", () => {
  it("blocks with consent_required when requireConsent is on and server is unapproved", async () => {
    const state = makeState({ requireConsent: true });
    const result = await executeCallMcpTool(state, {
      server: "test",
      toolName: "echo",
      arguments: {},
    });
    expect(result.details).toMatchObject({ error: "consent_required", server: "test" });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("/mcp-bridge approve test");
  });

  it("does not block when requireConsent is on but server is approved", async () => {
    const state = makeState({ requireConsent: true, approved: true });
    const result = await executeCallMcpTool(state, {
      server: "test",
      toolName: "echo",
      arguments: {},
    });
    // Approved → gate passes → falls through to connect, which throws.
    expect(result.details).toMatchObject({ error: "connect_failed" });
  });

  it("does not block when requireConsent is off", async () => {
    const state = makeState({ requireConsent: false });
    const result = await executeCallMcpTool(state, {
      server: "test",
      toolName: "echo",
      arguments: {},
    });
    expect(result.details).toMatchObject({ error: "connect_failed" });
  });
});
