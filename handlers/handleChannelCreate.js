"use strict";
const log     = require("../utils/logger");
const cfg     = require("../utils/config");
const gateway = require("../utils/gateway");

// Auto-assign logic: map channel name prefix → agent id
const PREFIX_MAP = [
  { prefix: "general-",       agent: "general" },
  { prefix: "coder-",         agent: "coder" },
  { prefix: "power-",         agent: "power" },
  { prefix: "fiverr-",        agent: "fiverr-builder" },
  { prefix: "gumroad-",       agent: "gumroad-builder" },
  { prefix: "affiliate-",     agent: "affiliate-tracker" },
  { prefix: "automation-",    agent: "automation" },
  { prefix: "local-general",  agent: "local-general" },
  { prefix: "local-coder",    agent: "local-coder" },
  { prefix: "local-power",    agent: "local-power" },
  { prefix: "local-",         agent: "local-general" }, // fallback for other local-* names
];

function inferAgent(channelName) {
  for (const { prefix, agent } of PREFIX_MAP) {
    if (channelName.startsWith(prefix)) return agent;
  }
  return null; // unknown — don't auto-assign
}

module.exports = async function handleChannelCreate(channel) {
  const channelId   = channel.id;
  const channelName = channel.name || "";
  const guildId     = channel.guild_id || channel.guildId;
  log.event("Discord channel created", { id: channelId, name: channelName, guildId });

  // Only handle text channels (type 0)
  if (channel.type !== 0) {
    log.info("Skipping non-text channel", { type: channel.type });
    return;
  }

  const agentId = inferAgent(channelName);
  if (!agentId) {
    log.info("No prefix match — channel not auto-bound", { channelName });
    return;
  }

  let config;
  try { config = cfg.read(); } catch (e) {
    log.error("Cannot read config", { err: e.message }); return;
  }

  // Verify agent exists
  const agentExists = config.agents.list.some(a => a.id === agentId);
  if (!agentExists) {
    log.warn("Inferred agent does not exist", { agentId, channelName });
    return;
  }

  config.bindings = config.bindings || [];

  // Don't duplicate
  if (config.bindings.some(b => b.match?.peer?.id === channelId)) {
    log.info("Binding already exists", { channelId }); return;
  }

  // Add to guild allowlist
  if (guildId) {
    const accounts = config.channels?.discord?.accounts || {};
    for (const acct of Object.values(accounts)) {
      if (acct.guilds?.[guildId]) {
        acct.guilds[guildId].channels = acct.guilds[guildId].channels || {};
        acct.guilds[guildId].channels[channelId] = { allow: true, requireMention: false };
      }
    }
  }

  // Insert binding before the catch-all fallback
  const fallbackIdx = config.bindings.findIndex(b => !b.match?.peer);
  const entry = {
    agentId,
    match: { channel: "discord", accountId: "default", peer: { kind: "group", id: channelId } }
  };
  if (fallbackIdx >= 0) config.bindings.splice(fallbackIdx, 0, entry);
  else config.bindings.push(entry);

  try {
    cfg.write(config);
    gateway.reload();
    log.info("Channel auto-bound", { channelId, channelName, agentId });
  } catch (e) {
    log.error("Failed to write config for new channel", { err: e.message });
  }
};
