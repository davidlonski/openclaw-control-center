# 🦞 OpenClaw Control Center — Documentation

> **URL:** `http://127.0.0.1:7891`
> **Source:** `~/.openclaw/workspace-general/openclaw-dashboard/`
> **Process:** Managed by LaunchAgent `ai.openclaw.dashboard`
> **Logs:** `/tmp/dashboard.log`

---

## Overview

The OpenClaw Control Center is a single-page web dashboard + backend server that combines the orchestrator and UI into one Node.js process on port `7891`. It gives full visibility and control over the OpenClaw multi-agent system: agent management, action tracking, cost analytics, gateway monitoring, Ollama model management, cron scheduling, live activity, memory search, voice notes, and agent-to-agent communication.

### Architecture

```
Browser (index.html)
    │
    │  HTTP (cookie auth)
    ▼
server.js  (:7891)
    ├── Proxies to OpenClaw Gateway (:18789) — agent sessions, tools
    ├── Proxies to Anti-Agent HQ (:8000)     — human blocker tasks
    ├── Proxies to Ollama (:11434)            — local model management
    ├── Reads ~/.openclaw/openclaw.json       — agent/channel config
    ├── Reads ~/.openclaw/cron/jobs.json      — scheduled jobs
    ├── Reads ~/.openclaw/agents/*/sessions/  — token usage & activity
    ├── Reads ~/.openclaw/logs/gateway.log    — gateway log tail
    ├── Runs healthcheck.js                   — system health checks
    ├── Runs search_native.js                 — memory search
    └── Watches config + Discord WS           — live event handling
```

---

## Authentication

The dashboard is protected by a session cookie (`oc_session`).

- **Login page:** `http://127.0.0.1:7891/login`
- **Token source:** `DASHBOARD_TOKEN` environment variable (set in LaunchAgent plist). Falls back to the gateway auth token from `openclaw.json` if not set.
- **Current token:** Set in `~/Library/LaunchAgents/ai.openclaw.dashboard.plist`
- **Session:** Cookie is `HttpOnly; SameSite=Strict` — browser-only, no JS access
- **Public endpoints** (no auth required): `/api/config`, `/login`, `/setup`, `/api/setup/check`

If you see blank/stale tabs: your session cookie is invalid. Go to `/login` and re-authenticate.

---

## Tabs

### 🤖 Agents

The default landing tab. Shows all configured agents and lets you manage them inline.

**Stats row:**
- **Total Agents** — count of agents in `openclaw.json`
- **Active Sessions** — live session count from the gateway

**Broadcast bar:**
Send a message to every active agent session simultaneously. Hit Enter or click "📢 Broadcast". Results show how many sessions received it vs. failed.

