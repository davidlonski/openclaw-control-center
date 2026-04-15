"use strict";
const { execSync } = require("child_process");
const log = require("./logger");

const TOKEN = (() => {
  try {
    const cfg = require("./config").read();
    return cfg?.gateway?.auth?.token || "";
  } catch { return ""; }
})();

// Soft reload via SIGUSR1 (no full restart — just re-reads config)
function reload() {
  try {
    execSync("openclaw gateway reload 2>/dev/null || kill -USR1 $(pgrep -f 'openclaw.*gateway') 2>/dev/null || true", { shell: true, timeout: 5000 });
    log.info("Gateway reload triggered");
  } catch (e) {
    log.warn("Gateway reload failed", { err: e.message });
  }
}

// Hard restart via LaunchAgent
function restart() {
  try {
    execSync("openclaw gateway restart", { timeout: 8000 });
    log.info("Gateway restart triggered");
  } catch (e) {
    log.warn("Gateway restart failed", { err: e.message });
  }
}

// Check if gateway is reachable
function isAlive() {
  try {
    execSync(`curl -s --max-time 2 http://127.0.0.1:18789/ > /dev/null`, { timeout: 4000, shell: true });
    return true;
  } catch { return false; }
}

module.exports = { reload, restart, isAlive };
