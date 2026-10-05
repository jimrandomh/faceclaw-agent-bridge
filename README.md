# faceclaw-agent-bridge

OpenClaw plugin that bridges [Faceclaw](https://github.com/jimrandomh) (an
Android shell for Even Realities G2 smart glasses) to an OpenClaw agent.

With this installed, "Hey Even" queries spoken on the glasses are answered by
your own long-running OpenClaw agent instead of a bare LLM API call, the
agent can use the glasses' tools (show alerts, read notifications, control
media, type into open apps, ...) while it works, and it can also reach the
glasses *proactively* — e.g. push an alert to the lenses when a long job
finishes.

## How it fits together

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

Because these are ordinary agent tools, the agent can call them *outside* a
glasses-initiated turn (heartbeats, cron, other channels). The phone
enforces its own gating on such calls: only tools marked proactive-safe, an
on/off setting, and a rate limit.

## Setup

The instructions below are written to be followable end-to-end by an
OpenClaw agent running on the host, including configuring the phone over
adb. Human setup works the same way; the phone can alternatively be
configured by hand in the glasses Settings UI (see "Phone setup, manual").

Prerequisites:

- An OpenClaw gateway on this host. Use the same Node version the gateway
  runs with (OpenClaw enforces a minimum; if `openclaw` prints a Node
  version error, switch with `nvm use <version>` first).
- The phone reachable from this host's network, normally by having both on
  the same tailnet.
- For the adb path: `adb` installed, the phone plugged in with USB
  debugging enabled and authorized, and a checkout of the faceclaw repo
  (for `scripts/pull_config.sh` / `scripts/push_config.sh`). The Faceclaw
  app must already be installed on the phone.

### 1. Install the plugin (OpenClaw host)

From this repository:

```bash
npm install
openclaw plugins install --force "$PWD"
```

OpenClaw copies the directory as-is, including `node_modules`, so run
`npm install` first. `--force` overwrites any previous install, and on
OpenClaw 2026.8.1+ it also confirms the non-ClawHub source; without it the
install prompts, or is cancelled outright when there's no TTY. To install an
updated build, rerun both commands.

OpenClaw will warn that the manifest id `faceclaw-bridge` differs from the
npm package name `faceclaw-agent-bridge` and that it is using the manifest id
as the config key. That's expected; `faceclaw-bridge` is the key used below.

### 2. Configure and start it

Generate a shared token and configure the plugin. `wsBind` must be an
address the phone can reach — `0.0.0.0` is simplest when the host is only
reachable over a tailnet; otherwise bind the tailscale IP specifically.

```bash
TOKEN=$(openssl rand -hex 24)
openclaw config set plugins.entries.faceclaw-bridge.enabled true
openclaw config set plugins.entries.faceclaw-bridge.config.token "$TOKEN"
openclaw config set plugins.entries.faceclaw-bridge.config.wsBind 0.0.0.0
openclaw config set plugins.entries.faceclaw-bridge.config.wsPort 8790
openclaw gateway restart
```

Verify it came up:

```bash
openclaw plugins inspect faceclaw-bridge --runtime --json | grep -E '"status"|glasses_'
# expect: "status": "loaded", plus the two glasses_* tool names
lsof -iTCP:8790 -sTCP:LISTEN   # the gateway process should be listening
```

The gateway log also prints `[faceclaw-bridge] listening on ws://...` on
startup, and `[faceclaw-bridge] phone connected: <name>` when the phone
dials in.

### 3. Make sure the agent has model auth

Bridge turns run as normal agent turns, so the agent must be able to reach
its model. `openclaw models status` should show auth for your configured
provider; if it lists the provider under "Missing auth", fix that first
(e.g. `openclaw models auth login --provider anthropic`, or set an API
key).

### 4. Phone setup, automated over adb

Faceclaw stores its settings in Android SharedPreferences; the faceclaw
repo has scripts to pull/edit/push them through adb. The relevant keys:

| Key | Type | Value |
|---|---|---|
| `assistant.backend` | string | `external` |
| `assistant.bridgeHost` | string | this host's address as seen from the phone, e.g. `tailscale ip -4` output or the MagicDNS hostname |
| `assistant.bridgePort` | string | `8790` (must match `wsPort`; note: string, not int) |
| `assistant.bridgeToken` | string | the `$TOKEN` generated above |
| `assistant.allowProactive` | boolean | `true` to let the agent reach the glasses outside conversations (default true; omit unless turning it off) |

