export const slackAppManifest = {
  display_information: { name: "HinaCode" },
  features: {
    bot_user: { display_name: "HinaCode", always_online: false },
  },
  oauth_config: {
    scopes: {
      bot: ["app_mentions:read", "channels:history", "groups:history", "chat:write", "reactions:write"],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["app_mention"] },
    socket_mode_enabled: true,
  },
}

export const slackAppManifestUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackAppManifest))}`
