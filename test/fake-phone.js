#!/usr/bin/env node
/**
 * Simulated Faceclaw phone for exercising the bridge without hardware.
 *
 * Speaks the bridge wire protocol: authenticates, serves a tiny fake MCP
 * tool registry (so the agent's glasses_list_tools / glasses_call work),
 * optionally sends one utterance, prints streamed reply frames, then stays
 * connected until Ctrl-C (so proactive tool calls can be tested from
 * another OpenClaw channel).
 *
 * Usage: node test/fake-phone.js ws://host:port <token> ["utterance text"]
 */

import WebSocket from "ws";

const [, , url, token, utterance] = process.argv;
if (!url || !token) {
  console.error('usage: node test/fake-phone.js ws://host:port <token> ["utterance"]');
  process.exit(2);
}

const FAKE_TOOLS = [
  {
    name: "glasses.show_alert",
    description: "Show a short text popup on the lenses.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "glasses.get_state",
    description: "Screen state, foreground app, battery, time.",
    inputSchema: { type: "object", properties: {} },
  },
];

const ws = new WebSocket(url);
const send = (frame) => ws.send(JSON.stringify({ v: 1, ...frame }));
const sendMcp = (msg) => send({ chan: "mcp", msg });

function handleMcp(msg) {
  if (msg.method === "initialize") {
    sendMcp({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake-phone", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    sendMcp({ jsonrpc: "2.0", id: msg.id, result: { tools: FAKE_TOOLS } });
    return;
  }
  if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    console.log(`[fake-phone] tools/call ${name} ${JSON.stringify(args)}`);
    let text;
    if (name === "glasses.get_state") {
      text = JSON.stringify({
        screenOn: true,
        foregroundApp: "dashboard",
        battery: { left: 81, right: 79 },
        localTime: new Date().toString(),
      });
    } else if (name === "glasses.show_alert") {
      text = `Alert shown on lenses: ${args?.text}`;
    } else {
      sendMcp({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true },
      });
      return;
    }
    sendMcp({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
    return;
  }
  if (msg.id !== undefined && msg.method) {
    sendMcp({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not implemented" } });
  }
}

let streamed = "";
ws.on("open", () => {
  console.log("[fake-phone] connected, sending hello");
  send({ chan: "ctl", type: "hello", token, deviceName: "fake-phone" });
});

ws.on("message", (data) => {
  let frame;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (frame.chan === "ctl") {
    if (frame.type === "hello-ack") {
      console.log(`[fake-phone] authenticated; session=${frame.sessionKey}`);
      if (utterance) {
        console.log(`[fake-phone] sending utterance: ${utterance}`);
        send({
          chan: "chat",
          type: "utterance",
          turnId: "t1",
          text: utterance,
          ctx: {
            foregroundApp: "dashboard",
            screenOn: true,
            localTime: new Date().toString(),
            headsetBattery: 80,
          },
        });
      }
    } else if (frame.type === "error") {
      console.error(`[fake-phone] ctl error: ${frame.message}`);
    }
    return;
  }
  if (frame.chan === "chat") {
    if (frame.type === "text-delta") {
      streamed = frame.replace ? frame.text : streamed + frame.text;
      process.stdout.write(frame.replace ? `\n[replace] ${frame.text}` : frame.text);
    } else if (frame.type === "tool-activity") {
      console.log(`\n[fake-phone] tool-activity: ${frame.label}`);
    } else if (frame.type === "turn-done") {
      console.log(`\n[fake-phone] turn-done (${frame.stopReason})`);
      console.log(`[fake-phone] final text: ${frame.text}`);
    } else if (frame.type === "turn-error") {
      console.error(`\n[fake-phone] turn-error: ${frame.message}`);
    }
    return;
  }
  if (frame.chan === "mcp") {
    handleMcp(frame.msg || {});
  }
});

ws.on("close", (code, reason) => {
  console.log(`[fake-phone] closed: ${code} ${reason}`);
  process.exit(0);
});
ws.on("error", (err) => {
  console.error(`[fake-phone] error: ${err.message}`);
});
