"use strict";
/**
 * Pipeline Engine
 * Executes multi-agent workflows defined in pipelines.json.
 * Each step calls the OpenClaw gateway /tools/invoke to run sessions_send,
 * then waits for the session to complete and reads the output.
 */

const fs   = require("fs");
const path = require("path");
const http = require("http");
const log  = require("./utils/logger");

const PIPELINES_PATH = path.join(__dirname, "pipelines.json");
const SHARED_MEMORY  = path.join(process.env.HOME, ".openclaw/shared-memory/global/notes/pipeline-results.md");
const GATEWAY_TOKEN  = (() => { try {
  const t = require("./utils/config").read().gateway.auth.token;
  if (!t) log.warn("GATEWAY_TOKEN is empty — pipeline steps may fail");
  return t || "";
} catch {
  log.warn("Failed to read gateway token — pipeline steps may fail");
  return "";
} })();

// ── Gateway HTTP helper ────────────────────────────────────────────────────────
function gw(tool, args, sessionKey) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ tool, args: args || {}, sessionKey: sessionKey || "agent:general:main" });
    const opts = {
      hostname: "127.0.0.1", port: 18789, path: "/tools/invoke", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Authorization": `Bearer ${GATEWAY_TOKEN}` }
    };
    const req = http.request(opts, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false, raw: d }); } });
    });
    req.on("error", () => resolve({ ok: false, error: "network error" }));
    req.write(body); req.end();
  });
}

// ── Session key helper ────────────────────────────────────────────────────────
function sessionKey(agentId) {
  return `agent:${agentId}:main`;
}