**Agent cards** (two grids: Cloud and Local):
Each card shows:
- Agent ID, emoji, name, default badge
- Current model (with inline dropdown to change it)
- Tool profile (coding / messaging / minimal) with inline selector
- Workspace path
- Session status dot (🟢 running / 🔵 done / ⚫ idle)
- Last seen timestamp and last channel
- All-time cost + session count
- Token breakdown panel (expandable): input, output, cache read/write
- **Edit Files** button — opens a modal to read/write workspace files:
  `MEMORY.md`, `USER.md`, `SOUL.md`, `AGENTS.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `learnings.md`
- **Permissions** button — opens a modal to set the tool profile and allowed/denied tool IDs

**Auto-refresh:** Every 30 seconds via `setInterval`.

---

### 💼 Business

Focused action tab. Only shows tasks that require human intervention before agents can proceed.

**Action Center:**
CRUD interface for human blockers — tasks only you can resolve.
- **Pending items** — shown with a "Resolve" button
- **Resolved items** — shown collapsed below with a "Reopen" option
- **+ Add** — inline form to create a new blocker with a title
- **✕** — delete a blocker permanently
- Uses `/api/hq/tasks?tag=human-blocker` (backed by Anti-Agent HQ at `:8000`)
- Empty state: "No active blockers. All clear! 🌿"

> **Note:** The Anti-Agent HQ backend must be running for blockers to load. Start it with `bash ~/Anti-Agent/scripts/start_hq.sh start`.

---

### 🔁 Ops

**Live Activity Feed** — a real-time stream of what all agents are doing right now.

- Shows the **last 120 messages** across all active agent session files, newest first
- **Agent filter dropdown** — focus on a single agent's activity
- **Color-coded left border** per agent — each agent gets a unique consistent color across sessions
- **Role badges:**
  - `YOU` (blue) — user messages sent to an agent
  - `AI` (green) — assistant responses
  - `TOOL→` (orange) — tool calls being made
  - `←RESULT` (purple) — tool results returned
  - `SYS` (gray) — server-level events (config reloads, gateway restarts)
- **Cost** shown inline on assistant messages
- **⏸ Pause / ▶ Resume** — freeze the feed without losing context
- **Auto-refreshes every 10 seconds** silently in the background
- **↻ Refresh** — force an immediate reload

Data sourced from: latest session `.jsonl` file per agent + server `eventLog` ring buffer.

---

### ⏱️ Cron

Lists all scheduled OpenClaw cron jobs from `~/.openclaw/cron/jobs.json`.

**Table columns:**
- **Name** — job name with live/paused/error badge
- **Agent** — `agentId` with emoji
- **Schedule** — cron expression (e.g. `0 9 * * *`), interval in minutes, or one-shot datetime
- **Last Run** — timestamp of most recent execution
- **Manual** — "▶ Run" button to trigger the job immediately via `openclaw cron run --id <id>`

Errors are shown as a red badge with consecutive failure count.

---

### ⚙️ System

System health and infrastructure overview.

**System Health card:**
Runs `healthcheck.js` via non-blocking `spawn` (up to 20s timeout). Shows:
- Overall status: OK / WARN / CRIT
- Per-check rows: click any row to see full detail in the adjacent card
- "↻ Run Now" to manually re-run the healthcheck

**Check Details card:**
Shows the full output and metadata for whichever health check row you last clicked.

**Health Log card:**
Shows the last 100 lines of `logs/healthcheck.log`. Parses individual JSON run blocks and renders them as expandable history entries.

---

### 🌐 Gateway

Dedicated monitoring and control for the OpenClaw gateway service.

**Service Status card:**
- Running / stopped status badge
- LaunchAgent loaded state (`ai.openclaw.gateway`)
- PID (when running)
- Port (18789), bind mode (loopback/tailscale)
- WebSocket probe URL
- Log file path

**Configuration card:**
- Auth mode and token (obfuscated as `●●●●●●●●`)
- Tailscale mode
- Denied commands list (shown as red badges)

**Controls:**
- **↺ Soft Reload** — sends `SIGUSR1` to the gateway process (in-place config reload, zero downtime)
- **⚡ Hard Restart** — stop then start via launchctl (brief downtime)
- **⏹ Stop** — `launchctl stop ai.openclaw.gateway` (KeepAlive will restart it)
- **▶ Start** — `launchctl start ai.openclaw.gateway`
- **🔄 Reload Config** — signals the dashboard server to re-read `openclaw.json`

**Gateway Log card:**
Full-width tail of `~/.openclaw/logs/gateway.log` (last 150 lines), color-coded:
- 🟠 Orange — `[gateway]` tagged lines
- 🟡 Yellow — warnings
- 🔴 Red — errors, failures, critical messages

---

### 🦙 Ollama

Dedicated local model management tab.

**Pull New Model card:**
- Enter a model name (e.g. `llama3.2`, `qwen2.5-coder:7b`)
- "📥 Pull" streams the download via NDJSON with a live progress log
- Status dot: idle → pulling → done/error

**Models card:**
Lists all locally available Ollama models from `http://127.0.0.1:11434/api/tags`.
Each model card shows:
- Model name, family, parameter size, quantization level
- Disk size
- **🗑 Delete** button — removes the model with a confirm prompt

**↻ Refresh** reloads the model list from Ollama.

---

### 💰 Cost

Full cost analytics tab across all agents and all time.

**Today's Spend card:**
- Large dollar figure for the current day's total spend (using device timezone)
- Date and timezone label (e.g. "Sunday, April 12 · America/New_York")
- Top agents that spent today listed below

