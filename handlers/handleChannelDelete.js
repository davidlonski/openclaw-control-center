"use strict";
const log     = require("../utils/logger");
const cfg     = require("../utils/config");
const gateway = require("../utils/gateway");

module.exports = async function handleChannelDelete(channel) {
  const channelId   = channel.id;
  const channelName = channel.name || channelId;
  log.event("Discord channel deleted", { id: channelId, name: channelName });

  let config;
  try { config = cfg.read(); } catch (e) {
    log.error("Cannot read config", { err: e.message }); return;
  }

  const bindings = config.bindings || [];
  const before = bindings.length;

  // Remove any binding whose peer.id matches this channel
  config.bindings = bindings.filter(b => b.match?.peer?.id !== channelId);

  // Also remove from Discord channel allowlist
  for (const acct of Object.values(config.channels?.discord?.accounts || {})) {
    for (const guild of Object.values(acct.guilds || {})) {
      if (guild.channels?.[channelId]) {
        delete guild.channels[channelId];
        log.info("Removed channel from guild allowlist", { channelId });
      }
    }
  }

  const removed = before - config.bindings.length;
  if (removed > 0) {
    try {
      cfg.write(config);
      gateway.reload();
      log.info("Binding removed for deleted channel", { channelId, channelName, removed });
    } catch (e) {
      log.error("Failed to update config", { err: e.message });
    }
  } else {
    log.info("No binding found for deleted channel — no changes", { channelId });
  }
};
