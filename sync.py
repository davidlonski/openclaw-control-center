#!/usr/bin/env python3
"""
openclaw-memory-search / sync.py — unified memory sync
Reads JSONL transcripts from ~/.openclaw/agents/*/sessions/*.jsonl
and writes directly into the native OpenClaw memory sqlite files
(~/.openclaw/memory/<agent>.sqlite) using source='sessions'.

This means memory_search tool AND the dashboard Memory tab both query
the exact same database — one store, no duplication.
"""

import sqlite3, json, time, hashlib, struct, requests
from datetime import datetime
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
MEMORY_DIR  = Path.home() / ".openclaw" / "memory"
AGENTS_DIR  = Path.home() / ".openclaw" / "agents"
OLLAMA_URL  = "http://127.0.0.1:11434"
EMBED_MODEL = "snowflake-arctic-embed2"
BATCH_SIZE  = 32
SOURCE      = "sessions"
MIN_LENGTH  = 20
NOISE       = {"HEARTBEAT_OK", "NO_REPLY"}

# ── Helpers ───────────────────────────────────────────────────────────────────
def chunk_id(session_id, role, ts, content):
    raw = f"{session_id}:{role}:{ts}:{content[:80]}"
    return hashlib.sha1(raw.encode()).hexdigest()

def extract_text(content):
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return " ".join(parts).strip()
    return ""

def parse_ts(val):
    if not val: return 0
    if isinstance(val, (int, float)):
        return int(val) if val > 1e12 else int(val * 1000)
    if isinstance(val, str):
        try:
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except: pass
    return 0

def get_embed(text):
    try:
        resp = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBED_MODEL, "prompt": text[:2000]},
            timeout=30
        )
        vec = resp.json().get("embedding")
        return json.dumps(vec) if vec else None
    except:
        return None

# ── Get pending rows across all agents ───────────────────────────────────────
def collect_new_rows():
    """Scan all transcripts and return rows not yet in native memory dbs."""
    jsonl_files = (
        list(AGENTS_DIR.glob("*/sessions/*.jsonl")) +
        list(AGENTS_DIR.glob("*/sessions/*.jsonl.reset.*"))
    )

    # Agents to skip (renamed/archived)
    SKIP_AGENTS = {"main"}

    by_agent = {}
    for p in jsonl_files:
        agent = p.parent.parent.name
        if agent in SKIP_AGENTS:
            continue
        by_agent.setdefault(agent, []).append(p)

    all_new = {}  # agent -> list of (cid, path_key, text, ts_ms)

    for agent, files in sorted(by_agent.items()):
        db_path = MEMORY_DIR / f"{agent}.sqlite"
        if not db_path.exists():
            continue
        conn = sqlite3.connect(str(db_path))
        new_rows = []

        for path in files:
            session_id = path.stem.split(".jsonl")[0]
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line: continue
                        try: obj = json.loads(line)
                        except: continue

                        if obj.get("type") == "message":
                            msg     = obj.get("message", {})
                            role    = msg.get("role", "")
                            content = extract_text(msg.get("content", ""))
                            ts      = parse_ts(obj.get("timestamp") or obj.get("ts"))
                        else:
                            role    = obj.get("role", "")
                            content = extract_text(obj.get("content", ""))
                            ts      = parse_ts(obj.get("createdAt") or obj.get("ts"))

                        if role not in ("user", "assistant") or not content:
                            continue
                        if len(content) < MIN_LENGTH or content.strip() in NOISE:
                            continue

                        cid = chunk_id(session_id, role, ts, content)
                        exists = conn.execute("SELECT 1 FROM chunks WHERE id=?", (cid,)).fetchone()
                        if exists:
                            continue

                        date_str  = datetime.fromtimestamp(ts/1000).strftime("%Y-%m-%d %H:%M") if ts > 0 else "unknown"
                        text      = f"[{role.upper()} @ {date_str}] {content}"
                        path_key  = f"sessions/{agent}/{date_str[:10]}.md"
                        new_rows.append((cid, path_key, text, ts))
            except Exception as e:
                print(f"  ⚠ Error reading {path.name}: {e}")

        conn.close()
        if new_rows:
            all_new[agent] = new_rows

    return all_new

# ── Write rows with embeddings ────────────────────────────────────────────────
def write_rows(agent, rows):
    db_path = MEMORY_DIR / f"{agent}.sqlite"
    conn = sqlite3.connect(str(db_path))

    # Ensure FTS table exists
    try:
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
            USING fts5(text, id UNINDEXED, path UNINDEXED, source UNINDEXED,
                       model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED,
                       tokenize='unicode61')
        """)
        conn.commit()
    except: pass

    inserted = 0
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i+BATCH_SIZE]
        for (cid, path_key, text, ts_ms) in batch:
            embedding = get_embed(text)
            if embedding is None:
                # FTS-only fallback: use empty JSON array so NOT NULL is satisfied
                embedding = "[]"
            try:
                conn.execute(
                    """INSERT OR IGNORE INTO chunks
                       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (cid, path_key, SOURCE, 0, 0, cid[:16], EMBED_MODEL, text, embedding, ts_ms)
                )
                if conn.execute("SELECT changes()").fetchone()[0]:
                    # Also insert into FTS
                    try:
                        conn.execute(
                            "INSERT INTO chunks_fts (id, path, source, model, start_line, end_line, text) VALUES (?,?,?,?,?,?,?)",
                            (cid, path_key, SOURCE, EMBED_MODEL, 0, 0, text)
                        )
                    except: pass
                    inserted += 1
            except Exception as e:
                print(f"  ⚠ Insert error [{agent}]: {e}")

        conn.commit()
        done = min(i + BATCH_SIZE, len(rows))
        if len(rows) > BATCH_SIZE:
            print(f"  … {done}/{len(rows)} embedded [{agent}]")

    conn.close()
    return inserted

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[{datetime.now():%H:%M:%S}] Scanning transcripts…")

    all_new = collect_new_rows()
    total_new = sum(len(v) for v in all_new.values())
    print(f"  Found {total_new} new messages across {len(all_new)} agents")

    if not total_new:
        print(f"\n✅ Nothing new to sync")
        return

    total_written = 0
    for agent, rows in sorted(all_new.items()):
        print(f"  Embedding {len(rows)} messages for [{agent}]…")
        written = write_rows(agent, rows)
        total_written += written

    print(f"\n✅ Sync complete — {total_written} messages written to native memory dbs")

if __name__ == "__main__":
    main()