**All-Time Totals card:**
- Grand total API cost all-time (large green figure)
- Cache write investment (separate from billed cost)
- Total sessions, active agents, days tracked

**Cumulative Cost Over Time chart:**
- Canvas line chart with orange gradient fill
- Shows total spend growth from first session to today
- Y-axis: USD amounts, X-axis: date labels (MM-DD)
- Date range label shown in the card header

**Cost by Agent table:**
Sorted by all-time spend descending. Each row shows:
- Agent name (with `local` badge for local-model agents)
- Horizontal bar chart (relative to top spender)
- All-time cost (right-aligned)
- Today's cost badge (only shown if > $0 today)
- Token breakdown: input/output in thousands
- Session count
- Last active timestamp

**↻ Refresh** reloads all three sections.

---

### 🧠 Memory

Search and statistics for the agent memory/session database.

**Stats row (4 cards):**
- Total Messages indexed
- Indexed (embedded vectors)
- Sessions (number of agent session files)
- Latest Message timestamp

Sourced from `search_native.js --stats`.

**Search Chat History:**
- **Query input** — Enter to search
- **Mode:** Vector (semantic) or Keyword (substring)
- **Role filter:** All / You (user) / AI (assistant)
- **Limit:** 5 / 10 / 20 results
- Results show: agent, source (chat/memory), role, timestamp, match score, text snippet

Search calls `search_native.js` with the query and mode flags. Vector search uses sqlite-vec embeddings generated by Ollama.

---

### 🎙️ Voice Notes

Record, transcribe, and optionally save voice notes to Notion.

**Pipeline Status card:**
Shows availability of each component:
- mlx-whisper (local Apple Silicon transcription)
- OpenAI Whisper (cloud fallback, requires `OPENAI_API_KEY`)
- Notion (requires `NOTION_API_KEY` + `NOTION_DATABASE_ID` in env)
- ffmpeg (for audio conversion)

**Record card:**
1. Click "⏺ Record" — browser requests microphone access, records WebM audio
2. Click "⏹ Stop" — recording stops, "✦ Transcribe" button activates
3. Click "✦ Transcribe":
   - Audio is POSTed to `/api/record` → saved to `data/recording_<ts>.webm`
   - Server converts to 16kHz WAV via ffmpeg
   - mlx-whisper transcribes locally (uses `mlx-community/whisper-large-v3-turbo`)
   - Result shown in the transcript textarea
   - Optional: "Save to Notion" checkbox — saves to the Voice Notes Notion database

**Saved Notes list:**
Shows the 30 most recent transcripts from `data/transcripts/note_*.json`, newest first. Each shows title, timestamp, Notion badge if saved, and up to 300 chars of transcript text.

---

### 🔗 Agent Comms

Direct agent-to-agent messaging and message log.

**Send Message card:**
- **From** — dashboard (you) or any agent
- **To** — any configured agent
- **Message** — free text, injected into the target agent's active session via `sessions_send`
- Uses session key format `agent:<agentId>:main`

**Agent Directory card:**
Lists all agents with a "Message →" shortcut button that pre-fills the "To" selector.

**Message Log:**
Persistent log of all relay messages (`data/agent-comms.jsonl`). Shows:
- Timestamp, From → To
- Message text
- Status (sent / failed)

"↻ Refresh" reloads the log. "🗑 Clear" wipes the log file.

---

## API Reference

All endpoints require a valid `oc_session` cookie unless noted. The frontend's global fetch interceptor automatically redirects to `/login` on any `401`.

