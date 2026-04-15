"use strict";
const https = require("https");
const log   = require("../utils/logger");

// Read bot token from config
function getBotToken() {
  try {
    const cfg = require("../utils/config").read();
    return cfg?.channels?.discord?.accounts?.default?.token
        || cfg?.channels?.discord?.token
        || "";
  } catch { return ""; }
}

// Minimal Discord WebSocket gateway client
// Connects to Discord's WS gateway and listens for channel events
// Uses only Node.js built-in modules (no discord.js needed)
const WS_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

module.exports = function startDiscordWatcher(handlers) {
  const token = getBotToken();
  if (!token) {
    log.warn("No Discord bot token found — Discord watcher disabled");
    return null;
  }

  let ws = null;
  let heartbeatInterval = null;
  let sessionId = null;
  let seq = null;
  let reconnectDelay = 5000;

  function connect() {
    const { WebSocket } = require("/usr/local/lib/node_modules/openclaw/node_modules/ws");
    ws = new WebSocket(WS_URL);

    ws.on("open", () => {
      log.info("Discord gateway connected");
      reconnectDelay = 5000;
    });

    ws.on("message", (data) => {
      let payload;
      try { payload = JSON.parse(data.toString()); } catch { return; }

      const { op, d, s, t } = payload;
      if (s) seq = s;

      switch (op) {
        // Hello — start heartbeat and identify
        case 10: {
          const interval = d.heartbeat_interval;
          heartbeatInterval = setInterval(() => {
            if (ws && ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: seq }));
            }
          }, interval);
          // Identify
          ws.send(JSON.stringify({
            op: 2,
            d: {
              token,
              intents: (1 << 0) | (1 << 12), // GUILDS + GUILD_MESSAGES
              properties: { os: "darwin", browser: "openclaw-orchestrator", device: "openclaw" },
            }
          }));
          break;
        }
        // Heartbeat ACK — ignore
        case 11: break;
        // Reconnect
        case 7: {
          log.warn("Discord requested reconnect");
          cleanup(); reconnect();
          break;
        }
        // Invalid session
        case 9: {
          log.warn("Discord invalid session — reconnecting fresh");
          sessionId = null; seq = null;
          cleanup(); setTimeout(reconnect, 5000);
          break;
        }
        // Dispatch
        case 0: {
          if (t === "READY") {
            sessionId = d.session_id;
            log.info("Discord gateway ready", { bot: d.user?.username });
          } else if (t === "CHANNEL_CREATE") {
            log.event("Discord CHANNEL_CREATE", { id: d.id, name: d.name, type: d.type });
            handlers.onChannelCreate(d);
          } else if (t === "CHANNEL_DELETE") {
            log.event("Discord CHANNEL_DELETE", { id: d.id, name: d.name });
            handlers.onChannelDelete(d);
          } else if (t === "CHANNEL_UPDATE") {
            log.event("Discord CHANNEL_UPDATE", { id: d.id, name: d.name });
            handlers.onChannelUpdate(d);
          }
          break;
        }
      }
    });

    ws.on("close", (code) => {
      log.warn("Discord gateway disconnected", { code });
      cleanup();
      // Don't reconnect on normal close (1000) or auth failure (4004)
      if (code !== 1000 && code !== 4004) {
        setTimeout(reconnect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 60000);
      }
    });

    ws.on("error", (err) => {
      log.error("Discord WS error", { err: err.message });
    });
  }

  function cleanup() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (ws) { try { ws.terminate(); } catch {} ws = null; }
  }

  function reconnect() {
    log.info("Discord gateway reconnecting…");
    connect();
  }

  connect();
  return { stop: cleanup };
};
