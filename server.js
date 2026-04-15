#!/usr/bin/env node
/**
 * OpenClaw Control Center
 * Dashboard UI + Orchestrator combined — single process, single port.
 * Runs at http://127.0.0.1:7891
 */

"use strict";

const http    = require("http");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");
const { execSync, spawn } = require("child_process");

// ── Orchestrator modules ──────────────────────────────────────────────────────
const log      = require("./utils/logger");
const gateway  = require("./utils/gateway");
const cfg      = require("./utils/config");
const router   = require("./router");
const monitor  = require("./load-monitor");
const pipeline = require("./pipeline-engine");

const handleConfigChange     = require("./handlers/handleConfigChange");
const handlePermissionChange = require("./handlers/handlePermissionChange");
const handleChannelCreate    = require("./handlers/handleChannelCreate");
const handleChannelDelete    = require("./handlers/handleChannelDelete");
const startFileWatcher       = require("./watchers/fileWatcher");
const startDiscordWatcher    = require("./watchers/discordWatcher");

// ── n8n Config ────────────────────────────────────────────────────────────────
const N8N_URL = process.env.N8N_URL || "http://127.0.0.1:5678";

// ── Config ────────────────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.DASHBOARD_PORT || "7891");
const CONFIG_PATH      = process.env.OPENCLAW_CONFIG || path.join(process.env.HOME, ".openclaw/openclaw.json");
// ── Dynamic config (read from openclaw.json at startup + on reload) ───────────
function loadDynamicConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const gwPort  = c.gateway?.port || 18789;
    const gwToken = c.gateway?.auth?.token || process.env.OPENCLAW_TOKEN || "";
    const botToken = c.channels?.discord?.accounts?.default?.token
                  || c.channels?.discord?.token
                  || process.env.DISCORD_BOT_TOKEN || "";
    // First guild ID found in bindings, or from env
    const guildIds = (c.bindings || [])
      .map(b => b.match?.peer?.id)
      .filter(Boolean);
    // Pull from guild config keys instead
    const discordGuilds = c.channels?.discord?.accounts?.default?.guilds || {};
    const guildId = Object.keys(discordGuilds)[0]
                 || process.env.DISCORD_GUILD_ID || "";
    return { gwPort, gwToken, botToken, guildId,
             gateway: `http://127.0.0.1:${gwPort}` };
  } catch(e) {
    return { gwPort: 18789, gwToken: "", botToken: "", guildId: "",
             gateway: "http://127.0.0.1:18789" };
  }
}
let dynCfg = loadDynamicConfig();

// Sync script — configurable via env, falls back to first git repo found
const SYNC_SCRIPT = process.env.OPENCLAW_SYNC_SCRIPT
  || path.join(process.env.HOME, "Fredrick-CLAW/sync.sh");

const HEALTHCHECK_JS   = path.join(__dirname, "healthcheck.js");
const HEALTHCHECK_LOG  = path.join(__dirname, "logs/healthcheck.log");
const DATA_DIR         = path.join(__dirname, "data");
const TRANSCRIPTS_DIR  = path.join(DATA_DIR, "transcripts");
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY  || "";
const NOTION_API_KEY   = process.env.NOTION_API_KEY  || "";
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || "";
const COMMS_LOG        = path.join(__dirname, "data", "agent-comms.jsonl");

[DATA_DIR, TRANSCRIPTS_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch {} });

// ── Orchestrator event log (ring buffer, last 200) ────────────────────────────
const eventLog = [];
function logEvent(event) {
  eventLog.push({ ts: new Date().toISOString(), ...event });
  if (eventLog.length > 200) eventLog.shift();
}

// ── Orchestrator handlers ─────────────────────────────────────────────────────
const handlers = {
  onConfigChange:     (f) => handleConfigChange(f).catch(e => log.error("handleConfigChange threw", { e: e.message })),
  onPermissionChange: (f) => handlePermissionChange(f).catch(e => log.error("handlePermissionChange threw", { e: e.message })),
  onChannelCreate:    (c) => handleChannelCreate(c).catch(e => log.error("handleChannelCreate threw", { e: e.message })),
  onChannelDelete:    (c) => handleChannelDelete(c).catch(e => log.error("handleChannelDelete threw", { e: e.message })),
  onChannelUpdate:    (c) => { log.event("Channel updated (no action taken)", { id: c.id, name: c.name }); },
};

const wrappedHandlers = {
  onConfigChange:     (f) => { logEvent({ type: "config_change", file: path.basename(f) }); return handlers.onConfigChange(f); },
  onPermissionChange: (f) => { logEvent({ type: "permission_change" }); return handlers.onPermissionChange(f); },
  onChannelCreate:    (c) => { logEvent({ type: "channel_create", id: c.id, name: c.name }); return handlers.onChannelCreate(c); },
  onChannelDelete:    (c) => { logEvent({ type: "channel_delete", id: c.id, name: c.name }); return handlers.onChannelDelete(c); },
  onChannelUpdate:    (c) => { logEvent({ type: "channel_update", id: c.id, name: c.name }); return handlers.onChannelUpdate(c); },
};

// ── Audio helpers ─────────────────────────────────────────────────────────────
async function transcribeAudio(audioPath) {
  // Use local mlx-whisper (Apple Silicon GPU) — no API key needed
  return new Promise((resolve, reject) => {
    const script = [
      "import mlx_whisper, json, sys",
      `result = mlx_whisper.transcribe("${audioPath}", path_or_hf_repo="mlx-community/whisper-large-v3-turbo")`,
      "print(result['text'].strip())"
    ].join("\n");
    const proc = require("child_process").spawn("/usr/local/bin/python3", ["-c", script]);
    let out = "", err = "";
    proc.stdout.on("data", d => out += d);
    proc.stderr.on("data", d => err += d);
    proc.on("close", code => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(err || "mlx-whisper failed"));
    });
  });
}

