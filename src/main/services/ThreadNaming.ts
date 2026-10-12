import { query } from "@anthropic-ai/claude-agent-sdk"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import type { Thread } from "../../shared/domain.ts"
import { resolveClaudeExecutable } from "../agents/claude/index.ts"
import { AgentError } from "../agents/provider.ts"
import { slugifyBranch } from "./automations/template.ts"
import { Events } from "./Events.ts"
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

const SYSTEM_PROMPT = `You name coding tasks in a developer's sidebar. Given the first message of a task, reply with:
- title: at most 50 characters, sentence case, no trailing period, in the language of the message
- branch: 2 to 5 lowercase English words joined by hyphens, with no prefix`

/** Enough of a long first message to tell what it is about. */
const PROMPT_LIMIT = 4000

/**
 * What naming may change. `titleAndBranch` is only for a branch kkcode created for this task: renaming any
 * other branch, such as a pull request's head, detaches it from its upstream and its pull request.
 */
export type NamingScope = "title" | "titleAndBranch"

export class ThreadNaming extends Context.Service<
  ThreadNaming,
  {
    /**
     * Titles the thread from its first message and, within `scope`, renames its worktree branch. Never fails:
     * on any error the placeholder names stay. A title the user changed in the meantime is kept.
     */
    readonly nameFromPrompt: (thread: Thread, prompt: string, scope: NamingScope) => Effect.Effect<void>
  }
>()("kkcode/ThreadNaming") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const settings = yield* Settings
  const events = yield* Events
  const executable = yield* Effect.cached(Effect.sync(resolveClaudeExecutable))

  const suggest = (model: string, prompt: string) =>
    Effect.gen(function* () {
      const pathToClaudeCodeExecutable = yield* executable
      const output = yield* Effect.tryPromise({
        try: async (signal) => {
          const abortController = new AbortController()
          signal.addEventListener("abort", () => abortController.abort())
          const stream = query({
            prompt: prompt.slice(0, PROMPT_LIMIT),
            options: {
              // The SDK replaces the child env instead of merging it.
              env: { ...process.env },
              ...(pathToClaudeCodeExecutable === undefined ? {} : { pathToClaudeCodeExecutable }),
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
    })

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

  return ThreadNaming.of({ nameFromPrompt })
})

export const layer = Layer.effect(ThreadNaming, make)
