"use strict";
/**
 * Load Monitor
 * Polls openclaw status every N seconds and tracks:
 * - active sessions per agent
 * - token usage rates
 * - context fill %
 * Exposes load data to the orchestrator API and emits routing hints.
 */

const { execSync } = require("child_process");
const log = require("./utils/logger");

// ── Ring buffer for rate calculation ─────────────────────────────────────────
const TOKEN_HISTORY = []; // [{ ts, totalTokens }]
const MAX_HISTORY = 20;

// ── Current load snapshot ─────────────────────────────────────────────────────
let lastSnapshot = null;

function getSnapshot() {
  try {
    const raw = execSync("/usr/local/bin/openclaw status --json 2>/dev/null", { timeout: 8000, encoding: "utf8" });
    const d = JSON.parse(raw);
    const sessions = d.sessions?.recent || [];
    const agents = d.agents?.agents || [];

    const activeSessions = sessions.filter(s => s.totalTokens > 0);
    const totalTokens = activeSessions.reduce((a, s) => a + (s.totalTokens || 0), 0);
    const runningSessions = activeSessions.filter(s => (Date.now() - s.updatedAt) < 60000).length;

    // Per-agent context fill
    const agentLoad = {};
    for (const s of activeSessions) {
      const agentId = s.agentId || s.key?.split(":")?.[1];
      if (!agentId) continue;
      const pct = s.percentUsed || 0;
      if (!agentLoad[agentId] || pct > agentLoad[agentId]) {
        agentLoad[agentId] = pct;
      }
    }

    // Token rate (tokens/min over last 2 snapshots)
    const now = Date.now();
    TOKEN_HISTORY.push({ ts: now, totalTokens });
    if (TOKEN_HISTORY.length > MAX_HISTORY) TOKEN_HISTORY.shift();
    let tokenRate = 0;
    if (TOKEN_HISTORY.length >= 2) {
      const oldest = TOKEN_HISTORY[0];
      const newest = TOKEN_HISTORY[TOKEN_HISTORY.length - 1];
      const minElapsed = (newest.ts - oldest.ts) / 60000;
      const tokenDelta = newest.totalTokens - oldest.totalTokens;
      tokenRate = minElapsed > 0 ? Math.round(tokenDelta / minElapsed) : 0;
    }

    lastSnapshot = {
      ts: now,
      totalTokens,
      activeSessions: activeSessions.length,
      runningSessions,
      tokenRate,
      agentLoad,
      agents: agents.map(a => ({
        id: a.id,
        sessions: a.sessionsCount || 0,
        lastActive: a.lastActiveAgeMs,
      })),
    };

    return lastSnapshot;
  } catch (e) {
    log.warn("Load monitor snapshot failed", { err: e.message });
    return lastSnapshot || { ts: Date.now(), totalTokens: 0, activeSessions: 0, tokenRate: 0, agentLoad: {}, agents: [] };
  }
}

// ── Load level assessment ─────────────────────────────────────────────────────
function assessLoad(snapshot) {
  const cfg = (() => {
    try {
      const fs = require("fs"), path = require("path");
      return JSON.parse(fs.readFileSync(path.join(__dirname, "pipelines.json"), "utf8")).scaling?.thresholds || {};
    } catch { return {}; }
  })();

  const highTokenRate = (cfg.highLoadTokensPerMin || 5000);
  const highSessions  = (cfg.highLoadActiveSessions || 3);

  if (snapshot.tokenRate > highTokenRate || snapshot.activeSessions > highSessions) {
    return { level: "high",   preferLocal: false, reason: `${snapshot.activeSessions} active sessions, ${snapshot.tokenRate} tok/min` };
  }
  if (snapshot.activeSessions > 1 || snapshot.tokenRate > highTokenRate * 0.4) {
    return { level: "medium", preferLocal: true,  reason: `${snapshot.activeSessions} active session(s)` };
  }
  return { level: "low",    preferLocal: true,  reason: "System idle" };
}

// ── Start periodic monitoring ─────────────────────────────────────────────────
function start(intervalMs = 30000) {
  getSnapshot(); // immediate first run
  const timer = setInterval(() => {
    const snap = getSnapshot();
    const load = assessLoad(snap);
    if (load.level === "high") {
      log.warn("High load detected", { ...load, activeSessions: snap.activeSessions, tokenRate: snap.tokenRate });
    }
  }, intervalMs);
  timer.unref(); // don't block process exit
  log.info("Load monitor started", { intervalMs });
  return timer;
}

module.exports = { start, getSnapshot, assessLoad };
