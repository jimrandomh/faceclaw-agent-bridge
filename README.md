# faceclaw-agent-bridge

OpenClaw plugin that bridges [Faceclaw](https://github.com/jimrandomh) (an
Android shell for Even Realities G2 smart glasses) to an OpenClaw agent.

Phones can't reliably accept inbound connections, so the phone **dials out**
to this plugin's websocket server (typically over tailscale). One socket
carries three multiplexed channels:

- **ctl** — hello/auth handshake, ping/pong.
- **chat** — glasses utterances in, streamed agent replies out. Each
  utterance runs as an embedded OpenClaw agent turn against a dedicated
  session (default key `faceclaw:glasses`), so the glasses conversation has
  continuity and shows up in normal OpenClaw session tooling.
- **mcp** — raw MCP JSON-RPC, with the *phone* as the MCP server. The phone
  serves its tool registry (`tools/list` / `tools/call`, plus
  `notifications/tools/list_changed`); the plugin is the MCP client.

The agent sees the glasses through two fixed tools:

- `glasses_list_tools` — what the glasses can do right now (the set is
  dynamic: it changes as apps open/close/focus).
- `glasses_call` — invoke one of those tools by name.

Because these are ordinary agent tools, the agent can also call them
*outside* a glasses-initiated turn (heartbeats, cron, other channels) — e.g.
pushing an alert to the lenses when a long job finishes. The phone enforces
its own gating (`proactive` tool flags, rate limits) on such calls.

## Install

```bash
cd faceclaw-agent-bridge
npm install
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/faceclaw-agent-bridge-0.1.0.tgz
```

Configure in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "faceclaw-bridge": {
        "enabled": true,
        "config": {
          "token": "<shared secret, also entered on the phone>",
          "wsBind": "0.0.0.0",
          "wsPort": 8790
        }
      }
    }
  }
}
```

Then restart the gateway. Security stance: bind to a tailscale-reachable
address and rely on the tailnet plus the bearer token; TLS is not used
(same stance as g2mirror).

On the phone, set Settings → Assistant → backend to `external` and fill in
the bridge host/port/token.

## Config

| Key | Default | Notes |
|---|---|---|
| `token` | (required) | Shared bearer token; bridge refuses to start without it |
| `wsBind` | `127.0.0.1` | Use `0.0.0.0` or a tailscale IP for real phones |
| `wsPort` | `8790` | |
| `sessionKey` | `faceclaw:glasses` | OpenClaw session used for glasses turns |
| `agentId` | default agent | |
| `turnTimeoutMs` | `120000` | |
| `toolCallTimeoutMs` | `20000` | Phone-side MCP round-trip timeout |

## Wire protocol (v1)

Text frames, one JSON object each, all with `{"v": 1, "chan": ...}`:

```
ctl:  {chan:"ctl", type:"hello", token, deviceName}          phone -> bridge
      {chan:"ctl", type:"hello-ack", serverName, sessionKey} bridge -> phone
      {chan:"ctl", type:"error", message}
      {chan:"ctl", type:"ping"|"pong", ts}
chat: {chan:"chat", type:"utterance", turnId, text, ctx}     phone -> bridge
      {chan:"chat", type:"cancel", turnId}                   phone -> bridge
      {chan:"chat", type:"text-delta", turnId, text, replace?} bridge -> phone
      {chan:"chat", type:"tool-activity", turnId, label}     bridge -> phone
      {chan:"chat", type:"turn-done", turnId, stopReason, text}
      {chan:"chat", type:"turn-error", turnId, message}
mcp:  {chan:"mcp", msg:{...MCP JSON-RPC...}}                 both directions
```

`ctx` on an utterance carries `{foregroundApp, screenOn, localTime,
headsetBattery}` for situational grounding.

`text-delta` frames are append-only unless `replace: true`, in which case
`text` is the full replacement snapshot.

## Development

The design rationale lives in the Faceclaw repo at
`notes/voice-assistant-design.md` ("External mode"). A simulated-phone test
client is in `test/fake-phone.js`:

```bash
node test/fake-phone.js ws://localhost:8790 <token> "what time is it?"
```