async function saveToNotion(title, content, tags = []) {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) throw new Error("Notion not configured");
  const VOICE_NOTES_DB = "3348a3bf-fe2f-8067-a728-e719ef6344b4";
  const body = JSON.stringify({
    parent: { database_id: VOICE_NOTES_DB },
    properties: {
      Name:             { title: [{ text: { content: title } }] },
      "Date of Meeting": { date: { start: new Date().toISOString().split('T')[0] } },
      "Meeting Type":   { select: { name: "Voice Note" } }
    },
    children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content } }] } }]
  });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.notion.com", path: "/v1/pages", method: "POST",
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function convertAudio(inputPath, outputPath) {
  return new Promise(resolve => {
    const proc = spawn("/opt/homebrew/bin/ffmpeg", ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", outputPath]);
    proc.on("close", code => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

// ── Agent comms helpers ───────────────────────────────────────────────────────
function logComms(entry) {
  try { fs.appendFileSync(COMMS_LOG, JSON.stringify(entry) + "\n"); } catch {}
}
function readCommsLog(limit = 100) {
  try {
    const lines = fs.readFileSync(COMMS_LOG, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

async function resolveSessionKey(agentId) {
  return `agent:${agentId}:main`;
}

// ── Token usage calculator ────────────────────────────────────────────────────
function calcTotalUsage() {
  const agentsDir = path.join(process.env.HOME, ".openclaw/agents");
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  let cost = 0, costToday = 0, cacheWriteCost = 0;
  let sessions = 0, responses = 0;
  let lastPromptCost = 0, lastPromptTs = 0;
  const today = new Date().setHours(0,0,0,0);
  try {
    for (const agent of fs.readdirSync(agentsDir)) {
      const sessDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessDir)) continue;
      for (const file of fs.readdirSync(sessDir).filter(f => f.match(/\.jsonl(\.reset\..*)?$/))) {
        sessions++;
        const filePath = path.join(sessDir, file);
        const lines = fs.readFileSync(filePath, "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "message") {
              const usage = obj.message?.usage;
              if (usage) {
                // Use message timestamp, not file mtime, for "is today" check
                const rawTs    = obj.timestamp || obj.message?.timestamp || obj.ts || 0;
                const lineTs   = typeof rawTs === "string" ? new Date(rawTs).getTime() : (rawTs || 0);
                const isToday  = lineTs && (new Date(lineTs).setHours(0,0,0,0) === today);

                // Token counts
                input      += usage.input      || 0;
                output     += usage.output     || 0;
                cacheRead  += usage.cacheRead  || 0;
                cacheWrite += usage.cacheWrite || 0;

                // Cost: separate actual usage cost from cache write investment
                const costObj       = usage.cost || {};
                const lineCacheWrite = costObj.cacheWrite || 0;
                const lineUsageCost  = (costObj.input || 0) + (costObj.output || 0) + (costObj.cacheRead || 0);

                cost            += lineUsageCost;
                cacheWriteCost  += lineCacheWrite;
                if (isToday) costToday += lineUsageCost;
                if (lineTs > lastPromptTs) { lastPromptTs = lineTs; lastPromptCost = lineUsageCost; }
                responses++;
              }
            }
          } catch {}
        }
      }
    }
  } catch {}
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite, cost, costToday, cacheWriteCost, lastPromptCost, sessions, responses };
}


function calcUsageByAgent() {
  const agentsDir = path.join(process.env.HOME, ".openclaw/agents");
  const byAgent = {};
  const today = new Date().setHours(0,0,0,0);
  try {
    for (const agent of fs.readdirSync(agentsDir)) {
      const sessDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessDir)) continue;
      let cost = 0, costToday = 0, input = 0, output = 0, sessions = 0, lastTs = 0;
      for (const file of fs.readdirSync(sessDir).filter(f => f.match(/\.jsonl(\.reset\..*)?$/))) {
        sessions++;
        const lines = fs.readFileSync(path.join(sessDir, file), "utf8").split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "message") {
              const u = obj.message?.usage;
              const ts = obj.timestamp || obj.ts || 0;
              const isToday = ts && (new Date(ts).setHours(0,0,0,0) === today);
              if (u) { 
                const costObj = u.cost || {};
                const lineUsageCost = (costObj.input || 0) + (costObj.output || 0) + (costObj.cacheRead || 0);
                cost += lineUsageCost;
                if (isToday) costToday += lineUsageCost;
                input += u.input || 0; 
                output += u.output || 0; 
              }
              if (ts > lastTs) lastTs = ts;
            }
          } catch {}
        }
      }
      byAgent[agent] = { cost, costToday, input, output, sessions, lastTs };
    }
  } catch {}
  return byAgent;

}

// ── Config helpers ────────────────────────────────────────────────────────────
function readConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
function writeConfig(c) {
  fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak");
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}
function reloadGateway(hard = false) {
  dynCfg = loadDynamicConfig(); // refresh dynamic config on every reload
  try {
    if (hard) execSync("openclaw gateway restart", { timeout: 5000 });
    else execSync("kill -USR1 $(pgrep -f 'openclaw.*gateway') 2>/dev/null || true", { timeout: 3000, shell: true });
  } catch {}
}

// ── Gateway proxy helper ──────────────────────────────────────────────────────
function gatewayCall(tool, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ tool, args: args || {} });
    const opts = {
      hostname: "127.0.0.1", port: dynCfg.gwPort, path: "/tools/invoke", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Authorization": `Bearer ${dynCfg.gwToken}` }
    };
    const req = http.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
    });
    req.on("error", () => resolve({ ok: false }));
    req.write(body); req.end();
  });
}

// ── Discord API helper ────────────────────────────────────────────────────────
function discordGet(endpoint) {
  return new Promise((resolve) => {
    const opts = {
      hostname: "discord.com", path: `/api/v10${endpoint}`, method: "GET",
      headers: { "Authorization": `Bot ${dynCfg.botToken}` }
    };
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    });
    req.on("error", () => resolve([]));
    req.end();
  });
}

