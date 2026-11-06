import { Context, Duration, Effect, Layer, Schema } from "effect"
import type { Message, Thread } from "../../shared/domain.ts"
import { installedBinary } from "../agents/binary.ts"
import { AgentError } from "../agents/provider.ts"
import { slugifyBranch } from "./automations/template.ts"
import type { NotFoundError, PersistenceError } from "./errors.ts"
import { Events } from "./Events.ts"
import { Messages } from "./Messages.ts"
import { Settings } from "./Settings.ts"
import { Threads } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"

const Suggestion = Schema.Struct({ title: Schema.String, branch: Schema.String })

const SUGGESTION_JSON_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, branch: { type: "string" } },
  required: ["title", "branch"],
  additionalProperties: false,
}

const SYSTEM_PROMPT = `You name coding tasks in a developer's sidebar. Given the developer's messages in a task, reply with:
- title: at most 50 characters, sentence case, no trailing period, in the language of the message
- branch: 2 to 5 lowercase English words joined by hyphens, with no prefix`

const PROMPT_LIMIT = 4000

export type NamingScope = "title" | "titleAndBranch"

export class ThreadNaming extends Context.Service<
  ThreadNaming,
  {
    readonly nameFromPrompt: (thread: Thread, prompt: string, scope: NamingScope) => Effect.Effect<void>
    readonly regenerateTitle: (threadId: string) => Effect.Effect<Thread, AgentError | PersistenceError | NotFoundError>
  }
>()("hinacode/ThreadNaming") {}

const suggest = (model: string, prompt: string) =>
  Effect.gen(function* () {
    const pathToClaudeCodeExecutable = yield* installedBinary("claude", "claude")
    const output = yield* Effect.tryPromise({
      try: async (signal) => {
        const abortController = new AbortController()
        signal.addEventListener("abort", () => abortController.abort())
        const { query } = await import("@anthropic-ai/claude-agent-sdk")
        const stream = query({
          prompt: prompt.slice(0, PROMPT_LIMIT),
          options: {
            env: { ...process.env },
            pathToClaudeCodeExecutable,
            model,
            effort: "low",
            systemPrompt: SYSTEM_PROMPT,
            tools: [],
            settingSources: [],
            persistSession: false,
            outputFormat: { type: "json_schema", schema: SUGGESTION_JSON_SCHEMA },
            abortController,
          },
        })
        for await (const message of stream) {
          if (message.type !== "result") continue
          if (message.subtype !== "success") throw new Error(message.errors.join("\n") || message.subtype)
          return message.structured_output
        }
        throw new Error("Claude Code ended without a result")
      },
      catch: (cause) =>
        new AgentError({
          provider: "claude",
          message: `Failed to name thread: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }).pipe(Effect.timeout(Duration.seconds(60)))
    return yield* Schema.decodeUnknownEffect(Suggestion)(output)
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof AgentError
        ? cause
        : new AgentError({ provider: "claude", message: `Failed to name thread: ${cause.message}` }),
    ),
  )

const userText = (messages: ReadonlyArray<Message>) =>
  messages
    .filter((message) => message.role === "user")
    .map((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
    .filter((text) => text.trim() !== "")
    .join("\n\n---\n\n")

const make = Effect.gen(function* () {
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const settings = yield* Settings
  const events = yield* Events
  const messages = yield* Messages

  const nameFromPrompt = (thread: Thread, prompt: string, scope: NamingScope) =>
    Effect.gen(function* () {
      const { textGenerationModel } = yield* settings.get
      const suggestion = yield* suggest(textGenerationModel, prompt)
      const current = yield* threads.get(thread.id)
      const title = suggestion.title.trim()
      if (title !== "" && current.title === thread.title) {
        const renamed = yield* threads.update({ id: thread.id, title })
        yield* events.publish({ type: "thread.updated", thread: renamed })
      }
      const branch = slugifyBranch(suggestion.branch)
      if (scope === "titleAndBranch" && current.worktreeId !== null && branch !== "") {
        yield* worktrees.renameBranch(current.worktreeId, `kk/${branch}`)
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("thread naming failed", cause)))

  const regenerateTitle = (threadId: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const prompt = userText(yield* messages.list(threadId))
      if (prompt === "") return thread
      const { textGenerationModel } = yield* settings.get
      const title = (yield* suggest(textGenerationModel, prompt)).title.trim()
      if (title === "" || title === thread.title) return thread
      const renamed = yield* threads.update({ id: threadId, title })
      yield* events.publish({ type: "thread.updated", thread: renamed })
      return renamed
    })

  return ThreadNaming.of({ nameFromPrompt, regenerateTitle })
})

export const layer = Layer.effect(ThreadNaming, make)
