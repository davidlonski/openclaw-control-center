"use strict";
const fs  = require("fs");
const log = require("../utils/logger");

const PERMS_PATH = require("path").join(
  process.env.HOME, ".openclaw/shared-memory/permissions.json"
);

module.exports = async function handlePermissionChange() {
  log.event("Permissions file changed");

  // ── 1. Parse and validate ─────────────────────────────────────────────────
  let perms;
  try {
    perms = JSON.parse(fs.readFileSync(PERMS_PATH, "utf8"));
  } catch (e) {
    log.error("Cannot parse permissions.json", { err: e.message });
    return;
  }

  if (typeof perms !== "object" || Array.isArray(perms)) {
    log.error("permissions.json is not an object — aborting");
    return;
  }

  // ── 2. Log who has access to what ────────────────────────────────────────
  const domains = Object.keys(perms).filter(k => !k.startsWith("_"));
  log.info("Permissions reloaded", {
    domains,
    summary: domains.map(d => `${d}:${JSON.stringify(perms[d])}`).join(", ")
  });

  // ── 3. Verify all listed agents exist in config ───────────────────────────
  const { read } = require("../utils/config");
  let config;
  try { config = read(); } catch { return; }
  const agentIds = new Set(config.agents.list.map(a => a.id));

  for (const [domain, agents] of Object.entries(perms)) {
    if (domain.startsWith("_")) continue;
    const invalid = (Array.isArray(agents) ? agents : [])
      .filter(a => a !== "*" && !agentIds.has(a));
    if (invalid.length) {
      log.warn("Permission references unknown agent(s)", { domain, invalid });
    }
  }

  log.info("Permission change handled ✓");
};