function LOGIN_PAGE(err) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>OpenClaw Login</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f1117;color:#e2e8f0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#1a1d27;border:1px solid #2a2d3e;border-radius:12px;padding:36px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:18px}
h1{font-size:22px;font-weight:700}p{font-size:13px;color:#64748b}
input{background:#0f1117;border:1px solid #2a2d3e;border-radius:8px;color:#e2e8f0;font-size:14px;padding:10px 14px;width:100%}
input:focus{outline:2px solid #f97316;border-color:transparent}
button{background:#f97316;border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:14px;font-weight:600;padding:11px;width:100%}
button:hover{background:#ea6c0a}.err{color:#f87171;font-size:13px}</style></head>
<body><div class="box"><h1>🦞 OpenClaw</h1><p>Enter your dashboard token to continue.</p>
${err ? `<div class="err">⚠ ${err}</div>` : ''}
<form method="POST" action="/login"><input type="password" name="token" placeholder="Dashboard token" autofocus autocomplete="current-password">
<button type="submit">Sign in →</button></form></div></body></html>`;
}

function sendErr(res, msg) {
  res.statusCode = 400;
  res.end(JSON.stringify({ ok: false, error: msg }));
}

// ── API handler ───────────────────────────────────────────────────────────────
async function handleAPI(pathname, method, body, res, rawUrl, rawBuf) {
  res.setHeader("Content-Type", "application/json");

  // ── Dashboard routes ──────────────────────────────────────────────────────

  if (pathname === "/api/setup/check" && method === "GET") {
    try {
      const c = readConfig();
      const agents = c.agents?.list || [];
      const hasGatewayToken = !!c.gateway?.auth?.token;
      const hasAgents = agents.length > 0;
      const hasDiscord = !!(c.channels?.discord?.accounts?.default?.token || c.channels?.discord?.token);
      return res.end(JSON.stringify({ ok: true, ready: hasGatewayToken && hasAgents, hasGatewayToken, hasAgents, hasDiscord, agentCount: agents.length }));
    } catch { return res.end(JSON.stringify({ ok: false, ready: false })); }
  }

  if (pathname === "/api/config" && method === "GET") {
    dynCfg = loadDynamicConfig();
    return res.end(JSON.stringify({
      ok: true,
      gatewayPort: dynCfg.gwPort,
      dashboardPort: PORT,
      hasDiscord: !!dynCfg.botToken,
      hasGuild: !!dynCfg.guildId,
      syncScript: fs.existsSync(SYNC_SCRIPT) ? SYNC_SCRIPT : null,
    }));
  }

  if (pathname === "/api/agents/usage" && method === "GET") {
    return res.end(JSON.stringify({ ok: true, usage: calcUsageByAgent() }));
  }

  if (pathname === "/api/agents" && method === "GET") {
    const c = readConfig();
    const ocDir = path.join(process.env.HOME, ".openclaw");
    const workspaces = fs.readdirSync(ocDir)
      .filter(d => d.startsWith("workspace") && fs.statSync(path.join(ocDir, d)).isDirectory())
      .map(d => path.join(ocDir, d));
    const agents = c.agents.list.map(a => {
      const ws = a.workspace || c.agents.defaults.workspace;
      let emoji = "🤖";
      try {
        const idPath = path.join(ws, "IDENTITY.md");
        if (fs.existsSync(idPath)) {
          const idContent = fs.readFileSync(idPath, "utf8");
          const m = idContent.match(/\*\*Emoji:\*\*\s*(\S+)/);
          if (m) emoji = m[1];
        }
      } catch {}
      return {
        id: a.id, name: a.name || a.id, default: a.default || false,
        model: a.model?.primary || c.agents.defaults.model.primary,
        workspace: ws,
        tools: a.tools?.profile || c.tools?.profile || "default",
        emoji
      };
    });

    // Collect all models referenced in config
    const modelSet = new Set();
    const defModel = c.agents?.defaults?.model?.primary;
    if (defModel) modelSet.add(defModel);
    for (const k of Object.keys(c.agents?.defaults?.models || {})) modelSet.add(k);
    for (const a of c.agents?.list || []) { if (a.model?.primary) modelSet.add(a.model.primary); }
    const availableModels = [...modelSet].sort();

    return res.end(JSON.stringify({ ok: true, agents, workspaces, availableModels }));
  }

  if (pathname === "/api/set-agent-workspace" && method === "POST") {
    const { agentId, workspace } = JSON.parse(body);
    if (!agentId || !workspace) return sendErr(res, "agentId and workspace required");
    const c = readConfig(); const agent = c.agents.list.find(a => a.id === agentId);
    if (!agent) return sendErr(res, `Agent '${agentId}' not found`);
    agent.workspace = workspace; writeConfig(c); reloadGateway();
    return res.end(JSON.stringify({ ok: true, message: `${agentId} workspace set to ${workspace}` }));
  }

  if (pathname === "/api/channels" && method === "GET") {
    const c = readConfig(); const bindings = c.bindings || []; const bindMap = {};
    for (const b of bindings) { const peer = b.match?.peer; if (peer?.id) bindMap[peer.id] = b.agentId; }
    if (!dynCfg.guildId) return res.end(JSON.stringify({ ok: true, channels: [] }));
    const channels = await discordGet(`/guilds/${dynCfg.guildId}/channels`);
    const categories = {}; const result = [];
    if (Array.isArray(channels)) {
      for (const c of channels) { if (c.type === 4) categories[c.id] = c.name; }
      for (const c of channels.filter(c => c.type === 0)) {
        result.push({ id: c.id, name: c.name, category: categories[c.parent_id] || "Uncategorized", agent: bindMap[c.id] || "general" });
      }
      result.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    }
    return res.end(JSON.stringify({ ok: true, channels: result }));
  }

  if (pathname === "/api/sessions" && method === "GET") {
    const r = await gatewayCall("sessions_list", { limit: 20, messageLimit: 0 });
    return res.end(JSON.stringify(r));
  }

  if (pathname === "/api/health" && method === "GET") {
    let gatewayOk = false, ollamaOk = false;
    try { execSync(`curl -s http://127.0.0.1:${dynCfg.gwPort}/`, { timeout: 3000 }); gatewayOk = true; } catch {}
    try { execSync("curl -s http://127.0.0.1:11434/api/tags", { timeout: 3000 }); ollamaOk = true; } catch {}
    const usage = calcTotalUsage();
    return res.end(JSON.stringify({ ok: true, gateway: gatewayOk, ollama: ollamaOk, usage }));
  }

  // ── Ollama model management ────────────────────────────────────────────────
  if (pathname === "/api/ollama/models" && method === "GET") {
    try {
      const out = execSync("curl -s http://127.0.0.1:11434/api/tags", { timeout: 5000, encoding: "utf8" });
      const parsed = JSON.parse(out);
      const models = (parsed.models || []).map(m => ({
        name:       m.name,
        sizeBytes:  m.size,
        sizeGb:     (m.size / 1e9).toFixed(1) + " GB",
        family:     m.details?.family     || "–",
        params:     m.details?.parameter_size || "–",
        quant:      m.details?.quantization_level || "–",
        modifiedAt: m.modified_at || null,
      }));
      return res.end(JSON.stringify({ ok: true, models }));
    } catch (e) {
      return res.end(JSON.stringify({ ok: false, error: "Ollama not reachable", models: [] }));
    }
  }

  if (pathname === "/api/ollama/delete" && method === "DELETE") {
    const { name } = JSON.parse(body);
    if (!name) return sendErr(res, "model name required");
    try {
      const out = execSync(
        `curl -s -w "\n%{http_code}" -X DELETE http://127.0.0.1:11434/api/delete -H "Content-Type: application/json" -d '${JSON.stringify({ name })}'`,
        { timeout: 10000, encoding: "utf8" }
      );
      const lines = out.trim().split("\n");
      const status = parseInt(lines[lines.length - 1], 10);
      if (status === 200) return res.end(JSON.stringify({ ok: true, message: `Deleted ${name}` }));
      return res.end(JSON.stringify({ ok: false, error: `Ollama returned ${status}` }));
    } catch (e) {
      return sendErr(res, "Failed to delete model: " + e.message);
    }
  }

  if (pathname === "/api/ollama/pull" && method === "POST") {
    const { name } = JSON.parse(body);
    if (!name) return sendErr(res, "model name required");
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked", "Cache-Control": "no-cache" });
    const child = require("child_process").spawn("curl", [
      "-s", "-X", "POST", "http://127.0.0.1:11434/api/pull",
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ name, stream: true })
    ]);
    child.stdout.on("data", chunk => res.write(chunk));
    child.stderr.on("data", () => {});
    child.on("close", () => res.end());
    return;
  }

  if (pathname === "/api/set-agent-model" && method === "POST") {
    const { agentId, model } = JSON.parse(body);
    if (!agentId || !model) return sendErr(res, "agentId and model required");
    const c = readConfig(); const agent = c.agents.list.find(a => a.id === agentId);
    if (!agent) return sendErr(res, `Agent '${agentId}' not found`);
    agent.model = { primary: model }; writeConfig(c); reloadGateway();
    return res.end(JSON.stringify({ ok: true, message: `${agentId} model set to ${model}` }));
  }

  if (pathname === "/api/set-agent-tools" && method === "POST") {
    const { agentId, profile, allow, deny } = JSON.parse(body);
    if (!agentId) return sendErr(res, "agentId required");
    const c = readConfig();
    const agent = c.agents.list.find(a => a.id === agentId);
    if (!agent) return sendErr(res, `Agent '${agentId}' not found`);
    agent.tools = agent.tools || {};
    if (profile !== undefined) agent.tools.profile = profile;
    if (allow !== undefined) agent.tools.allow = allow;
    if (deny !== undefined) agent.tools.deny = deny;
    writeConfig(c); reloadGateway();
    return res.end(JSON.stringify({ ok: true, message: `${agentId} tools updated` }));
  }

  if (pathname === "/api/set-channel-agent" && method === "POST") {
    const { channelId, agentId } = JSON.parse(body);
    if (!channelId || !agentId) return sendErr(res, "channelId and agentId required");
    const c = readConfig(); c.bindings = c.bindings || [];
    const existing = c.bindings.find(b => b.match?.peer?.id === channelId);
    if (existing) { existing.agentId = agentId; }
    else {
      const fallbackIdx = c.bindings.findIndex(b => !b.match?.peer);
      const entry = { agentId, match: { channel: "discord", accountId: "default", peer: { kind: "group", id: channelId } } };
      if (fallbackIdx >= 0) c.bindings.splice(fallbackIdx, 0, entry); else c.bindings.push(entry);
    }
    writeConfig(c); reloadGateway();
    return res.end(JSON.stringify({ ok: true, message: `Channel ${channelId} → ${agentId}` }));
  }

  // ── Agent file read/write ────────────────────────────────────────────────
  if (pathname === "/api/agent-file" && method === "GET") {
    const qs      = new URL(rawUrl, "http://localhost").searchParams;
    const agentId = qs.get("agentId");
    const file    = qs.get("file");
    const ALLOWED = ["MEMORY.md","USER.md","SOUL.md","AGENTS.md","IDENTITY.md","TOOLS.md","HEARTBEAT.md","learnings.md"];
    if (!agentId || !file || !ALLOWED.includes(file)) return sendErr(res, "Invalid agentId or file");
    const c = readConfig();
    const agent = c.agents.list.find(a => a.id === agentId);
    if (!agent) return sendErr(res, `Agent '${agentId}' not found`);
    const filePath = path.join(agent.workspace, file);
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    return res.end(JSON.stringify({ ok: true, content, filePath }));
  }

  if (pathname === "/api/agent-file" && method === "POST") {
    const { agentId, file, content } = JSON.parse(body);
    const ALLOWED = ["MEMORY.md","USER.md","SOUL.md","AGENTS.md","IDENTITY.md","TOOLS.md","HEARTBEAT.md","learnings.md"];
    if (!agentId || !file || !ALLOWED.includes(file)) return sendErr(res, "Invalid agentId or file");
    const c = readConfig();
    const agent = c.agents.list.find(a => a.id === agentId);
    if (!agent) return sendErr(res, `Agent '${agentId}' not found`);
    const filePath = path.join(agent.workspace, file);
    fs.writeFileSync(filePath, content, "utf8");
    return res.end(JSON.stringify({ ok: true, message: `Saved ${file} for ${agentId}` }));
  }

  if (pathname === "/api/restart-agent" && method === "POST") {
    reloadGateway(true);
    return res.end(JSON.stringify({ ok: true, message: "Gateway restart scheduled" }));
  }

  if (pathname === "/api/reload-config" && method === "POST") {
    reloadGateway(false);
    return res.end(JSON.stringify({ ok: true, message: "Config reload triggered" }));
  }

  // ── Gateway tab endpoints ─────────────────────────────────────────────────
  if (pathname === "/api/gateway/status" && method === "GET") {
    try {
      const statusJson = execSync(
        "/usr/local/bin/node /usr/local/lib/node_modules/openclaw/dist/index.js gateway status --json --no-probe",
        { timeout: 8000, encoding: "utf8" }
      );
      const status = JSON.parse(statusJson);
      // Also read openclaw.json for gateway config
      const c = readConfig();
      const gwCfg = c.gateway || {};
      return res.end(JSON.stringify({ ok: true, status, config: gwCfg }));
    } catch (e) {
      // Fallback: build status from what we know
      const c = readConfig();
      const gwCfg = c.gateway || {};
      const pid = (() => { try { return parseInt(execSync("pgrep -f 'openclaw.*gateway'", { encoding: "utf8" }).trim().split("\n")[0], 10) || null; } catch { return null; } })();
      return res.end(JSON.stringify({
        ok: true,
        status: {
          service: { runtime: { status: pid ? "running" : "stopped", pid } },
          gateway: { port: gwCfg.port || 18789, bindMode: gwCfg.bind || "loopback" },
          logFile: `${process.env.HOME}/.openclaw/logs/gateway.log`,
        },
        config: gwCfg,
        error: e.message
      }));
    }
  }

  if (pathname === "/api/gateway/log" && method === "GET") {
    const logPath = `${process.env.HOME}/.openclaw/logs/gateway.log`;
    try {
      const lines = execSync(`tail -n 150 "${logPath}"`, { timeout: 3000, encoding: "utf8" });
      return res.end(JSON.stringify({ ok: true, lines: lines.split("\n").filter(Boolean) }));
    } catch {
      // Try alt log path
      try {
        const today = new Date().toISOString().slice(0, 10);
        const lines2 = execSync(`tail -n 150 "/tmp/openclaw/openclaw-${today}.log"`, { timeout: 3000, encoding: "utf8" });
        return res.end(JSON.stringify({ ok: true, lines: lines2.split("\n").filter(Boolean) }));
      } catch { return res.end(JSON.stringify({ ok: false, lines: [], error: "Log not found" })); }
    }
  }

  if (pathname === "/api/gateway/usage-cost" && method === "GET") {
    try {
      const out = execSync(
        "/usr/local/bin/node /usr/local/lib/node_modules/openclaw/dist/index.js gateway usage-cost --json --days 30",
        { timeout: 15000, encoding: "utf8" }
      );
      return res.end(JSON.stringify({ ok: true, data: JSON.parse(out) }));
    } catch {
      // Fallback: use our own calcTotalUsage
      const u = calcTotalUsage();
      return res.end(JSON.stringify({ ok: true, fallback: true, data: { total: u.cost, today: u.costToday, sessions: u.sessions } }));
    }
  }

  if (pathname === "/api/gateway/stop" && method === "POST") {
    try {
      execSync("launchctl stop ai.openclaw.gateway", { timeout: 5000 });
      return res.end(JSON.stringify({ ok: true, message: "Gateway stopped" }));
    } catch (e) { return sendErr(res, "Stop failed: " + e.message); }
  }

  if (pathname === "/api/gateway/start" && method === "POST") {
    try {
      execSync("launchctl start ai.openclaw.gateway", { timeout: 5000 });
      return res.end(JSON.stringify({ ok: true, message: "Gateway started" }));
    } catch (e) { return sendErr(res, "Start failed: " + e.message); }
  }

  if (pathname === "/api/gateway/soft-restart" && method === "POST") {
    try {
      execSync("kill -USR1 $(pgrep -f 'openclaw.*gateway') 2>/dev/null || true", { timeout: 3000, shell: true });
      return res.end(JSON.stringify({ ok: true, message: "Soft restart (SIGUSR1) sent" }));
    } catch (e) { return sendErr(res, "Soft restart failed: " + e.message); }
  }

  // ── Cost analytics endpoint ───────────────────────────────────────────────
  if (pathname === "/api/cost" && method === "GET") {
    const agentsDir = path.join(process.env.HOME, ".openclaw/agents");
    // Use the server's local timezone for day bucketing
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const todayLocal = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
    const dailyMap  = {}; // 'YYYY-MM-DD' -> { cost, cacheWrite }
    const agentData = {}; // agentId -> { cost, costToday, cacheWriteTotal, sessions, input, output, lastTs }
    let globalLastTs = 0;
    let globalLastCost = 0;

    try {
      for (const agent of fs.readdirSync(agentsDir)) {
        const sessDir = path.join(agentsDir, agent, "sessions");
        if (!fs.existsSync(sessDir)) continue;
        let agCost = 0, agToday = 0, agCW = 0, agSess = 0, agIn = 0, agOut = 0, agLastTs = 0;
        for (const file of fs.readdirSync(sessDir).filter(f => f.match(/\.jsonl(\.reset\..*)?$/))) {
          agSess++;
          for (const line of fs.readFileSync(path.join(sessDir, file), "utf8").split("\n")) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === "message" && obj.message?.usage?.cost) {
                const c    = obj.message.usage.cost;
                const u    = obj.message.usage;
                const rawTs  = obj.timestamp || obj.message?.timestamp || obj.ts || 0;
                const lineTs = typeof rawTs === "string" ? new Date(rawTs).getTime() : (rawTs || 0);
                const lineCost = (c.input || 0) + (c.output || 0) + (c.cacheRead || 0);
                const lineCW   = c.cacheWrite || 0;

                agCost  += lineCost;
                agCW    += lineCW;
                agIn    += u.input  || 0;
                agOut   += u.output || 0;
                if (lineTs > agLastTs) agLastTs = lineTs;
                if (lineTs > globalLastTs) {
                  globalLastTs = lineTs;
                  globalLastCost = lineCost;
                }

                if (lineTs) {
                  const dayKey = new Date(lineTs).toLocaleDateString("en-CA", { timeZone: tz });
                  dailyMap[dayKey] = dailyMap[dayKey] || { cost: 0, cacheWrite: 0 };
                  dailyMap[dayKey].cost      += lineCost;
                  dailyMap[dayKey].cacheWrite += lineCW;
                  if (dayKey === todayLocal) agToday += lineCost;
                }
              }
            } catch {}
          }
        }
        agentData[agent] = { cost: agCost, costToday: agToday, cacheWriteTotal: agCW, sessions: agSess, input: agIn, output: agOut, lastTs: agLastTs };
      }
    } catch {}

    // Sort days, build cumulative series
    const days = Object.keys(dailyMap).sort();
    let running = 0;
    const cumulative = days.map(d => { running += dailyMap[d].cost; return { day: d, cost: dailyMap[d].cost, cumulative: running, cacheWrite: dailyMap[d].cacheWrite }; });

    // Agents sorted by cost desc
    const agents = Object.entries(agentData)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.cost - a.cost);

    const totalCost    = agents.reduce((s, a) => s + a.cost, 0);
    const totalToday   = agents.reduce((s, a) => s + a.costToday, 0);
    const totalCW      = agents.reduce((s, a) => s + a.cacheWriteTotal, 0);
    const totalSessions = agents.reduce((s, a) => s + a.sessions, 0);

    return res.end(JSON.stringify({ ok: true, timezone: tz, today: todayLocal, agents, cumulative, totals: { cost: totalCost, costToday: totalToday, cacheWriteTotal: totalCW, sessions: totalSessions, lastPromptCost: globalLastCost, lastPromptTs: globalLastTs } }));
  }

  if (pathname === "/api/healthcheck" && method === "GET") {

    // Use spawn (non-blocking) to avoid locking up the event loop for ~15s
    return new Promise((resolve) => {
      let out = "";
      const child = spawn("/usr/local/bin/node", [HEALTHCHECK_JS], { shell: false });
      const logStream = fs.createWriteStream(HEALTHCHECK_LOG, { flags: "a" });
      child.stdout.on("data", (d) => { out += d; logStream.write(d); });
      child.stderr.on("data", (d) => { out += d; logStream.write(d); });
      const timer = setTimeout(() => { child.kill(); }, 20000);
      child.on("close", () => {
        clearTimeout(timer);
        logStream.end();
        try { return res.end(JSON.stringify({ ok: true, result: JSON.parse(out) })); }
        catch { const m = out.match(/\{[\s\S]*\}/); return res.end(JSON.stringify({ ok: true, result: m ? JSON.parse(m[0]) : { overall: "UNKNOWN", checks: [] } })); }
        resolve();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        logStream.end();
        res.end(JSON.stringify({ ok: false, error: e.message }));
        resolve();
      });
    });
  }

  if (pathname === "/api/sync-repo" && method === "POST") {
    try {
      const out = execSync(`/bin/bash ${SYNC_SCRIPT} 2>&1`, { timeout: 30000, encoding: "utf8", shell: true });
      return res.end(JSON.stringify({ ok: true, output: out }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message, output: e.stdout || "" })); }
  }

  if (pathname === "/api/healthcheck/log" && method === "GET") {
    try {
      const log = fs.existsSync(HEALTHCHECK_LOG) ? execSync(`tail -100 ${HEALTHCHECK_LOG}`, { encoding: "utf8" }) : "No log file yet.";
      return res.end(JSON.stringify({ ok: true, log }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, log: e.message })); }
  }

  if (pathname === "/api/memory/stats" && method === "GET") {
    try {
      const script = path.join(__dirname, "search_native.js");
      const out = execSync(`/usr/local/bin/node "${script}" --stats --json`, { encoding: "utf8", timeout: 10000 });
      const data = JSON.parse(out.trim());
      return res.end(JSON.stringify({ total: data.total, agents: data.agents, embedded: data.total, sessions: data.agents?.length || 0, newest: "" }));
    } catch { return res.end(JSON.stringify({ total: 0, embedded: 0, sessions: 0, newest: "" })); }
  }

  if (pathname === "/api/memory/search" && method === "GET") {
    try {
      const parsed = new URL(`http://localhost:${PORT}${rawUrl}`);
      const q = parsed.searchParams.get("q") || "";
      const mode = parsed.searchParams.get("mode") || "vector";
      const role = parsed.searchParams.get("role") || "";
      const limit = parseInt(parsed.searchParams.get("limit") || "5");
      const agentParam = parsed.searchParams.get("agent") || "";
      const sourceParam = parsed.searchParams.get("source") || "";
      if (!q) return res.end(JSON.stringify({ hits: [] }));
      const script = path.join(__dirname, "search_native.js");
      const agentArg  = agentParam  ? `--agent ${JSON.stringify(agentParam)}`   : "";
      const sourceArg = sourceParam ? `--source ${JSON.stringify(sourceParam)}` : "";
      const out = execSync(`/usr/local/bin/node "${script}" ${JSON.stringify(q)} --mode ${mode} ${agentArg} ${sourceArg} --limit ${limit} --json`, { encoding: "utf8", timeout: 30000 });
      return res.end(out.trim());
    } catch (e) { return res.end(JSON.stringify({ hits: [], error: e.message })); }
  }

  if (pathname === "/api/record" && method === "POST") {
    const timestamp = Date.now();
    const audioPath = path.join(DATA_DIR, `recording_${timestamp}.webm`);
    fs.writeFileSync(audioPath, rawBuf);
    return res.end(JSON.stringify({ ok: true, audioPath }));
  }

  if (pathname === "/api/transcribe" && method === "POST") {
    const { audioPath, saveNotion, title } = JSON.parse(body);
    if (!audioPath || !fs.existsSync(audioPath)) return sendErr(res, "Audio file not found");
    try {
      const wavPath = audioPath.replace(".webm", ".wav");
      const converted = await convertAudio(audioPath, wavPath);
      const transcribePath = converted && fs.existsSync(wavPath) ? wavPath : audioPath;
      const transcript = await transcribeAudio(transcribePath);
      try { fs.unlinkSync(audioPath); } catch {}
      if (converted) try { fs.unlinkSync(wavPath); } catch {}
      const noteTitle = title || `Voice Note ${new Date().toLocaleString()}`;
      const noteFile  = path.join(TRANSCRIPTS_DIR, `note_${Date.now()}.json`);
      const note = { title: noteTitle, transcript, createdAt: new Date().toISOString(), notionSaved: false };
      if (saveNotion && NOTION_API_KEY && NOTION_DATABASE_ID) {
        try { await saveToNotion(noteTitle, transcript, ["voice-note"]); note.notionSaved = true; }
        catch (e) { note.notionError = e.message; }
      }
      fs.writeFileSync(noteFile, JSON.stringify(note, null, 2));
      return res.end(JSON.stringify({ ok: true, transcript, title: noteTitle, notionSaved: note.notionSaved }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  if (pathname === "/api/transcripts" && method === "GET") {
    try {
      const files = fs.readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".json")).sort().reverse();
      const notes = files.slice(0, 30).map(f => { try { return JSON.parse(fs.readFileSync(path.join(TRANSCRIPTS_DIR, f), "utf8")); } catch { return null; } }).filter(Boolean);
      return res.end(JSON.stringify({ ok: true, notes }));
    } catch { return res.end(JSON.stringify({ ok: true, notes: [] })); }
  }

  // ── n8n Bridge ───────────────────────────────────────────────────────────────

  // POST /api/n8n/trigger — agent triggers an n8n workflow via webhook
  if (pathname === "/api/n8n/trigger" && method === "POST") {
    try {
      const { workflowWebhook, agentId, payload, sessionKey } = JSON.parse(body);
      if (!workflowWebhook) return sendErr(res, "workflowWebhook required");
      const callbackUrl  = `http://127.0.0.1:${PORT}/api/n8n/callback`;
      const resolvedKey  = sessionKey || await resolveSessionKey(agentId || "main");
      const triggerBody  = JSON.stringify({ ...payload, _openclaw: { agentId, sessionKey: resolvedKey, callbackUrl, ts: Date.now() } });
      const proto = workflowWebhook.startsWith("https") ? https : http;
      const req   = proto.request(workflowWebhook, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(triggerBody) } }, r => { let d = ""; r.on("data", c => d += c); });
      req.on("error", () => {});
      req.write(triggerBody); req.end();
      logComms({ ts: Date.now(), type: "n8n_trigger", agentId, webhook: workflowWebhook, payload });
      return res.end(JSON.stringify({ ok: true, message: "n8n workflow triggered", callbackUrl }));
    } catch (e) { return sendErr(res, e.message); }
  }

  // POST /api/n8n/callback — n8n posts result back, gets injected into agent session
  if (pathname === "/api/n8n/callback" && method === "POST") {
    try {
      const data = JSON.parse(body);
      const { result, summary, _openclaw } = data;
      const sessionKey = _openclaw?.sessionKey || await resolveSessionKey(_openclaw?.agentId || "main");
      const message    = `[n8n workflow complete]\n${summary || result || JSON.stringify(data, null, 2)}`;
      await gatewayCall("sessions_send", { sessionKey, message, timeoutSeconds: 0 });
      logComms({ ts: Date.now(), type: "n8n_callback", agentId: _openclaw?.agentId, result: summary || result });
      return res.end(JSON.stringify({ ok: true, message: "Result injected into agent session" }));
    } catch (e) { return sendErr(res, e.message); }
  }

  // GET /api/n8n/status — check if n8n is running
  if (pathname === "/api/n8n/status" && method === "GET") {
    try {
      const r = await fetch(`${N8N_URL}/healthz`);
      const d = await r.json();
      return res.end(JSON.stringify({ ok: d.status === "ok", url: N8N_URL }));
    } catch { return res.end(JSON.stringify({ ok: false, url: N8N_URL })); }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  if (pathname === "/api/relay" && method === "POST") {
    const { from, to, message } = JSON.parse(body);
    if (!to || !message) return sendErr(res, "to and message required");
    const sessionKey = await resolveSessionKey(to);
    const entry = { ts: Date.now(), from: from || "dashboard", to, message, status: "pending" };
    try {
      await gatewayCall("sessions_send", { sessionKey, message: `[Agent relay from ${from || "dashboard"}]: ${message}`, timeoutSeconds: 0 });
      entry.status = "sent"; logComms(entry);
      return res.end(JSON.stringify({ ok: true, sessionKey, entry }));
    } catch (e) { entry.status = "failed"; entry.error = e.message; logComms(entry); return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  if (pathname === "/api/comms" && method === "GET") {
    const parsed = new URL(`http://localhost:${PORT}${rawUrl}`);
    const limit = parseInt(parsed.searchParams.get("limit") || "100");
    return res.end(JSON.stringify({ ok: true, messages: readCommsLog(limit) }));
  }

  if (pathname === "/api/comms" && method === "DELETE") {
    try { fs.writeFileSync(COMMS_LOG, ""); } catch {}
    return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === "/api/broadcast" && method === "POST") {
    const { message } = JSON.parse(body);
    if (!message) return sendErr(res, "message required");
    const sessResult = await gatewayCall("sessions_list", { limit: 50, messageLimit: 0 });
    const sessions = sessResult?.result?.details?.sessions || sessResult?.sessions || [];
    const results = [];
    for (const s of sessions) {
      if (!s.key) continue;
      try { await gatewayCall("sessions_send", { sessionKey: s.key, message, timeoutSeconds: 0 }); results.push({ key: s.key, ok: true }); }
      catch (e) { results.push({ key: s.key, ok: false, error: e.message }); }
    }
    return res.end(JSON.stringify({ ok: true, sent: results.length, results }));
  }

  if (pathname === "/api/audio-config" && method === "GET") {
    let ffmpeg = false;
    try { execSync("/opt/homebrew/bin/ffmpeg -version", { timeout: 2000 }); ffmpeg = true; } catch { try { execSync("which ffmpeg", { timeout: 2000 }); ffmpeg = true; } catch {} }
    let localWhisper = false;
    try { execSync("/usr/local/bin/python3 -c 'import mlx_whisper'", { timeout: 3000 }); localWhisper = true; } catch {}
    return res.end(JSON.stringify({ ok: true, openai: !!OPENAI_API_KEY, localWhisper, notion: !!(NOTION_API_KEY && NOTION_DATABASE_ID), ffmpeg }));
  }

  // ── Orchestrator routes (previously on :7892, now inline) ─────────────────

  if (pathname === "/api/orch/status" && method === "GET") {
    return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), gatewayAlive: gateway.isAlive(), eventCount: eventLog.length, pid: process.pid }));
  }

  if (pathname === "/api/orch/events" && method === "GET") {
    const parsed = new URL(`http://localhost:${PORT}${rawUrl}`);
    const limit = parseInt(parsed.searchParams.get("limit") || "50");
    return res.end(JSON.stringify({ ok: true, events: eventLog.slice(-limit) }));
  }

  // ── Live Activity Feed ────────────────────────────────────────────────────
  if (pathname === "/api/activity" && method === "GET") {
    const agentsDir = path.join(process.env.HOME, ".openclaw/agents");
    const events = [];

    // Scan most-recent session file for each agent
    try {
      for (const agent of fs.readdirSync(agentsDir)) {
        const sessDir = path.join(agentsDir, agent, "sessions");
        if (!fs.existsSync(sessDir)) continue;
        // Pick the most recently modified .jsonl
        const files = fs.readdirSync(sessDir)
          .filter(f => f.endsWith(".jsonl"))
          .map(f => ({ f, mt: fs.statSync(path.join(sessDir, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt);
        if (!files.length) continue;
        const latest = path.join(sessDir, files[0].f);
        const lines = fs.readFileSync(latest, "utf8").split("\n").filter(Boolean).slice(-80);

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type !== "message") continue;
            const msg  = obj.message || {};
            const role = msg.role || "unknown";
            const rawTs  = obj.timestamp || msg.timestamp || obj.ts;
            const ts     = rawTs ? new Date(rawTs).getTime() : 0;
            if (!ts) continue;

            // Extract content snippet
            let snippet = "", toolName = null;
            const content = msg.content;
            if (typeof content === "string") {
              snippet = content.slice(0, 140);
            } else if (Array.isArray(content)) {
              for (const b of content) {
                if (b.type === "text")     { snippet = (b.text || "").slice(0, 140); break; }
                if (b.type === "toolCall") { toolName = b.name; snippet = `→ ${b.name}()`; break; }
                if (b.type === "toolResult") { snippet = (typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 120); break; }
              }
            }
            snippet = snippet.replace(/\n/g, " ").trim();

            // Cost (assistant messages only)
            const costObj = msg.usage?.cost;
            const cost = costObj ? (costObj.input||0) + (costObj.output||0) + (costObj.cacheRead||0) : 0;

            events.push({ agent, role, ts, snippet, toolName, cost: cost || null });
          } catch {}
        }
      }
    } catch {}

    // Add server-level events (gateway restarts, self-heals, config changes)
    for (const e of eventLog.slice(-30)) {
      const ts = new Date(e.ts).getTime();
      let snippet = e.action ? `${e.type}: ${e.action}` : e.type;
      if (e.file) snippet += ` (${e.file})`;
      if (e.reason) snippet += ` — ${e.reason}`;
      events.push({ agent: "system", role: "system", ts, snippet, toolName: null, cost: null });
    }

    // Sort newest-first, cap at 120
    events.sort((a, b) => b.ts - a.ts);
    return res.end(JSON.stringify({ ok: true, events: events.slice(0, 120) }));
  }

  if (pathname === "/api/orch/trigger/config-reload" && method === "POST") {
    logEvent({ type: "manual_trigger", action: "config_reload" });
    await handlers.onConfigChange(cfg.CONFIG_PATH);
    return res.end(JSON.stringify({ ok: true, message: "Config reload triggered" }));
  }


  if (pathname === "/api/orch/trigger/gateway-restart" && method === "POST") {
    logEvent({ type: "manual_trigger", action: "gateway_restart" });
    gateway.restart();
    return res.end(JSON.stringify({ ok: true, message: "Gateway restart triggered" }));
  }

  if (pathname === "/api/orch/load" && method === "GET") {
    const snap = monitor.getSnapshot();
    const load = monitor.assessLoad(snap);
    return res.end(JSON.stringify({ ok: true, load, snapshot: snap }));
  }

  if (pathname === "/api/orch/route" && method === "POST") {
    try {
      const { prompt, agentId } = JSON.parse(body);
      if (!prompt) return sendErr(res, "prompt required");
      const score = router.scoreComplexity(prompt);
      const ruleMatch = router.classify(prompt, agentId);
      const recommended = router.recommendModel(score);
      logEvent({ type: "route_request", agentId, score, rule: ruleMatch.rule });
      return res.end(JSON.stringify({ ok: true, score, ruleMatch, recommended, promptLen: prompt.length }));
    } catch (e) { return sendErr(res, e.message); }
  }

  if (pathname === "/api/orch/pipelines" && method === "GET") {
    return res.end(JSON.stringify({ ok: true, pipelines: pipeline.listPipelines() }));
  }

  if (pathname === "/api/orch/pipeline/run" && method === "POST") {
    try {
      const { pipelineId, prompt } = JSON.parse(body);
      if (!pipelineId || !prompt) return sendErr(res, "pipelineId and prompt required");
      logEvent({ type: "pipeline_start", pipelineId, promptLen: prompt.length });
      res.end(JSON.stringify({ ok: true, message: `Pipeline '${pipelineId}' started.` }));
      pipeline.runPipeline(pipelineId, prompt)
        .then(r => logEvent({ type: "pipeline_complete", pipelineId, steps: r.steps.length }))
        .catch(e => log.error("Pipeline failed", { pipelineId, err: e.message }));
    } catch (e) { return sendErr(res, e.message); }
    return;
  }

  if (pathname === "/api/orch/trigger/simulate" && method === "POST") {
    try {
      const { type, data } = JSON.parse(body);
      if (type === "channel_create") await wrappedHandlers.onChannelCreate(data || { id: "test-123", name: "test-general", type: 0, guild_id: dynCfg.guildId });
      if (type === "channel_delete") await wrappedHandlers.onChannelDelete(data || { id: "test-123", name: "test-general" });
      return res.end(JSON.stringify({ ok: true, message: `Simulated ${type}` }));
    } catch (e) { return sendErr(res, e.message); }
  }

  // ── New Integration Routes ─────────────────────────────────────────────────────

  if (pathname === "/api/cron" && method === "GET") {
    try {
      const cronPath = path.join(process.env.HOME, ".openclaw/cron/jobs.json");
      if (!fs.existsSync(cronPath)) return res.end(JSON.stringify({ ok: true, jobs: [] }));
      const jobs = JSON.parse(fs.readFileSync(cronPath, "utf8")).jobs || [];
      return res.end(JSON.stringify({ ok: true, jobs }));
    } catch (e) { return sendErr(res, e.message); }
  }

  if (pathname === "/api/cron/run" && method === "POST") {
    try {
      const { jobId } = JSON.parse(body);
      if (!jobId) return sendErr(res, "jobId required");
      logEvent({ type: "manual_trigger", action: "cron_run", jobId });
      // Run it in the background so we don't block the API
      const proc = spawn("openclaw", ["cron", "run", "--id", jobId, "--json"], { detached: true, stdio: "ignore" });
      proc.unref();
      return res.end(JSON.stringify({ ok: true, message: `Triggered cron job: ${jobId}` }));
    } catch (e) { return sendErr(res, e.message); }
  }

  if (pathname === "/api/hq/overview" && method === "GET") {
    try {
      const r = await fetch("http://127.0.0.1:8000/api/v1/business/overview");
      const d = await r.json();
      return res.end(JSON.stringify({ ok: true, overview: d }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  if (pathname === "/api/hq/health" && method === "GET") {
    try {
      const r = await fetch("http://127.0.0.1:8000/api/v1/health");
      const d = await r.json();
      return res.end(JSON.stringify({ ok: true, health: d }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  if (pathname === "/api/hq/audit_summary" && method === "GET") {
    try {
      const r = await fetch("http://127.0.0.1:8000/api/v1/openclaw/audit/summary");
      const d = await r.json();
      return res.end(JSON.stringify({ ok: true, audit: d }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  if (pathname === "/api/hq/audit_run" && method === "POST") {
    try {
      const r = await fetch("http://127.0.0.1:8000/api/v1/openclaw/audit", { method: "POST" });
      const d = await r.json();
      return res.end(JSON.stringify({ ok: true, result: d }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  // ── TASKS CRUD PROXY ──
  if (pathname.startsWith("/api/hq/tasks")) {
    const apiPath = pathname.replace("/api/hq/tasks", "/api/v1/tasks");
    const hqUrl = `http://127.0.0.1:8000${apiPath}${rawUrl.includes("?") ? "?" + rawUrl.split("?")[1] : ""}`;
    try {
      const opts = { method, headers: { "Content-Type": "application/json" } };
      if (["POST", "PATCH", "PUT"].includes(method)) opts.body = body;
      const r = await fetch(hqUrl, opts);
      const d = await r.json();
      return res.end(JSON.stringify({ ok: true, data: d }));
    } catch (e) { return res.end(JSON.stringify({ ok: false, error: e.message })); }
  }

  res.statusCode = 404;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const requestHandler = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Permissions-Policy", "microphone=*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // ── Dashboard auth ────────────────────────────────────────────────────────
  const dashToken = process.env.DASHBOARD_TOKEN || dynCfg.gwToken;
  if (dashToken) {
    // Allow unauthenticated access to /api/config and the login page itself
    const isPublic = url.pathname === "/api/config" || url.pathname === "/login" || url.pathname === "/setup" || url.pathname === "/api/setup/check";
    if (!isPublic) {
      const cookieHeader = req.headers.cookie || "";
      const sessionCookie = cookieHeader.split(";").map(c => c.trim()).find(c => c.startsWith("oc_session="));
      const sessionToken = sessionCookie ? sessionCookie.split("=")[1] : null;
      const authHeader = req.headers["authorization"];
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (sessionToken !== dashToken && bearerToken !== dashToken) {
        if (url.pathname.startsWith("/api/")) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
        }
        // Redirect to login for browser requests
        res.writeHead(302, { Location: "/login" });
        return res.end();
      }
    }
  }

  if (url.pathname === "/login") {
    if (req.method === "POST") {
      const chunks = []; req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString());
        const entered = params.get("token") || "";
        const dashToken = process.env.DASHBOARD_TOKEN || dynCfg.gwToken;
        if (entered === dashToken) {
          res.writeHead(302, { "Set-Cookie": `oc_session=${dashToken}; Path=/; HttpOnly; SameSite=Strict`, Location: "/" });
          return res.end();
        }
        res.setHeader("Content-Type", "text/html");
        res.end(LOGIN_PAGE("Invalid token. Try again."));
      });
      return;
    }
    res.setHeader("Content-Type", "text/html");
    return res.end(LOGIN_PAGE(""));
  }

  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      const body   = rawBuf.toString("utf8");
      handleAPI(url.pathname, req.method, body, res, req.url, rawBuf);
    });
    return;
  }

  if (url.pathname === "/setup" || url.pathname === "/setup.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(fs.readFileSync(path.join(__dirname, "setup.html")));
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // First-run check: if no agents configured, redirect to setup
    try {
      const c = readConfig();
      if (!c.agents?.list?.length) {
        res.writeHead(302, { Location: "/setup" });
        return res.end();
      }
    } catch {}
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  }

  res.statusCode = 404; res.end("Not found");
};

// ── Self-healing: gateway health check ───────────────────────────────────────
let consecutiveFailures = 0;
setInterval(() => {
  if (!gateway.isAlive()) {
    consecutiveFailures++;
    log.warn("Gateway not responding", { consecutiveFailures });
    if (consecutiveFailures >= 3) {
      log.warn("Gateway down for 3 checks — restarting");
      logEvent({ type: "self_heal", action: "gateway_restart", reason: "3 consecutive failures" });
      gateway.restart(); consecutiveFailures = 0;
    }
  } else {
    if (consecutiveFailures > 0) log.info("Gateway recovered");
    consecutiveFailures = 0;
  }
}, 60_000);

// ── Startup ───────────────────────────────────────────────────────────────────
log.info("OpenClaw Control Center starting…");

startFileWatcher(wrappedHandlers);
startDiscordWatcher(wrappedHandlers);
monitor.start(30000);

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(requestHandler);
server.listen(PORT, "127.0.0.1", () => {
  log.info(`OpenClaw Control Center → http://127.0.0.1:${PORT}`);
  console.log(`\n🦞 OpenClaw Control Center → http://127.0.0.1:${PORT}\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  log.info(`Received ${signal} — shutting down`);
  server.close();
  process.exit(0);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException",  e => log.error("Uncaught exception",  { err: e.message, stack: e.stack }));
process.on("unhandledRejection", e => log.error("Unhandled rejection", { err: String(e) }));