### Config & Setup

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Dashboard config (ports, Discord presence, sync script). **Public.** |
| GET | `/api/setup/check` | First-run check: has gateway token, agents, Discord. **Public.** |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/agents` | All agents with model, workspace, emoji, tools profile |
| GET | `/api/agents/usage` | Per-agent token cost, sessions, last activity |
| POST | `/api/set-agent-model` | `{ agentId, model }` — update model, saves to `openclaw.json`, reloads gateway |
| POST | `/api/set-agent-tools` | `{ agentId, profile?, allow?, deny? }` — update tool config |
| POST | `/api/set-agent-workspace` | `{ agentId, workspace }` — reassign workspace path |
| GET | `/api/agent-file?agentId=&file=` | Read a workspace file |
| POST | `/api/agent-file` | `{ agentId, file, content }` — write a workspace file |

### Sessions & Gateway

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | Live session list from gateway (last 20) |
| GET | `/api/health` | Gateway + Ollama status, full token usage stats |
| POST | `/api/reload-config` | Soft reload (SIGUSR1 to gateway) |
| POST | `/api/restart-agent` | Hard restart (`openclaw gateway restart`) |
| POST | `/api/broadcast` | `{ message }` — inject message into all active sessions |

### Channels

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/channels` | Discord channel list with current agent bindings |
| POST | `/api/set-channel-agent` | `{ channelId, agentId }` — rebind a channel |

### Gateway Tab

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/gateway/status` | Service status (PID, port, bind mode, LaunchAgent state, config) |
| GET | `/api/gateway/log` | Last 150 lines of `~/.openclaw/logs/gateway.log` |
| GET | `/api/gateway/usage-cost` | 30-day usage cost (via `openclaw` CLI, fallback to local aggregation) |
| POST | `/api/gateway/stop` | `launchctl stop ai.openclaw.gateway` |
| POST | `/api/gateway/start` | `launchctl start ai.openclaw.gateway` |
| POST | `/api/gateway/soft-restart` | Send `SIGUSR1` to gateway process (in-place reload) |

### Cost Analytics

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cost` | Per-agent costs, daily cumulative series, totals. Uses device timezone for day bucketing. |

Response fields:
```json
{
  "ok": true,
  "timezone": "America/New_York",
  "today": "2026-04-12",
  "totals": { "cost": 4.82, "costToday": 1.56, "cacheWriteTotal": 0.88, "sessions": 64 },
  "agents": [{ "id": "main", "cost": 2.19, "costToday": 1.56, "sessions": 12, "input": 0, "output": 0, "lastTs": 1776041674281 }],
  "cumulative": [{ "day": "2026-03-29", "cost": 0.34, "cumulative": 0.34, "cacheWrite": 0.12 }]
}
```

### System Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/healthcheck` | Run `healthcheck.js` (non-blocking spawn, 20s timeout) |
| GET | `/api/healthcheck/log` | Last 100 lines of `logs/healthcheck.log` |
| POST | `/api/sync-repo` | Run sync script (30s timeout) |

### Memory

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memory/stats` | Total messages, sessions, embedding count |
| GET | `/api/memory/search?q=&mode=&role=&limit=` | Search agent memory. `mode`: `vector` or `keyword` |

### Cron

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cron` | All jobs from `~/.openclaw/cron/jobs.json` |
| POST | `/api/cron/run` | `{ jobId }` — trigger a job immediately via `openclaw cron run` |

### Live Activity Feed

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/activity` | Last 120 events across all agents (newest first). Reads latest session `.jsonl` per agent + server event log. |

Response event fields:
```json
{ "agent": "main", "role": "assistant", "ts": 1776041674281, "snippet": "Here's the rundown...", "toolName": null, "cost": 0.0042 }
```
Roles: `user`, `assistant`, `toolCall`, `toolResult`, `system`

### Ollama

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ollama/models` | List all local models from Ollama |
| DELETE | `/api/ollama/delete` | `{ name }` — delete a local model |
| POST | `/api/ollama/pull` | `{ name }` — stream pull progress (NDJSON) |

### Anti-Agent HQ (Human Blockers)

All endpoints proxy to `http://127.0.0.1:8000`. The HQ backend must be running (`bash ~/Anti-Agent/scripts/start_hq.sh start`).

| Method | Path | Proxies to |
|--------|------|------------|
| GET | `/api/hq/health` | `/api/v1/health` |
| GET | `/api/hq/overview` | `/api/v1/business/overview` |
| GET/POST/PATCH/DELETE | `/api/hq/tasks[/*]` | `/api/v1/tasks[/*]` |

