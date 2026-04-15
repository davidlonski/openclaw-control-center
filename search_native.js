#!/usr/bin/env node
/**
 * search_native.js
 * CLI search over OpenClaw native memory (sqlite-vec).
 * Called by search.py as a subprocess, or directly.
 *
 * Usage:
 *   node search_native.js "query" [--limit 5] [--agent main] [--mode vector|keyword] [--stats] [--json]
 */

"use strict";

const { DatabaseSync } = require("node:sqlite");
const http  = require("http");
const path  = require("path");
const fs    = require("fs");

const VEC_DYLIB   = "/usr/local/lib/node_modules/openclaw/node_modules/sqlite-vec-darwin-arm64/vec0.dylib";
const sqliteVec   = require("/usr/local/lib/node_modules/openclaw/node_modules/sqlite-vec");
const MEMORY_DIR  = path.join(process.env.HOME, ".openclaw/memory");
const OLLAMA_URL  = "http://127.0.0.1:11434";
const EMBED_MODEL = "snowflake-arctic-embed2";

// ── Args ──────────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
let query   = null, limit = 5, agentFilter = null, sourceFilter = null, mode = "vector", doStats = false, doJson = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit"  || args[i] === "-n") { limit = parseInt(args[++i]); }
  else if (args[i] === "--agent"  || args[i] === "-a") { agentFilter = args[++i]; }
  else if (args[i] === "--source" || args[i] === "-s") { sourceFilter = args[++i]; }
  else if (args[i] === "--mode"   || args[i] === "-m") { mode = args[++i]; }
  else if (args[i] === "--stats") { doStats = true; }
  else if (args[i] === "--json"   || args[i] === "-j") { doJson = true; }
  else if (!args[i].startsWith("-"))  { query = args[i]; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getAgents() {
  return fs.readdirSync(MEMORY_DIR)
    .filter(f => f.endsWith(".sqlite"))
    .map(f => f.replace(".sqlite", ""));
}

function openDb(agent) {
  const dbPath = path.join(MEMORY_DIR, `${agent}.sqlite`);
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(db);
    // Verify chunks table exists — skip corrupt/empty DBs
    db.prepare("SELECT 1 FROM chunks LIMIT 1").all();
    return db;
  } catch { return null; }
}

function embed(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) });
    const req  = http.request("http://127.0.0.1:11434/api/embeddings", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d).embedding || null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.write(body); req.end();
  });
}

function packVec(floats) {
  const buf = Buffer.allocUnsafe(floats.length * 4);
  floats.forEach((f, i) => buf.writeFloatLE(f, i * 4));
  return buf;
}

function fmtTs(ts) {
  if (!ts) return "–";
  try {
    let t = Number(ts);
    if (t > 1e12) t = t / 1000;
    return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  } catch { return "–"; }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function stats() {
  const agents = getAgents();
  let total = 0;
  const rows = [];
  for (const agent of agents.sort()) {
    const db = openDb(agent);
    if (!db) continue;
    const c = db.prepare("SELECT COUNT(*) as c FROM chunks").get().c;
    db.close();
    rows.push({ agent, chunks: c });
    total += c;
  }
  if (doJson) { console.log(JSON.stringify({ agents: rows, total })); return; }
  console.log("\n  📊 Native Memory Stats");
  console.log("  " + "─".repeat(50));
  for (const r of rows) console.log(`  ${r.agent.padEnd(20)} ${String(r.chunks).padStart(6)} chunks`);
  console.log("  " + "─".repeat(50));
  console.log(`  ${"TOTAL".padEnd(20)} ${String(total).padStart(6)} chunks\n`);
}

// ── Vector search ─────────────────────────────────────────────────────────────
async function vectorSearch(query) {
  const vec = await embed(query);
  if (!vec) { console.error("Could not embed query"); process.exit(1); }
  const vecBuf = packVec(vec);
  const agents = agentFilter ? [agentFilter] : getAgents();
  const hits = [];

  for (const agent of agents) {
    const db = openDb(agent);
    if (!db) continue;
    try {
      const sourceClause = sourceFilter ? `AND c.source = '${sourceFilter.replace(/'/g, "''")}'` : "";
      const rows = db.prepare(`
        SELECT c.id, c.path, c.source, c.text, c.updated_at, v.distance
        FROM chunks_vec v
        JOIN chunks c ON c.id = v.id
        WHERE v.embedding MATCH ? AND k = ? ${sourceClause}
        ORDER BY v.distance
      `).all(vecBuf, limit);
      for (const r of rows) {
        hits.push({ agent, text: r.text, path: r.path, source: r.source, ts: r.updated_at, score: Math.round((1 - r.distance) * 1000) / 1000 });
      }
    } catch {}
    db.close();
  }

  hits.sort((a, b) => b.score - a.score);
  // Filter out low-relevance results (below 10% similarity)
  return hits.filter(h => h.score >= 0.03).slice(0, limit);
}

// ── Keyword search ────────────────────────────────────────────────────────────
function keywordSearch(query) {
  const agents = agentFilter ? [agentFilter] : getAgents();
  const hits = [];
  for (const agent of agents) {
    const db = openDb(agent);
    if (!db) continue;
    try {
      const sourceClause = sourceFilter ? `AND source = '${sourceFilter.replace(/'/g, "''")}'` : "";
      const rows = db.prepare(`
        SELECT id, path, source, text, updated_at
        FROM chunks WHERE text LIKE ? ${sourceClause} ORDER BY updated_at DESC LIMIT ?
      `).all(`%${query}%`, limit);
      for (const r of rows) {
        hits.push({ agent, text: r.text, path: r.path, source: r.source, ts: r.updated_at, score: null });
      }
    } catch {}
    db.close();
  }
  return hits.slice(0, limit);
}

// ── Print results ─────────────────────────────────────────────────────────────
function printResults(hits, query) {
  if (!hits.length) { console.log(`\n  No results for: "${query}"\n`); return; }
  console.log("\n" + "─".repeat(70));
  console.log(`  Results for: "${query}"`);
  console.log("─".repeat(70));
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const score = h.score !== null ? `  similarity: ${h.score}` : "";
    console.log(`\n  [${i+1}] 🤖 ${h.agent}  ${fmtTs(h.ts)}  ${score}`);
    console.log(`       Path: ${h.path}  Source: ${h.source}`);
    console.log("  " + "─".repeat(66));
    (h.text || "").slice(0, 400).split("\n").forEach(l => console.log(`    ${l}`));
  }
  console.log("\n" + "─".repeat(70) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (doStats || !query) { stats(); if (!query) return; }

  const hits = mode === "keyword" ? keywordSearch(query) : await vectorSearch(query);

  if (doJson) { console.log(JSON.stringify({ hits })); }
  else { printResults(hits, query); }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