From the faceclaw repo checkout, with the phone attached:

```bash
adb devices                 # confirm the device is present and authorized
./scripts/pull_config.sh    # writes ./faceclaw_settings.xml
```

The pulled file is a flat `<map>` of nodes like:

```xml
<string name="assistant.bridgeHost">100.68.94.67</string>
<boolean name="assistant.allowProactive" value="true" />
```

Settings that have never been set are absent; the pull script appends
commented-out placeholder nodes for every known key, so editing is usually
just uncommenting and filling in. Add or update the four keys above (host,
port, token, and `assistant.backend` set to `external`), then:

```bash
./scripts/push_config.sh
# push_config.sh force-stops the app so it can't overwrite the pushed file;
# relaunch it afterwards:
adb shell monkey -p com.faceclaw.app -c android.intent.category.LAUNCHER 1
```

**The pulled file contains the user's API keys and tokens in plain text.
Treat it as a secret: don't commit it, log it, or paste it anywhere.**
Faceclaw's `.gitignore` already covers the default filename inside that
repo.

### 5. Phone setup, manual (alternative)

On the glasses: Settings → Assistant → set *Assistant backend* to "My own
agent (bridge)", then fill in *Bridge host*, *Bridge port*, and *Bridge
token*. The bridge connection starts as soon as host and token are set
(and re-dials automatically with backoff whenever it drops).

### 6. Verify end to end

1. **Connection**: after the app relaunches, the gateway log shows
   `[faceclaw-bridge] phone connected` (give it a few seconds; the phone
   re-dials with backoff up to 60s).
2. **Tools direction** (no glasses interaction needed): ask the agent — on
   any channel — to "list the glasses tools", or invoke directly:

   ```bash
   curl -s -X POST http://127.0.0.1:<gateway-port>/tools/invoke \
     -H "Authorization: Bearer <gateway token>" \
     -H "Content-Type: application/json" \
     -d '{"tool":"glasses_call","args":{"tool":"glasses.show_alert","args":{"text":"Bridge is up"}}}'
   ```

   The alert should appear on the lenses (screen need not be on for the
   call to succeed as long as the app is running).
3. **Chat direction**: say "Hey Even", ask something. The reply should
   stream onto the lenses, and the turn appears in the `faceclaw:glasses`
   OpenClaw session (`openclaw sessions list`).

### Troubleshooting

- *Install fails with "npm pack metadata read produced incomplete package
  metadata"*: you used the `npm pack` + `npm-pack:` install route with npm
  12 on OpenClaw 2026.7.x, which can't parse npm 12's `npm pack --json`
  output (fixed in 2026.8.1). Use the directory install from step 1.
- *Phone never connects*: check host/port/token on the phone; check the
  phone can reach the host (`tailscale ping` from another device); check
  `wsBind` isn't `127.0.0.1`; watch the gateway log for
  `[faceclaw-bridge] auth failure` (token mismatch).
- *`glasses_*` tools error with "Glasses are not connected"*: the phone
  isn't currently dialed in (app killed, network change mid-backoff, or
  bridge settings incomplete on the phone).
- *Turns fail with a provider/auth error*: step 3.
- *Bridge refuses to start ("no token configured")*: step 2's config
  didn't land under `plugins.entries.faceclaw-bridge.config`.
- A simulated phone for testing without hardware is in
  `test/fake-phone.js`:
  `node test/fake-phone.js ws://localhost:8790 $TOKEN "what time is it?"`.
  It serves two fake glasses tools and prints streamed reply frames.

## Config reference

| Key | Default | Notes |
|---|---|---|
| `token` | (required) | Shared bearer token; bridge refuses to start without it |
| `wsBind` | `127.0.0.1` | Use `0.0.0.0` or a tailscale IP for real phones |
| `wsPort` | `8790` | |
| `sessionKey` | `faceclaw:glasses` | OpenClaw session used for glasses turns |
| `agentId` | default agent | |
| `turnTimeoutMs` | `120000` | |
| `toolCallTimeoutMs` | `20000` | Phone-side MCP round-trip timeout |

Security stance: bind to a tailscale-reachable address and rely on the
tailnet plus the bearer token; TLS is not used (same stance as g2mirror).

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
`notes/voice-assistant-design.md` ("External mode").
