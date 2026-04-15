"use strict";
const fs   = require("fs");
const path = require("path");
const log  = require("./logger");

const CONFIG_PATH = path.join(process.env.HOME, ".openclaw/openclaw.json");

function read() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function backup() {
  const bak = CONFIG_PATH + `.bak-${Date.now()}`;
  fs.copyFileSync(CONFIG_PATH, bak);
  // Keep only last 5 backups
  const dir  = path.dirname(CONFIG_PATH);
  const baks = fs.readdirSync(dir)
    .filter(f => f.startsWith("openclaw.json.bak-"))
    .sort();
  if (baks.length > 5) {
    baks.slice(0, baks.length - 5).forEach(f => {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    });
  }
  return bak;
}

function write(cfg) {
  // Validate: must have agents.list array
  if (!cfg?.agents?.list || !Array.isArray(cfg.agents.list)) {
    throw new Error("Invalid config: agents.list is missing or not an array");
  }
  const bak = backup();
  log.info("Config backup created", { bak });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  log.info("Config written", { path: CONFIG_PATH });
}

function validate(cfg) {
  const errors = [];
  if (!cfg.agents?.list) errors.push("Missing agents.list");
  if (!cfg.gateway?.port) errors.push("Missing gateway.port");
  return errors;
}

module.exports = { read, write, backup, validate, CONFIG_PATH };
