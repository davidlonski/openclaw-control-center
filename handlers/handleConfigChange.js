"use strict";
const fs      = require("fs");
const path    = require("path");
const log     = require("../utils/logger");
const cfg     = require("../utils/config");
const gateway = require("../utils/gateway");

const WORKSPACE_ROOT = path.join(process.env.HOME, ".openclaw");

module.exports = async function handleConfigChange(filePath) {
  log.event("Config file changed", { file: filePath });

  // ── 1. Read and validate ──────────────────────────────────────────────────
  let config;
  try {
    config = cfg.read();
  } catch (e) {
    log.error("Cannot parse config — skipping reload", { err: e.message });
    return;
  }

  const errors = cfg.validate(config);
  if (errors.length) {
    log.warn("Config has validation errors — NOT reloading", { errors });
    return;
  }

  // ── 2. Check workspaces exist — recreate if missing ───────────────────────
  const agents = config.agents?.list || [];
  for (const agent of agents) {
    const ws = agent.workspace || config.agents?.defaults?.workspace;
    if (!ws) continue;
    const expanded = ws.replace("~", process.env.HOME);
    if (!fs.existsSync(expanded)) {
      log.warn("Workspace missing — creating", { agent: agent.id, workspace: expanded });
      try {
        fs.mkdirSync(expanded, { recursive: true });
        // Write a minimal AGENTS.md so the agent can start
        fs.writeFileSync(path.join(expanded, "AGENTS.md"),
          `# ${agent.id}\nAuto-recreated by orchestrator.\n`);
        log.info("Workspace recreated", { agent: agent.id });
      } catch (e) {
        log.error("Failed to recreate workspace", { agent: agent.id, err: e.message });
      }
    }
  }

  // ── 3. Trigger gateway reload ─────────────────────────────────────────────
  gateway.reload();
  log.info("Config change handled ✓");
};
