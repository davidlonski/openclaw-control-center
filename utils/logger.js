"use strict";
const fs   = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "../logs");

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function logFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `orchestrator-${date}.log`);
}

function write(level, msg, data) {
  const line = `[${timestamp()}] [${level}] ${msg}${data ? " " + JSON.stringify(data) : ""}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logFile(), line + "\n");
  } catch {}
}

module.exports = {
  info:  (msg, d) => write("INFO ", msg, d),
  warn:  (msg, d) => write("WARN ", msg, d),
  error: (msg, d) => write("ERROR", msg, d),
  event: (msg, d) => write("EVENT", msg, d),
};
