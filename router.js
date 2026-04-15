"use strict";
/**
 * Smart model router
 * Classifies a prompt and returns the best model + agent for it.
 * Called by the pipeline engine and exposed via the orchestrator API.
 */

const fs   = require("fs");
const path = require("path");

const PIPELINES_PATH = path.join(__dirname, "pipelines.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(PIPELINES_PATH, "utf8"));
}

// ── Classifier ────────────────────────────────────────────────────────────────
function classify(prompt, currentAgentId = null) {
  const cfg = loadConfig();
  const rules = cfg.routing?.rules || [];
  const text = prompt.toLowerCase().trim();
  const len  = prompt.length;

  for (const rule of rules) {
    const m = rule.match;
    let matched = true;

    // keyword check — ANY keyword triggers a match
    if (m.keywords?.length) {
      const hasKeyword = m.keywords.some(k => text.includes(k.toLowerCase()));
      if (!hasKeyword) matched = false;
    }

    // agentIs check — current agent must be in list
    if (matched && m.agentIs?.length && currentAgentId) {
      if (!m.agentIs.includes(currentAgentId)) matched = false;
    }

    // minLength
    if (matched && m.minLength != null && len < m.minLength) matched = false;

    // maxLength
    if (matched && m.maxLength != null && len > m.maxLength) matched = false;

    if (matched) {
      return {
        rule:      rule.name,
        reason:    rule.description,
        model:     rule.model,
        agent:     rule.agent || currentAgentId,
        prompt_len: len,
        matched:   true,
      };
    }
  }

  // No rule matched — return null (use agent default)
  return {
    rule:    "default",
    reason:  "No routing rule matched — using agent default",
    model:   null,
    agent:   currentAgentId,
    matched: false,
  };
}

// ── Complexity score (0–100) for display ─────────────────────────────────────
function scoreComplexity(prompt) {
  let score = 0;
  const text = prompt.toLowerCase();
  const len  = prompt.length;

  // Length factor (0–25 pts)
  score += Math.min(25, Math.floor(len / 15));

  // High-complexity keywords (15 pts each, up to 45)
  const heavyKw = ["architect","refactor","distributed","microservice","event sourcing","cqrs","concurrent",
    "security audit","performance bottleneck","design pattern","scalab","99.9","sla","tradeoff",
    "multi-region","eventual consistency","zero downtime","infrastructure","enterprise"];
  score += Math.min(45, heavyKw.filter(k => text.includes(k)).length * 15);

  // Medium keywords (8 pts each, up to 30)
  const medKw = ["algorithm","implement","debug","async","analyze","compare","evaluate","optimize",
    "research","difference","pipeline","workflow","integrate","deploy","migrate","performance","race condition"];
  score += Math.min(30, medKw.filter(k => text.includes(k)).length * 8);

  // Simple signals (subtract)
  const simpleKw = ["hello world","hi","thanks","quick","simple","example","snippet","fix typo","rename"];
  score -= simpleKw.filter(k => text.includes(k)).length * 15;

  // Question marks add a little
  score += (prompt.match(/\?/g) || []).length * 2;

  return Math.max(0, Math.min(100, score));
}

function recommendModel(score) {
  if (score >= 45) return { tier: "cloud",  model: "anthropic/claude-sonnet-4-6", reason: "High complexity" };
  if (score >= 20) return { tier: "medium", model: "ollama/qwen2.5:14b",          reason: "Medium complexity" };
  return            { tier: "local",  model: "ollama/gemma4:e4b",          reason: "Low complexity" };
}

module.exports = { classify, scoreComplexity, recommendModel };
