import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { Slack } from "../../services/slack/Slack.ts"
import { Threads } from "../../services/Threads.ts"
import * as McpTool from "./tool.ts"

export const SLACK_REPLY_LIMIT = 12_000

export const SlackTools = Toolkit.make(
  McpTool.make("slack_reply", {
    description:
      "Post a reply into the Slack thread linked to this thread and return its link. It cannot post anywhere else. Use it to answer the people in that Slack thread, because what you write in HinaCode does not reach them.",
    parameters: Schema.Struct({
      text: Schema.String.annotate({ description: "The reply as Markdown, at most 12,000 characters." }),
    }),
  }),
)

export const slackToolsLayer = SlackTools.toLayer(
  Effect.gen(function* () {
    const slack = yield* Slack
    const threads = yield* Threads
    return SlackTools.of({
      slack_reply: ({ text }) =>
        Effect.gen(function* () {
          const { slack: link } = yield* threads.get(yield* McpTool.CallingThread)
          if (link === null) return yield* Effect.fail({ message: "This thread is not linked to a Slack thread." })
          if (text.trim() === "") return yield* Effect.fail({ message: "The reply is empty." })
          if (text.length > SLACK_REPLY_LIMIT) {
            return yield* Effect.fail({
              message: `Slack takes at most ${SLACK_REPLY_LIMIT} characters in one reply and this one has ${text.length}. Shorten it or split it.`,
            })
          }
          const permalink = yield* slack.reply({ channel: link.channelId, ts: link.threadTs }, text)
          return `Posted to the Slack thread: ${permalink}`
        }),
    })
  }),
)
