export const slackAppManifest = {
  display_information: { name: "HinaCode" },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "HinaCode", always_online: false },
  },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "im:history",
        "chat:write",
        "reactions:write",
        "users:read",
      ],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["app_mention", "message.im"] },
    socket_mode_enabled: true,
  },
}

export const slackAppManifestUrl = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackAppManifest))}`
