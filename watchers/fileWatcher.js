"use strict";
const path     = require("path");
const chokidar = require("/usr/local/lib/node_modules/openclaw/node_modules/chokidar");
const log      = require("../utils/logger");

const WATCH_FILES = [
  path.join(process.env.HOME, ".openclaw/openclaw.json"),
  path.join(process.env.HOME, ".openclaw/shared-memory/permissions.json"),
];

// Debounce: ignore rapid re-fires from the same file
const debounceMap = {};
function debounce(key, fn, ms = 800) {
  clearTimeout(debounceMap[key]);
  debounceMap[key] = setTimeout(fn, ms);
}

module.exports = function startFileWatcher(handlers) {
  const watcher = chokidar.watch(WATCH_FILES, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  });

  watcher.on("change", (filePath) => {
    const base = path.basename(filePath);
    log.event("File changed", { file: base });

    debounce(filePath, () => {
      if (base === "openclaw.json")       handlers.onConfigChange(filePath);
      if (base === "permissions.json")    handlers.onPermissionChange(filePath);
    });
  });

  watcher.on("error", (err) => log.error("File watcher error", { err: err.message }));

  log.info("File watcher started", { watching: WATCH_FILES.map(f => path.basename(f)) });
  return watcher;
};
