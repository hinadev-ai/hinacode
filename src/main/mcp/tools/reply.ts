import { Effect, Option, Schema } from "effect"
import { Toolkit } from "effect/ai"
import type { ReplyDestination } from "../../../shared/domain.ts"
import { GitHub } from "../../services/GitHub.ts"
import { Linear } from "../../services/Linear.ts"
import { Conversations } from "../../services/routines/Conversations.ts"
import { REPLY_MARK } from "../../services/routines/triggers.ts"
import { Slack, type SlackDestination } from "../../services/slack/Slack.ts"
import * as McpTool from "./tool.ts"

const MAX_REPLY_BYTES = 60_000
const MAX_SLACK_REPLY_CHARACTERS = 12_000

export const ReplyTools = Toolkit.make(
  McpTool.make("reply", {
    description:
      "Post `text` to the conversation that started or continued this thread, such as the GitHub issue, the pull request, the Slack thread or the Linear issue, and nowhere else.",
    parameters: Schema.Struct({
      text: Schema.String.annotate({ description: "The reply, in Markdown." }),
    }),
  }),
)

const refuse = (message: string) => Effect.fail({ message })

export const replyToolsLayer = ReplyTools.toLayer(
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const github = yield* GitHub
    const slack = yield* Slack
    const linear = yield* Linear

    const toGitHub = (url: string, text: string) =>
      Effect.gen(function* () {
        const bytes = Buffer.byteLength(text)
        if (bytes > MAX_REPLY_BYTES) {
          return yield* refuse(
            `A reply takes at most ${MAX_REPLY_BYTES} bytes and this one has ${bytes}. Shorten it or split it.`,
          )
        }
        yield* github.comment(url, `${text}\n\n${REPLY_MARK}`)
      })

    const toSlack = (destination: SlackDestination, text: string) =>
      Effect.gen(function* () {
        const characters = [...text].length
        if (characters > MAX_SLACK_REPLY_CHARACTERS) {
          return yield* refuse(
            `A Slack reply takes at most ${MAX_SLACK_REPLY_CHARACTERS} characters and this one has ${characters}. Shorten it or split it.`,
          )
        }
        yield* slack.post(destination, text).pipe(Effect.mapError(({ message }) => ({ message })))
      })

    const toLinear = (issueId: string, text: string) =>
      linear.comment(issueId, text).pipe(Effect.mapError(({ message }) => ({ message })))

    const post = (target: ReplyDestination, text: string) => {
      switch (target.source) {
        case "github":
          return toGitHub(target.url, text)
        case "slack":
          return toSlack(target, text)
        case "linear":
          return toLinear(target.issueId, text)
      }
    }

    return ReplyTools.of({
      reply: ({ text }) =>
        Effect.gen(function* () {
          const threadId = yield* McpTool.CallingThread
          const destination = yield* conversations.ofThread(threadId)
          if (Option.isNone(destination)) {
            return yield* refuse("This thread did not start from an outside event, so there is nowhere to reply.")
          }
          if (text.trim() === "") return yield* refuse("The reply is empty.")
          const target = destination.value
          yield* post(target, text)
          return `Posted to ${target.url}`
        }),
    })
  }),
)