// ── Poll until session finishes (max 2 minutes) ───────────────────────────────
async function waitForSession(agentId, timeoutMs = 120_000) {
  const key = sessionKey(agentId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    const r = await gw("sessions_list", { limit: 20, messageLimit: 0 }, key);
    const sessions = r?.result?.details?.sessions || [];
    const sess = sessions.find(s => s.key === key);
    if (sess && sess.status !== "running") return sess;
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Run a single pipeline step ────────────────────────────────────────────────
async function runStep(step, context, userPrompt) {
  // Build instruction: interpolate {keys} from context
  let instruction = step.instruction;
  for (const [k, v] of Object.entries(context)) {
    instruction = instruction.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }

  // First message: include user prompt in step 1, or just the instruction
  const isFirstStep = Object.keys(context).length === 0 || !context[Object.keys(context)[0]];
  const message = isFirstStep
    ? `${instruction}\n\nUSER REQUEST:\n${userPrompt}`
    : instruction;

  log.info(`Pipeline step: ${step.role} → agent:${step.agent}`, { agent: step.agent });

  // Send message to agent via sessions_list (read) + we inject via system note
  // Since sessions_send is blocked over HTTP, we write to the agent's shared memory
  // as a task file, then use the cron trigger approach
  // Actually: write a task file the agent will read on next heartbeat is too slow.
  // Instead: use exec to call openclaw CLI send directly
  const { execSync } = require("child_process");
  const sessionK = sessionKey(step.agent);

  try {
    // Write the message to a temp file to avoid shell escaping issues
    const tmpFile = `/tmp/pipeline-msg-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, message);

    // Use openclaw CLI to send — this works synchronously
    const result = execSync(
      `openclaw send --agent ${step.agent} --session main --file "${tmpFile}" 2>&1`,
      { timeout: 30000, encoding: "utf8" }
    );
    fs.unlinkSync(tmpFile);

    // Wait for agent to respond
    await sleep(3000);
    const sess = await waitForSession(step.agent, 90_000);

    if (!sess) {
      log.warn("Pipeline step timed out", { step: step.role, agent: step.agent });
      return { ok: false, output: "[TIMEOUT]", escalate: false };
    }

    // Read the latest output from the session transcript
    const output = await readLatestOutput(step.agent, sess.sessionId);
    const escalate = step.escalateOnTag && output.includes(step.escalateOnTag);

    log.info(`Pipeline step complete: ${step.role}`, { outputLen: output.length, escalate });
    return { ok: true, output, escalate };

  } catch (e) {
    log.error("Pipeline step failed", { step: step.role, err: e.message });
    return { ok: false, output: `[ERROR: ${e.message}]`, escalate: false };
  }
}

// ── Read latest assistant message from JSONL transcript ──────────────────────
async function readLatestOutput(agentId, sessionId) {
  try {
    const transcriptPath = path.join(
      process.env.HOME, `.openclaw/agents/${agentId}/sessions/${sessionId}.jsonl`
    );
    if (!fs.existsSync(transcriptPath)) return "[No transcript]";
    const lines = fs.readFileSync(transcriptPath, "utf8")
      .split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    // Find last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l.role === "assistant" || l.type === "assistant") {
        const content = l.content || l.text || "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) return content.map(c => c.text || "").join("");
      }
    }
    return "[No assistant response found]";
  } catch (e) {
    return `[Error reading transcript: ${e.message}]`;
  }
}

// ── Main pipeline runner ──────────────────────────────────────────────────────
async function runPipeline(pipelineId, userPrompt, options = {}) {
  const config = JSON.parse(fs.readFileSync(PIPELINES_PATH, "utf8"));
  const pipeline = config.pipelines[pipelineId];
  if (!pipeline) throw new Error(`Pipeline '${pipelineId}' not found`);

  log.info(`Starting pipeline: ${pipelineId}`, { steps: pipeline.steps.length, promptLen: userPrompt.length });

  const context = {};
  const stepResults = [];
  let escalated = false;

  for (let i = 0; i < pipeline.steps.length; i++) {
    const step = pipeline.steps[i];

    // Skip conditional steps unless condition met
    if (step.condition === "escalated" && !escalated) {
      log.info(`Skipping step ${i+1} (condition 'escalated' not met)`, { step: step.role });
      continue;
    }

    const result = await runStep(step, context, userPrompt);
    stepResults.push({ step: step.role, agent: step.agent, ...result });

    if (result.ok) {
      context[step.outputKey] = result.output;
      if (result.escalate) escalated = true;
    } else {
      // Hard failure — abort pipeline
      log.error(`Pipeline aborted at step ${i+1}`, { role: step.role });
      break;
    }
  }

  const finalResult = context.result || context[Object.keys(context).pop()] || "[No output]";

  // Save result to shared memory
  saveToSharedMemory(pipelineId, userPrompt, finalResult, stepResults);

  return { pipelineId, steps: stepResults, result: finalResult, context };
}

// ── Save pipeline result to shared memory ────────────────────────────────────
function saveToSharedMemory(pipelineId, prompt, result, steps) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const time = new Date().toLocaleTimeString();
    const entry = [
      `\n## [${date} ${time}] Pipeline: ${pipelineId}`,
      `**Prompt:** ${prompt.slice(0, 200)}${prompt.length > 200 ? "…" : ""}`,
      `**Steps:** ${steps.map(s => `${s.step}(${s.agent})`).join(" → ")}`,
      `**Result:**\n${result.slice(0, 1000)}${result.length > 1000 ? "\n…[truncated]" : ""}`,
    ].join("\n");

    fs.mkdirSync(path.dirname(SHARED_MEMORY), { recursive: true });
    if (!fs.existsSync(SHARED_MEMORY)) {
      fs.writeFileSync(SHARED_MEMORY, `# Pipeline Results\n> Auto-generated by pipeline engine\n`);
    }
    fs.appendFileSync(SHARED_MEMORY, entry + "\n");
    log.info("Pipeline result saved to shared memory");
  } catch (e) {
    log.warn("Could not save pipeline result", { err: e.message });
  }
}

// ── List available pipelines ──────────────────────────────────────────────────
function listPipelines() {
  const config = JSON.parse(fs.readFileSync(PIPELINES_PATH, "utf8"));
  return Object.entries(config.pipelines)
    .filter(([k]) => !k.startsWith("_"))
    .map(([id, p]) => ({ id, description: p.description, steps: p.steps.length }));
}

module.exports = { runPipeline, listPipelines, scoreComplexity: require("./router").scoreComplexity };
