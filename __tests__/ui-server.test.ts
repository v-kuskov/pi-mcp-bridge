import { describe, it, expect, afterEach } from "vitest";
import { get as httpGet, request as httpRequest } from "node:http";
import { startUiServer, type UiServerHandle } from "../ui-server.ts";
import { McpServerManager } from "../server-manager.ts";
import { ConsentManager } from "../consent-manager.ts";

let handles: UiServerHandle[] = [];

async function startTestServer(): Promise<UiServerHandle> {
  const manager = new McpServerManager(process.cwd());
  const consentManager = new ConsentManager("once-per-server");
  const handle = await startUiServer({ manager, consentManager });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const h of handles) h.close("test teardown");
  handles = [];
});

function get(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(`http://127.0.0.1:${handles[0].port}${path}`, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });
}

function post(path: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: handles[0].port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      res => {
        let body = "";
        res.on("data", c => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

function openSse(path: string): { chunks: string[]; close: () => void } {
  const chunks: string[] = [];
  const req = httpGet(`http://127.0.0.1:${handles[0].port}${path}`, res => {
    res.on("data", c => chunks.push(String(c)));
  });
  return { chunks, close: () => req.destroy() };
}

const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe("ui-server", () => {
  it("starts (async listen) and serves a registered session page", async () => {
    const server = await startTestServer();
    server.registerSession({
      token: "abc",
      serverName: "srv",
      toolName: "tool",
      toolArgs: {},
      html: "<h1>hello</h1>",
    });
    const page = await get("/s/abc");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<h1>hello</h1>");
    const missing = await get("/s/nope");
    expect(missing.status).toBe(404);
  });

  it("streams pushed results over SSE and accumulates messages", async () => {
    const server = await startTestServer();
    const messages: Record<string, unknown>[] = [];
    let done = false;
    const handle = server.registerSession({
      token: "t1",
      serverName: "srv",
      toolName: "tool",
      toolArgs: {},
      html: "<h1>x</h1>",
      onMessage: m => messages.push(m),
      onDone: () => {
        done = true;
      },
      onCancel: () => {},
    });

    // ui/message accumulates prompts and forwards to onMessage.
    await post("/proxy/ui/message", { token: "t1", params: { type: "prompt", prompt: "hi there" } });
    expect(messages).toHaveLength(1);
    expect(handle.getMessages().prompts).toEqual(["hi there"]);

    // Pushed results arrive on the SSE stream.
    const sse = openSse("/events?session=t1");
    await wait(100);
    handle.pushResult({ content: [{ type: "text", text: "result-payload" }] });
    await wait(100);
    const sseText = sse.chunks.join("");
    expect(sseText).toContain("event: tool-result");
    expect(sseText).toContain("result-payload");
    sse.close();

    // ui/done fires onDone and removes the session.
    const doneRes = await post("/proxy/ui/done", { token: "t1", params: {} });
    expect(doneRes.status).toBe(200);
    expect(done).toBe(true);
    const after = await get("/s/t1");
    expect(after.status).toBe(404);
  });

  it("ui/cancel fires onCancel and rejects unknown tokens", async () => {
    const server = await startTestServer();
    let cancelled = false;
    server.registerSession({
      token: "t2",
      serverName: "srv",
      toolName: "tool",
      toolArgs: {},
      html: "<h1>x</h1>",
      onMessage: () => {},
      onDone: () => {},
      onCancel: () => {
        cancelled = true;
      },
    });
    await post("/proxy/ui/cancel", { token: "t2", params: {} });
    expect(cancelled).toBe(true);

    const bad = await post("/proxy/ui/message", { token: "ghost", params: {} });
    expect(bad.status).toBe(400);
  });
});