> **Known fix applied:** The `/api/v1/tasks?tag=` filter uses SQLite-compatible `LIKE '%"tag"%'` instead of the MySQL-only `json_contains()`.

### Agent Comms

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/relay` | `{ from, to, message }` — send to agent session, log to `data/agent-comms.jsonl` |
| GET | `/api/comms?limit=` | Read comms log (default 100 entries) |
| DELETE | `/api/comms` | Clear comms log |

### Voice Notes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/record` | Raw audio body (WebM) → saves to `data/recording_<ts>.webm` |
| POST | `/api/transcribe` | `{ audioPath, saveNotion?, title? }` → transcribe + optionally save to Notion |
| GET | `/api/transcripts` | Last 30 saved note JSON files from `data/transcripts/` |
| GET | `/api/audio-config` | Check availability of ffmpeg, mlx-whisper, OpenAI key, Notion key |

### n8n Bridge

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/n8n/trigger` | `{ workflowWebhook, agentId, payload, sessionKey? }` — fire an n8n workflow |
| POST | `/api/n8n/callback` | Receives result from n8n, injects into agent session |
| GET | `/api/n8n/status` | Checks if n8n is running at `:5678` |

### Orchestrator (internal)

These endpoints are used internally and no longer surfaced in the UI.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/orch/status` | Uptime, gateway alive, event count, PID |
| GET | `/api/orch/events?limit=` | Recent orchestrator event log (max 200) |
| POST | `/api/orch/trigger/config-reload` | Orchestrator-level config reload |
| POST | `/api/orch/trigger/gateway-restart` | Orchestrator-level gateway restart |

---

## Background Services (watchers)

### `watchers/fileWatcher.js`

Watches `openclaw.json` and workspace permission files for changes. On change:
- Triggers `onConfigChange` → `handleConfigChange.js` (reloads config, soft-signals gateway)
- Triggers `onPermissionChange` → `handlePermissionChange.js`

### `watchers/discordWatcher.js`

Maintains a persistent WebSocket connection to Discord's gateway (`wss://gateway.discord.gg/?v=10`).
- Listens for `CHANNEL_CREATE`, `CHANNEL_DELETE`, `CHANNEL_UPDATE` events
- Triggers corresponding orchestrator handlers to update `openclaw.json` bindings
- Auto-reconnects with exponential backoff (5s → 60s max) on disconnect
- Does **not** reconnect on code `1000` (normal close) or `4004` (auth failure)

---

## Orchestrator Handlers

| File | Triggered by | What it does |
|------|-------------|--------------|
| `handlers/handleConfigChange.js` | File watcher on `openclaw.json` | Reloads config, signals gateway |
| `handlers/handlePermissionChange.js` | File watcher on permission files | Updates tool access rules |
| `handlers/handleChannelCreate.js` | Discord `CHANNEL_CREATE` | Adds a binding in `openclaw.json` for the new channel |
| `handlers/handleChannelDelete.js` | Discord `CHANNEL_DELETE` | Removes the binding for the deleted channel |

---

## Self-Healing

The server checks gateway health every 60 seconds. If the gateway fails to respond 3 times in a row, it automatically calls `gateway.restart()` and logs a `self_heal` event to the orchestrator ring buffer.

---

## Key File Paths

| Path | Purpose |
|------|---------|
| `server.js` | Main server process |
| `index.html` | Single-page dashboard UI |
| `healthcheck.js` | System health check script (run on demand) |
| `search_native.js` | Memory search CLI (vector + keyword) |
| `sync.py` | Memory embedding sync (run by LaunchAgent every 5min) |
| `load-monitor.js` | In-process load tracking module |
| `utils/gateway.js` | Gateway HTTP client + restart helper |
| `utils/config.js` | Config read/write helpers |
| `utils/logger.js` | Structured logger |
| `data/agent-comms.jsonl` | Agent relay message log |
| `data/transcripts/` | Saved voice note JSON files |
| `logs/healthcheck.log` | Healthcheck run history |

---

## External Services

