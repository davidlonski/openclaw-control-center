# 🦞 OpenClaw Control Center

A self-hosted dashboard for your OpenClaw multi-agent system. Agents tab, memory search, cost tracking, cron, Ollama management, voice notes, gateway controls, and more.

> Full docs: [DASHBOARD_DOCS.md](./DASHBOARD_DOCS.md)

---

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and gateway running
- Node.js v22+
- `ffmpeg` (optional, for voice notes): `brew install ffmpeg`

---

## Quick Install

```bash
# 1. Clone into your OpenClaw workspace
git clone https://github.com/davidlonski/openclaw-control-center.git \
  ~/.openclaw/workspace-general/openclaw-dashboard

# 2. Install dependencies
cd ~/.openclaw/workspace-general/openclaw-dashboard
npm install

# 3. Start the server
node server.js
# → http://127.0.0.1:7891
```

The dashboard reads your existing `~/.openclaw/openclaw.json` automatically — no extra config needed to get started.

---

## Authentication

On first visit, you'll be prompted for a token. The dashboard uses your **gateway auth token** from `openclaw.json` by default, or you can set a separate `DASHBOARD_TOKEN` environment variable.

```bash
# Optional: set a custom dashboard token
export DASHBOARD_TOKEN="your-token-here"
node server.js
```

---

## Run as a background service (LaunchAgent on macOS)

```bash
# Create the LaunchAgent plist
cat > ~/Library/LaunchAgents/ai.openclaw.dashboard.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/YOUR_USERNAME/.openclaw/workspace-general/openclaw-dashboard/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/dashboard.log</string>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/.openclaw/workspace-general/openclaw-dashboard</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/YOUR_USERNAME</string>
    </dict>
</dict>
</plist>
EOF

# Replace YOUR_USERNAME, then load it
launchctl load ~/Library/LaunchAgents/ai.openclaw.dashboard.plist
```

---

## Optional Integrations

| Feature | Env Var | Notes |
|---------|---------|-------|
| Voice transcription | `OPENAI_API_KEY` | Whisper API |
| Notion voice notes | `NOTION_API_KEY` + `NOTION_DATABASE_ID` | Push transcripts to Notion |
| Memory search | Ollama running at `:11434` | `snowflake-arctic-embed2` model |

---

## Features

- **Agents** — live status, cost, model + workspace switcher, Discord channel routing
- **Memory Search** — semantic + keyword search across all agent chat history, filter by agent or source
- **Cost** — daily spend chart, per-agent breakdown
- **Cron** — scheduled jobs, run now, enable/disable
- **System** — healthcheck with history log
- **Gateway** — status, config, log tail, restart/stop
- **Ollama** — model list, pull with progress, delete
- **Voice Notes** — record, transcribe, save to Notion
- **Agent Comms** — send relay messages between agents, view message log
- **Ops** — live activity feed across all agents
- **Business** — Anti-Agent HQ integration (optional)
