import { expect, it } from "vitest"
import { slackAppManifest, slackAppManifestUrl } from "./slack.ts"

it("carries the whole manifest in a link to Slack's new app page", () => {
  const url = new URL(slackAppManifestUrl)
  expect(url.origin + url.pathname).toBe("https://api.slack.com/apps")
  expect(url.searchParams.get("new_app")).toBe("1")
  expect(JSON.parse(url.searchParams.get("manifest_json") ?? "")).toEqual(slackAppManifest)
})

it("subscribes over the socket to the two ways a developer reaches the bot", () => {
  expect(slackAppManifest.settings).toEqual({
    event_subscriptions: { bot_events: ["app_mention", "message.im"] },
    socket_mode_enabled: true,
  })
  expect(slackAppManifest.features.app_home.messages_tab_read_only_enabled).toBe(false)
})