| Service | Port | Start command | Purpose |
|---------|------|--------------|---------|
| OpenClaw Gateway | 18789 | `launchctl start ai.openclaw.gateway` | Agent sessions, tools |
| Anti-Agent HQ | 8000 | `bash ~/Anti-Agent/scripts/start_hq.sh start` | Human blocker tasks |
| Ollama | 11434 | `ollama serve` | Local model inference + management |
| n8n | 5678 | `launchctl start ai.openclaw.n8n` | Workflow automation |

---

## Environment Variables

Set in `~/Library/LaunchAgents/ai.openclaw.dashboard.plist`:

| Variable | Description |
|----------|-------------|
| `DASHBOARD_TOKEN` | Auth token for the dashboard (independent of gateway token) |
| `NOTION_API_KEY` | Notion integration secret for voice note saves |
| `NOTION_DATABASE_ID` | Target Notion database for voice notes |
| `HOME` | User home directory |
| `PATH` | Binary search path for node, ffmpeg, openclaw |

Optional (not currently set in plist):

| Variable | Description |
|----------|-------------|
| `DASHBOARD_PORT` | Override port (default: `7891`) |
| `OPENCLAW_CONFIG` | Override config path (default: `~/.openclaw/openclaw.json`) |
| `OPENCLAW_SYNC_SCRIPT` | Override sync script path |
| `OPENAI_API_KEY` | OpenAI Whisper fallback for voice transcription |
| `N8N_URL` | Override n8n URL (default: `http://127.0.0.1:5678`) |

---

## LaunchAgent

```
Label:     ai.openclaw.dashboard
Binary:    /usr/local/bin/node server.js
WorkDir:   ~/.openclaw/workspace-general/openclaw-dashboard/
Stdout:    /tmp/dashboard.log
Stderr:    /tmp/dashboard.log
KeepAlive: true (auto-restart on crash)
RunAtLoad: true (starts on login)
```

**Manage:**
```bash
# Status
launchctl list | grep ai.openclaw.dashboard

# Restart
launchctl unload ~/Library/LaunchAgents/ai.openclaw.dashboard.plist
launchctl load ~/Library/LaunchAgents/ai.openclaw.dashboard.plist

# Logs
tail -f /tmp/dashboard.log
```

---

## Auto-Refresh Behavior

| Tab | Refresh trigger | Interval |
|-----|----------------|----------|
| Agents | Tab click + `setInterval` | 30s |
| Ops (Activity Feed) | Tab click + background timer | 10s |
| Gateway | Tab click + manual ↻ | On-demand |
| Cost | Tab click + manual ↻ | On-demand |
| Ollama | Tab click + manual ↻ | On-demand |
| System | Tab click (health runs on click) | On-demand |
| All others | Tab click only | On-demand |

The global `loadAll()` function (called every 30s) only refreshes Agents data. All other tabs only reload when navigated to.

---

## Known Quirks

- **Memory search** uses sqlite-vec embeddings generated by Ollama. If Ollama isn't running, vector search returns no results; keyword search still works.
- **Voice transcription** requires mlx-whisper (`pip install mlx-whisper`). Falls back to showing a warning if unavailable.
- **Healthcheck** takes up to ~15s to run. The System tab shows a spinner during that time — the rest of the UI remains responsive (non-blocking spawn).
- **Cron jobs** are read directly from `~/.openclaw/cron/jobs.json`. The dashboard doesn't create/edit jobs — use `openclaw cron add` for that.
- **Activity Feed** reads the most recently modified `.jsonl` session file per agent. It will not show older archived sessions.
- **Cost tab** uses message timestamps inside the JSONL (not file modification time) to correctly bucket spend by calendar day in the device's local timezone.
- **HQ Blockers** require the Anti-Agent HQ backend (`http://127.0.0.1:8000`) to be running. If offline, the Business tab shows "HQ Blockers Offline". Start it with `bash ~/Anti-Agent/scripts/start_hq.sh start`.
- **Gateway Log** tails `~/.openclaw/logs/gateway.log`. If the gateway has never written to this path, the log viewer will be empty.
- **Ollama pull** streams NDJSON from the Ollama API. Large models (>10GB) will show progress in the pull log panel for several minutes.
