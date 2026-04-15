#!/usr/bin/env node
/**
 * healthcheck.js — OpenClaw system health check
 *
 * Checks:
 *   1. Gateway    — reachable, latency
 *   2. Orchestrator — responding, uptime
 *   3. Ollama     — running, models loaded
 *   4. Memory     — sqlite chunks per agent
 *   5. Cron jobs  — consecutive errors, last run age
 *   6. Sync repo  — last push, git status
 *   7. Disk       — used % on home volume
 *   8. Processes  — gateway + orchestrator LaunchAgents
 *
 * Exits 0 if all OK, 1 if any WARN/CRIT found.
 * Outputs a compact JSON summary to stdout.
 */

"use strict";

const http       = require("http");
const https      = require("https");
const fs         = require("fs");
const path       = require("path");
const { execSync } = require("child_process");

const HOME       = process.env.HOME;
const CONFIG     = JSON.parse(fs.readFileSync(path.join(HOME, ".openclaw/openclaw.json"), "utf8"));
const AGENTS     = CONFIG.agents.list.map(a => a.id);

// ── HTTP helper ───────────────────────────────────────────────────────────────
function get(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ ok: true, data: JSON.parse(d), latencyMs: Date.now() - start }); }
        catch { resolve({ ok: true, data: d, latencyMs: Date.now() - start }); }
      });
    });
    req.on("error", e => resolve({ ok: false, error: e.message, latencyMs: Date.now() - start }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout", latencyMs: timeoutMs }); });
  });
}

// ── Shell helper (safe) ───────────────────────────────────────────────────────
function sh(cmd, fallback = null) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 8000 }).trim(); }
  catch { return fallback; }
}

// ── Result builder ────────────────────────────────────────────────────────────
const checks = [];
function check(name, status, detail, value = null) {
  // status: "ok" | "warn" | "crit"
  checks.push({ name, status, detail, ...(value !== null ? { value } : {}) });
}

