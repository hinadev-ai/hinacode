import { Effect, Option, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { GitHub } from "../../services/GitHub.ts"
import { Conversations } from "../../services/routines/Conversations.ts"
import { REPLY_MARK } from "../../services/routines/triggers.ts"
import { Slack, type SlackDestination } from "../../services/slack/Slack.ts"
import * as McpTool from "./tool.ts"

const MAX_REPLY_BYTES = 60_000
const MAX_SLACK_REPLY_CHARACTERS = 12_000

export const ReplyTools = Toolkit.make(
  McpTool.make("reply", {
    description:
      "Post `text` to the conversation that started or continued this thread, such as the GitHub issue, the pull request or the Slack thread, and nowhere else.",
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
          yield* target.source === "github" ? toGitHub(target.url, text) : toSlack(target, text)
          return `Posted to ${target.url}`
        }),
    })
  }),
)
