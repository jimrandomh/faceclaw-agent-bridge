/**
 * Minimal MCP (Model Context Protocol) client speaking JSON-RPC 2.0 over an
 * arbitrary frame transport. The phone side of the bridge is the MCP server:
 * it serves the glasses' ToolRegistry as `tools/list` / `tools/call` and
 * emits `notifications/tools/list_changed` when availability changes.
 *
 * Transport contract: the owner calls `handleMessage(msg)` with each decoded
 * JSON-RPC message received from the peer, and provides `send(msg)` to
 * deliver a JSON-RPC message to the peer.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";

export function createMcpClient({ send, logger, requestTimeoutMs = 20000 }) {
  let nextId = 1;
  /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map();
  let initialized = false;
  /** @type {{tools: Array<object>, fetchedAtMs: number} | null} */
  let toolCache = null;
  let closed = false;

  function request(method, params, timeoutMs = requestTimeoutMs) {
    if (closed) {
      return Promise.reject(new Error("MCP transport closed"));
    }
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send(msg);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function notify(method, params) {
    if (closed) return;
    const msg = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;
    send(msg);
  }

  function handleMessage(msg) {
    if (!msg || msg.jsonrpc !== "2.0") return;
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const message = msg.error.message || "MCP error";
        entry.reject(new Error(`${message} (code ${msg.error.code})`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    // Request from the server (only ping is expected).
    if (msg.id !== undefined && typeof msg.method === "string") {
      if (msg.method === "ping") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not supported: ${msg.method}` },
        });
      }
      return;
    }
    // Notification from the server.
    if (typeof msg.method === "string") {
      if (msg.method === "notifications/tools/list_changed") {
        toolCache = null;
        logger.debug?.("[faceclaw-bridge] glasses tool list changed; cache invalidated");
      }
      return;
    }
  }

  async function initialize() {
    const result = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "faceclaw-agent-bridge", version: "0.1.0" },
    });
    notify("notifications/initialized");
    initialized = true;
    return result;
  }

  async function listTools({ forceRefresh = false } = {}) {
    if (!initialized) throw new Error("MCP session not initialized");
    if (toolCache && !forceRefresh) return toolCache.tools;
    const result = await request("tools/list", {});
    const tools = Array.isArray(result && result.tools) ? result.tools : [];
    toolCache = { tools, fetchedAtMs: Date.now() };
    return tools;
  }

  async function callTool(name, args, timeoutMs) {
    if (!initialized) throw new Error("MCP session not initialized");
    return await request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }

  function close() {
    closed = true;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MCP transport closed"));
    }
    pending.clear();
  }

  return {
    handleMessage,
    initialize,
    listTools,
    callTool,
    close,
    isInitialized: () => initialized,
  };
}