// ── Run all checks ────────────────────────────────────────────────────────────
async function run() {
  // 1. Gateway
  const gw = await get("http://127.0.0.1:18789/status", 4000);
  if (!gw.ok) {
    check("gateway", "crit", `Unreachable: ${gw.error}`);
  } else {
    const latency = gw.latencyMs;
    check("gateway", latency > 2000 ? "warn" : "ok",
      `Reachable, ${latency}ms`, latency);
  }

  // 2. Orchestrator (merged into dashboard on Apr 7 2026 — check dashboard instead)
  const orch = await get("http://127.0.0.1:7891/api/orch/status", 4000);
  if (!orch.ok) {
    check("orchestrator", "warn", "Dashboard orch endpoint unreachable");
  } else {
    const uptime = orch.data?.uptime ?? 0;
    const uptimeMin = Math.round(uptime / 60);
    check("orchestrator", "ok", `Up ${uptimeMin}m (inline dashboard)`, uptimeMin);
  }

  // 3. Ollama
  const ollama = await get("http://127.0.0.1:11434/api/tags", 4000);
  if (!ollama.ok) {
    check("ollama", "crit", `Not running: ${ollama.error}`);
  } else {
    const models = ollama.data?.models ?? [];
    const names = models.map(m => m.name.split(":")[0]);
    // Required models for agents
    const required = ["mxbai-embed-large", "gemma4", "qwen2.5", "snowflake-arctic-embed2"];
    const missing = required.filter(r => !names.some(n => n.includes(r.split(":")[0])));
    if (missing.length > 0) {
      check("ollama", "warn", `Missing models: ${missing.join(", ")}`, models.length);
    } else {
      check("ollama", "ok", `${models.length} models loaded`, models.length);
    }
  }

  // 4. Memory (sqlite per agent)
  // Only core agents are expected to have memory DBs
  const CORE_AGENTS = ["general", "coder", "power", "local-general", "local-coder", "local-power"];
  const memDir = path.join(HOME, ".openclaw/memory");
  let memIssues = [];
  let totalChunks = 0;
  let dbCount = 0;
  for (const agentId of AGENTS) {
    const dbPath = path.join(memDir, `${agentId}.sqlite`);
    if (!fs.existsSync(dbPath)) {
      if (CORE_AGENTS.includes(agentId)) memIssues.push(`${agentId}: no db`);
      continue;
    }
    dbCount++;
    const count = parseInt(sh(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM chunks;"`) || "0");
    totalChunks += count;
    if (count === 0 && CORE_AGENTS.includes(agentId)) memIssues.push(`${agentId}: 0 chunks`);
  }
  if (memIssues.length > 0) {
    check("memory", "warn", `Core agent issues: ${memIssues.join(", ")}`, totalChunks);
  } else {
    check("memory", "ok", `${totalChunks} chunks across ${dbCount} agent(s)`, totalChunks);
  }

  // 5. Cron jobs
  const cronPath = path.join(HOME, ".openclaw/cron/jobs.json");
  if (fs.existsSync(cronPath)) {
    const cronData = JSON.parse(fs.readFileSync(cronPath, "utf8"));
    const jobs = cronData.jobs ?? [];
    const cronIssues = [];
    for (const job of jobs) {
      if (!job.enabled) continue;
      const errs = job.state?.consecutiveErrors ?? 0;
      const lastRun = job.state?.lastRunAtMs ?? 0;
      const ageHours = lastRun ? (Date.now() - lastRun) / 3600000 : null;
      // Expected interval in hours
      let intervalHours;
      if (job.schedule?.kind === "every" && job.schedule?.everyMs) {
        intervalHours = job.schedule.everyMs / 3600000;
      } else if (job.schedule?.kind === "cron") {
        const expr = job.schedule.expr || "";
        // Weekly (day-of-week field is not *)
        if (/\S+\s+\S+\s+\S+\s+\S+\s+[^*\s]/.test(expr)) intervalHours = 168;
        // Daily
        else if (/\S+\s+\S+\s+\*\s+\*\s+\*/.test(expr)) intervalHours = 24;
        // Hourly
        else intervalHours = 1;
      } else {
        intervalHours = (job.schedule?.everyMs ?? 3600000) / 3600000;
      }
      if (errs >= 3) {
        cronIssues.push(`"${job.name}": ${errs} consecutive errors`);
      } else if (ageHours !== null && ageHours > intervalHours * 3) {
        cronIssues.push(`"${job.name}": last run ${Math.round(ageHours)}h ago`);
      }
    }
    if (cronIssues.length > 0) {
      check("cron", "warn", cronIssues.join("; "), jobs.filter(j => j.enabled).length);
    } else {
      check("cron", "ok", `${jobs.filter(j => j.enabled).length} active job(s) healthy`);
    }
  } else {
    check("cron", "ok", "No cron jobs configured");
  }

  // 6. Sync repo
  const repoPath = path.join(HOME, "Fredrick-CLAW");
  if (fs.existsSync(repoPath)) {
    const lastCommit = sh(`git -C "${repoPath}" log -1 --format="%ar|%s" 2>/dev/null`);
    const dirty = sh(`git -C "${repoPath}" status --porcelain 2>/dev/null`);
    if (!lastCommit) {
      check("sync_repo", "warn", "Cannot read git log");
    } else {
      const [age, msg] = lastCommit.split("|");
      // Check if last commit is too old (more than 3x the hourly interval = 3h)
      const hoursOld = sh(`git -C "${repoPath}" log -1 --format="%ct" 2>/dev/null`);
      const ageHours = hoursOld ? (Date.now() / 1000 - parseInt(hoursOld)) / 3600 : null;
      if (ageHours !== null && ageHours > 24) {
        check("sync_repo", "warn", `Last push ${age} — "${msg}"`);
      } else {
        check("sync_repo", "ok", `Last push ${age} — "${msg}"`);
      }
    }
  } else {
    check("sync_repo", "warn", `Repo not found at ${repoPath}`);
  }

  // 7. Disk space
  const dfOut = sh(`df -k "${HOME}" | tail -1`);
  if (dfOut) {
    const parts = dfOut.split(/\s+/);
    const usedPct = parseInt(parts[4] ?? "0");
    const avail = Math.round(parseInt(parts[3] ?? "0") / 1024 / 1024); // GB
    if (usedPct >= 90) {
      check("disk", "crit", `${usedPct}% used, ${avail}GB free`, usedPct);
    } else if (usedPct >= 75) {
      check("disk", "warn", `${usedPct}% used, ${avail}GB free`, usedPct);
    } else {
      check("disk", "ok", `${usedPct}% used, ${avail}GB free`, usedPct);
    }
  }

  // 8. LaunchAgents
  // Persistent services (must always have a PID): gateway + orchestrator
  // Interval jobs (run-and-exit, PID="-" is normal): memory-sync, healthcheck, repo-sync
  const PERSISTENT = ["ai.openclaw.gateway", "ai.openclaw.dashboard"];
  const launchctl = sh("launchctl list | grep openclaw");
  if (!launchctl) {
    check("launchagents", "warn", "No openclaw launchagents found in launchctl");
  } else {
    const lines = launchctl.split("\n").filter(Boolean);
    const loaded = lines.map(l => ({ pid: l.split("\t")[0].trim(), name: l.split("\t")[2]?.trim() }));
    const deadPersistent = loaded.filter(l => PERSISTENT.includes(l.name) && l.pid === "-");
    const notLoaded = PERSISTENT.filter(name => !loaded.find(l => l.name === name));
    const intervalLoaded = loaded.filter(l => !PERSISTENT.includes(l.name));

    if (deadPersistent.length > 0 || notLoaded.length > 0) {
      const names = [...deadPersistent.map(l => l.name), ...notLoaded].join(", ");
      check("launchagents", "crit", `Persistent service(s) not running: ${names}`);
    } else {
      check("launchagents", "ok", `${PERSISTENT.length} persistent + ${intervalLoaded.length} interval job(s) loaded`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const crits = checks.filter(c => c.status === "crit");
  const warns = checks.filter(c => c.status === "warn");
  const oks   = checks.filter(c => c.status === "ok");

  const overall = crits.length > 0 ? "CRITICAL" : warns.length > 0 ? "WARN" : "OK";

  const summary = {
    overall,
    ts: new Date().toISOString(),
    counts: { ok: oks.length, warn: warns.length, crit: crits.length },
    checks,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(crits.length > 0 || warns.length > 0 ? 1 : 0);
}

run().catch(e => {
  process.stdout.write(JSON.stringify({ overall: "CRITICAL", error: e.message, ts: new Date().toISOString() }) + "\n");
  process.exit(1);
});
