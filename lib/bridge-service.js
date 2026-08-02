/**
 * Faceclaw bridge service: hosts the websocket endpoint the phone dials into.
 *
 * One JSON object per text frame, multiplexed over three channels:
 *
 *   { v: 1, chan: "ctl",  type: "hello" | "hello-ack" | "ping" | "pong" | "error", ... }
 *   { v: 1, chan: "chat", type: "utterance" | "cancel"                 (phone -> agent)
 *                         | "text-delta" | "tool-activity"
 *                         | "turn-done" | "turn-error",                (agent -> phone) ... }
 *   { v: 1, chan: "mcp",  msg: <raw MCP JSON-RPC frame> }              (bidirectional)
 *
 * The phone is the MCP *server* on the mcp channel (it serves the glasses'
 * tool registry); this side is the MCP client. Chat utterances run as
 * embedded OpenClaw agent turns with streamed replies.
 */

import { WebSocketServer, WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import { createMcpClient } from "./mcp-client.js";

const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 10000;

function tokenMatches(expected, presented) {
  if (typeof expected !== "string" || typeof presented !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createBridgeService({ logger, getPluginConfig, runtime, fallbackConfig }) {
  /** @type {import("ws").WebSocketServer | null} */
  let wss = null;
  /**
   * The connected phone, or null. Single-connection policy: a newer
   * authenticated connection supersedes the old one.
   * @type {{ws: WebSocket, deviceName: string, mcp: ReturnType<typeof createMcpClient>, connectedAtMs: number} | null}
   */
  let phone = null;
  /** @type {{turnId: string, controller: AbortController} | null} */
  let activeTurn = null;
  let nextRunSeq = 1;

  function cfg() {
    const pc = typeof getPluginConfig === "function" ? getPluginConfig() : getPluginConfig;
    const c = pc || {};
    return {
      token: typeof c.token === "string" ? c.token : "",
      wsBind: typeof c.wsBind === "string" && c.wsBind ? c.wsBind : "127.0.0.1",
      wsPort: Number.isFinite(c.wsPort) ? c.wsPort : 8790,
      sessionKey:
        typeof c.sessionKey === "string" && c.sessionKey ? c.sessionKey : "faceclaw:glasses",
      agentId: typeof c.agentId === "string" && c.agentId ? c.agentId : null,
      turnTimeoutMs: Number.isFinite(c.turnTimeoutMs) ? c.turnTimeoutMs : 120000,
      toolCallTimeoutMs: Number.isFinite(c.toolCallTimeoutMs) ? c.toolCallTimeoutMs : 20000,
    };
  }

  function runtimeConfig() {
    const current = runtime?.config?.current;
    if (typeof current === "function") {
      try {
        return current();
      } catch {
        // fall through
      }
    }
    return fallbackConfig;
  }

  function resolveAgentId(openclawCfg) {
    const configured = cfg().agentId;
    if (configured) return configured;
    const agents = Array.isArray(openclawCfg?.agents?.list) ? openclawCfg.agents.list : [];
    const chosen = (agents.find((agent) => agent && agent.default) ?? agents[0])?.id;
    return typeof chosen === "string" && chosen.trim() ? chosen.trim() : "main";
  }

  function sendFrame(ws, frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
    } catch (err) {
      logger.warn(`[faceclaw-bridge] send failed: ${err?.message || err}`);
    }
  }

  function sendChat(ws, payload) {
    sendFrame(ws, { chan: "chat", ...payload });
  }

  function dropPhone(reason) {
    if (!phone) return;
    const old = phone;
    phone = null;
    try {
      old.mcp.close();
    } catch {
      /* ignore */
    }
    if (old.ws.readyState === WebSocket.OPEN || old.ws.readyState === WebSocket.CONNECTING) {
      sendFrame(old.ws, { chan: "ctl", type: "error", message: reason });
      old.ws.close(1000, reason);
    }
    if (activeTurn) {
      activeTurn.controller.abort();
      activeTurn = null;
    }
    logger.info(`[faceclaw-bridge] phone disconnected (${reason})`);
  }

  function attachPhone(ws, hello) {
    if (phone) dropPhone("superseded by new connection");
    const mcp = createMcpClient({
      send: (msg) => sendFrame(ws, { chan: "mcp", msg }),
      logger,
      requestTimeoutMs: cfg().toolCallTimeoutMs,
    });
    phone = {
      ws,
      deviceName: typeof hello.deviceName === "string" ? hello.deviceName : "glasses",
      mcp,
      connectedAtMs: Date.now(),
    };
    sendFrame(ws, {
      chan: "ctl",
      type: "hello-ack",
      serverName: "faceclaw-agent-bridge",
      sessionKey: cfg().sessionKey,
    });
    logger.info(`[faceclaw-bridge] phone connected: ${phone.deviceName}`);
    // Bring up the MCP session in the background; chat works without it.
    mcp
      .initialize()
      .then(() => mcp.listTools())
      .then((tools) => {
        logger.info(`[faceclaw-bridge] glasses expose ${tools.length} tool(s)`);
      })
      .catch((err) => {
        logger.warn(`[faceclaw-bridge] MCP init failed: ${err?.message || err}`);
      });
  }

  function buildPrompt(text, ctx) {
    const parts = [];
    if (ctx && typeof ctx === "object") {
      const bits = [];
      if (typeof ctx.localTime === "string" && ctx.localTime) bits.push(`time: ${ctx.localTime}`);
      if (typeof ctx.foregroundApp === "string" && ctx.foregroundApp) {
        bits.push(`foreground app: ${ctx.foregroundApp}`);
      }
      if (typeof ctx.screenOn === "boolean") bits.push(`screen ${ctx.screenOn ? "on" : "off"}`);
      if (Number.isFinite(ctx.headsetBattery)) bits.push(`glasses battery ${ctx.headsetBattery}%`);
      if (bits.length > 0) {
        parts.push(`[Spoken through smart glasses. ${bits.join(", ")}]`);
      } else {
        parts.push("[Spoken through smart glasses]");
      }
    }
    parts.push(text);
    return parts.join("\n");
  }

  const GLASSES_STYLE_PROMPT = [
    "This message arrived from the user's smart glasses (Even Realities G2).",
    "Your reply renders on a small 576x288 monochrome heads-up display.",
    "Answer in 1-3 short sentences of plain text: no markdown, no headings,",
    "no lists unless explicitly asked. Prefer acting via tools over describing",
    "what could be done. The glasses' own capabilities are available through",
    "the glasses_list_tools and glasses_call tools.",
  ].join(" ");

  async function handleUtterance(ws, frame) {
    const turnId = typeof frame.turnId === "string" ? frame.turnId : "";
    const text = typeof frame.text === "string" ? frame.text.trim() : "";
    if (!turnId || !text) {
      sendChat(ws, { type: "turn-error", turnId, message: "empty utterance" });
      return;
    }
    if (activeTurn) {
      // The phone serializes turns; a new utterance means the old turn is stale.
      activeTurn.controller.abort();
      activeTurn = null;
    }
    const controller = new AbortController();
    activeTurn = { turnId, controller };

    const openclawCfg = runtimeConfig();
    const agentId = resolveAgentId(openclawCfg);
    const settings = cfg();
    let sentChars = 0;

    const emitSnapshot = (snapshot, replace) => {
      if (typeof snapshot !== "string" || snapshot.length === 0) return;
      if (replace) {
        sendChat(ws, { type: "text-delta", turnId, text: snapshot, replace: true });
        sentChars = snapshot.length;
        return;
      }
      if (snapshot.length <= sentChars) return;
      sendChat(ws, { type: "text-delta", turnId, text: snapshot.slice(sentChars) });
      sentChars = snapshot.length;
    };

    try {
      const workspaceDir = runtime.agent.resolveAgentWorkspaceDir(openclawCfg, agentId);
      const result = await runtime.agent.runEmbeddedAgent({
        sessionId: settings.sessionKey,
        sessionKey: settings.sessionKey,
        agentId,
        workspaceDir,
        config: openclawCfg,
        prompt: buildPrompt(text, frame.ctx),
        extraSystemPrompt: GLASSES_STYLE_PROMPT,
        timeoutMs: settings.turnTimeoutMs,
        runId: `faceclaw-${Date.now()}-${nextRunSeq++}`,
        abortSignal: controller.signal,
        trigger: "user",
        disableMessageTool: true,
        onPartialReply: (payload) => {
          if (activeTurn?.turnId !== turnId) return;
          emitSnapshot(payload?.text, payload?.replace === true);
        },
        onAgentToolResult: (event) => {
          if (activeTurn?.turnId !== turnId) return;
          if (event?.toolName) {
            sendChat(ws, { type: "tool-activity", turnId, label: String(event.toolName) });
          }
        },
      });
      if (activeTurn?.turnId !== turnId) return; // cancelled/superseded mid-run
      activeTurn = null;
      const finalText = (result?.payloads || [])
        .filter((p) => p && typeof p.text === "string" && !p.isReasoning && !p.isCommentary)
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (finalText && finalText.length > sentChars) {
        emitSnapshot(finalText, sentChars === 0 ? false : true);
      }
      sendChat(ws, { type: "turn-done", turnId, stopReason: "end_turn", text: finalText });
    } catch (err) {
      const wasCancelled = controller.signal.aborted;
      if (activeTurn?.turnId === turnId) activeTurn = null;
      if (wasCancelled) {
        sendChat(ws, { type: "turn-done", turnId, stopReason: "cancelled", text: "" });
        return;
      }
      const message = err?.message || String(err);
      logger.warn(`[faceclaw-bridge] turn failed: ${message}`);
      sendChat(ws, { type: "turn-error", turnId, message });
    }
  }

  function handleFrame(ws, frame) {
    if (!frame || typeof frame !== "object") return;
    if (frame.chan === "ctl") {
      if (frame.type === "ping") {
        sendFrame(ws, { chan: "ctl", type: "pong", ts: frame.ts });
      }
      return;
    }
    if (phone === null || phone.ws !== ws) return; // only the attached phone past here
    if (frame.chan === "chat") {
      if (frame.type === "utterance") {
        void handleUtterance(ws, frame);
      } else if (frame.type === "cancel") {
        if (activeTurn && activeTurn.turnId === frame.turnId) {
          activeTurn.controller.abort();
        }
      }
      return;
    }
    if (frame.chan === "mcp") {
      phone.mcp.handleMessage(frame.msg);
      return;
    }
  }

  function handleConnection(ws, req) {
    const remote = req?.socket?.remoteAddress || "unknown";
    let authenticated = false;
    const helloTimer = setTimeout(() => {
      if (!authenticated) {
        sendFrame(ws, { chan: "ctl", type: "error", message: "hello timeout" });
        ws.close(1008, "hello timeout");
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let frame = null;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!authenticated) {
        if (!frame || frame.chan !== "ctl" || frame.type !== "hello") {
          sendFrame(ws, { chan: "ctl", type: "error", message: "hello required" });
          ws.close(1008, "hello required");
          return;
        }
        const expected = cfg().token;
        if (!expected) {
          sendFrame(ws, { chan: "ctl", type: "error", message: "bridge token not configured" });
          ws.close(1008, "not configured");
          return;
        }
        if (!tokenMatches(expected, frame.token)) {
          logger.warn(`[faceclaw-bridge] auth failure from ${remote}`);
          sendFrame(ws, { chan: "ctl", type: "error", message: "invalid token" });
          ws.close(1008, "invalid token");
          return;
        }
        authenticated = true;
        clearTimeout(helloTimer);
        attachPhone(ws, frame);
        return;
      }
      handleFrame(ws, frame);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (phone && phone.ws === ws) {
        phone.mcp.close();
        phone = null;
        if (activeTurn) {
          activeTurn.controller.abort();
          activeTurn = null;
        }
        logger.info("[faceclaw-bridge] phone connection closed");
      }
    });

    ws.on("error", (err) => {
      logger.warn(`[faceclaw-bridge] ws error from ${remote}: ${err?.message || err}`);
    });
  }

  return {
    start() {
      const { wsBind, wsPort, token } = cfg();
      if (!token) {
        logger.warn(
          "[faceclaw-bridge] no token configured (plugins.entries.faceclaw-bridge.config.token); bridge not started",
        );
        return;
      }
      wss = new WebSocketServer({ host: wsBind, port: wsPort });
      wss.on("connection", (ws, req) => handleConnection(ws, req));
      wss.on("error", (err) => {
        logger.error(`[faceclaw-bridge] server error: ${err?.message || err}`);
      });
      logger.info(`[faceclaw-bridge] listening on ws://${wsBind}:${wsPort}`);
    },

    stop() {
      dropPhone("bridge shutting down");
      if (wss) {
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        wss = null;
      }
    },

    isPhoneConnected() {
      return phone !== null && phone.ws.readyState === WebSocket.OPEN;
    },

    getPhoneName() {
      return phone ? phone.deviceName : null;
    },

    async listGlassesTools() {
      if (!phone) throw new Error("Glasses are not connected");
      return await phone.mcp.listTools();
    },

    async callGlassesTool(name, args) {
      if (!phone) throw new Error("Glasses are not connected");
      return await phone.mcp.callTool(name, args, cfg().toolCallTimeoutMs);
    },
  };
}
