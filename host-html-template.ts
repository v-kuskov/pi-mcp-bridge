// host-html-template.ts - HTML host page template for MCP UI iframes.
//
// Ported from pi-mcp-adapter (simplified for Phase 1). Builds the HTML
// page that wraps an MCP UI resource in a sandboxed iframe, loads the
// vendored AppBridge bundle, and wires up bidirectional messaging
// between the iframe and the local UI server.
//
// The full upstream template adds CSP meta merging, display-mode
// requests, download-file handlers, and a richer consent UI. Phase 1
// keeps the core: load the resource, forward tool calls / messages /
// context updates to the local proxy, and surface Done/Cancel buttons.

import type { UiHostContext, UiResourceContent, UiResourceCsp } from "./types.ts";

const DEFAULT_APP_BRIDGE_MODULE_URL = "/app-bridge.bundle.js";

export interface HostHtmlTemplateInput {
  sessionToken: string;
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resource: UiResourceContent;
  allowAttribute: string;
  requireToolConsent: boolean;
  cacheToolConsent: boolean;
  hostContext?: UiHostContext;
  appBridgeModuleUrl?: string;
}

export function buildHostHtmlTemplate(input: HostHtmlTemplateInput): string {
  const cspContent = buildCspMetaContent(input.resource.meta.csp);
  const resourceHtml = applyCspMetaContent(input.resource.html, cspContent);

  const sessionToken = safeInlineJSON(input.sessionToken);
  const toolArgs = safeInlineJSON(input.toolArgs);
  const uiHtml = safeInlineJSON(resourceHtml);
  const serverName = safeInlineJSON(input.serverName);
  const toolName = safeInlineJSON(input.toolName);
  const hostContextJson = safeInlineJSON(input.hostContext ?? {});
  const allowAttribute = safeInlineJSON(input.allowAttribute);
  const requireToolConsent = safeInlineJSON(input.requireToolConsent);
  const cacheToolConsent = safeInlineJSON(input.cacheToolConsent);
  const moduleUrl = safeInlineJSON(input.appBridgeModuleUrl ?? DEFAULT_APP_BRIDGE_MODULE_URL);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MCP UI - ${escapeHtml(input.serverName)} / ${escapeHtml(input.toolName)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { display: flex; flex-direction: column; min-height: 100vh; }
    header { padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid rgba(127,127,127,0.25); }
    .title { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
    .server { font-size: 12px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }
    .tool { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .controls { display: flex; gap: 8px; align-items: center; }
    .status { font-size: 12px; opacity: 0.7; }
    button { border: 1px solid rgba(127,127,127,0.35); background: transparent; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
    button.primary { color: #34d399; }
    button.danger { color: #f87171; }
    main { flex: 1; min-height: 0; padding: 10px; display: flex; }
    iframe { width: 100%; height: 100%; border: 1px solid rgba(127,127,127,0.25); border-radius: 10px; background: white; }
  </style>
</head>
<body>
  <header>
    <div class="title">
      <span class="server">MCP · <span id="server-name"></span></span>
      <span class="tool" id="tool-name"></span>
    </div>
    <div class="controls">
      <span class="status" id="status">Loading UI...</span>
      <button class="primary" id="done-btn" title="Cmd/Ctrl+Enter">Done</button>
      <button class="danger" id="cancel-btn" title="Escape">Cancel</button>
    </div>
  </header>
  <main>
    <iframe id="mcp-app" referrerpolicy="no-referrer" sandbox="${escapeHtml(input.allowAttribute)}"></iframe>
  </main>
  <script type="module">
    import { AppBridge, PostMessageTransport } from ${moduleUrl};

    const SESSION_TOKEN = ${sessionToken};
    const SERVER_NAME = ${serverName};
    const TOOL_NAME = ${toolName};
    const TOOL_ARGS = ${toolArgs};
    const HOST_CONTEXT = ${hostContextJson};
    const REQUIRE_TOOL_CONSENT = ${requireToolConsent};
    const CACHE_TOOL_CONSENT = ${cacheToolConsent};
    const STREAM_CONTEXT_KEY = "pi-mcp-bridge/stream";
    const STREAM_PATCH_METHOD = "notifications/pi-mcp-bridge/ui-result-patch";

    const iframe = document.getElementById("mcp-app");
    const statusNode = document.getElementById("status");
    const doneBtn = document.getElementById("done-btn");
    const cancelBtn = document.getElementById("cancel-btn");

    document.getElementById("server-name").textContent = SERVER_NAME;
    document.getElementById("tool-name").textContent = TOOL_NAME;

    const setStatus = (text) => { statusNode.textContent = text; };

    const post = async (endpoint, params) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: SESSION_TOKEN, params }),
      });
      const body = await response.json().catch(() => ({ ok: false, error: "Invalid JSON response" }));
      if (!response.ok || !body.ok) {
        const message = body.error || ("HTTP " + response.status);
        throw new Error(message);
      }
      return body.result ?? {};
    };

    let consentGranted = !REQUIRE_TOOL_CONSENT;

    // Receive tool results / cancellation pushed from the local UI server
    // over Server-Sent Events, and forward them into the iframe via the
    // AppBridge instance.
    let eventSource = null;
    const openEventSource = () => {
      eventSource = new EventSource("/events?session=" + SESSION_TOKEN);
      eventSource.addEventListener("tool-result", (event) => {
        try {
          const payload = JSON.parse(event.data);
          const result = payload && payload.result !== undefined ? payload.result : payload;
          bridge.sendToolResult(result);
          setStatus("Result received");
        } catch {}
      });
      eventSource.addEventListener("tool-cancelled", (event) => {
        try {
          const payload = JSON.parse(event.data);
          bridge.sendToolCancelled(payload && payload.reason ? payload.reason : "Cancelled");
        } catch {}
      });
      eventSource.onerror = () => {
        // The server ends the stream when the session closes; stop
        // reconnecting so the page does not poll forever.
        closeEventSource();
      };
    };
    const closeEventSource = () => {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };

    const bridge = new AppBridge(
      null,
      { name: "pi-mcp-bridge", version: "1.0.0" },
      { serverTools: {}, openLinks: {}, logging: {}, updateModelContext: {}, message: {} },
      { hostContext: HOST_CONTEXT }
    );

    bridge.oncalltool = async (params) => {
      if (!consentGranted) {
        const accepted = window.confirm("Allow this UI to call server tools for this session?");
        if (!accepted) {
          await post("/proxy/ui/consent", { approved: false }).catch(() => {});
          return { isError: true, content: [{ type: "text", text: "Tool call denied by user." }] };
        }
        await post("/proxy/ui/consent", { approved: true });
        if (CACHE_TOOL_CONSENT) consentGranted = true;
      }
      const result = await post("/proxy/tools/call", params);
      await post("/proxy/ui/message", {
        type: "intent",
        intent: "call_tool",
        params: { tool: params.name, arguments: params.arguments, isError: result.isError },
      }).catch(() => {});
      return result;
    };

    bridge.onmessage = async (params) => post("/proxy/ui/message", params);
    bridge.onupdatemodelcontext = async (params) => post("/proxy/ui/context", params);
    bridge.ondownloadfile = async (params) => post("/proxy/ui/download-file", params);
    bridge.onopenlink = async (params) => {
      await post("/proxy/ui/open-link", params);
      window.open(params.url, "_blank", "noopener,noreferrer");
      return { isError: false };
    };

    // Raw postMessage listener for custom UI types (notify/prompt/intent/message).
    window.addEventListener("message", async (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.jsonrpc || (typeof data.method === "string" && (data.method.startsWith("app/") || data.method.startsWith("host/")))) return;
      const msgType = data.type;
      if (typeof msgType !== "string") return;
      if (msgType === "notify" || msgType === "prompt" || msgType === "intent" || msgType === "message") {
        const { type: _, payload, ...directFields } = data;
        await post("/proxy/ui/message", { type: msgType, ...directFields, ...(payload || {}) }).catch(() => {});
      } else if (!msgType.startsWith("ui-lifecycle-") && !msgType.startsWith("ui-message-")) {
        const payload = data.payload || {};
        await post("/proxy/ui/message", { type: "intent", intent: msgType, params: payload }).catch(() => {});
      }
    });

    // Render the UI resource into the iframe via srcdoc.
    iframe.srcdoc = ${uiHtml};
    iframe.addEventListener("load", () => {
      setStatus("UI ready");
      const transport = new PostMessageTransport({ iframeWindow: iframe.contentWindow });
      bridge.attach(transport);
      openEventSource();
    });

    const sendDone = async () => {
      closeEventSource();
      try { await post("/proxy/ui/done", {}); } catch {}
      window.close();
    };
    const sendCancel = async () => {
      closeEventSource();
      try { await post("/proxy/ui/cancel", {}); } catch {}
      window.close();
    };

    doneBtn.addEventListener("click", sendDone);
    cancelBtn.addEventListener("click", sendCancel);

    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); sendDone(); }
      else if (event.key === "Escape") { event.preventDefault(); sendCancel(); }
    });
  </script>
</body>
</html>`;
}

function buildCspMetaContent(csp: UiResourceCsp | undefined): string | undefined {
  if (!csp) return undefined;
  const directives: string[] = [];
  const push = (key: string, domains?: string[]) => {
    if (domains && domains.length > 0) directives.push(`${key} ${domains.join(" ")}`);
  };
  push("connect-src", csp.connectDomains);
  push("script-src", csp.scriptDomains);
  push("style-src", csp.styleDomains);
  push("font-src", csp.fontDomains);
  push("img-src", csp.imgDomains);
  push("media-src", csp.mediaDomains);
  push("frame-src", csp.frameDomains);
  push("worker-src", csp.workerDomains);
  push("base-uri", csp.baseUriDomains);
  return directives.length > 0 ? directives.join("; ") : undefined;
}

function applyCspMetaContent(html: string, cspContent: string | undefined): string {
  if (!cspContent) return html;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(cspContent)}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  }
  return `${meta}${html}`;
}

function safeInlineJSON(value: unknown): string {
  // Escape `</script>` and line separators so the value is safe to inline
  // inside a <script> tag.
  return JSON.stringify(value)
    .replace(/<\/script>/g, "<\\/script>")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
