import { Effect, Option, Schema } from "effect"
import type { ThreadUsage } from "../../../shared/agent.ts"
import { addTokens, noTokens, type Tokens, toThreadUsage } from "../usage.ts"
import type { AgentError } from "../provider.ts"
import type { MuseCallError } from "./host.ts"
import { CompletionUsage, type ViewPage } from "./protocol.ts"

/** One completion in hinacode's four parts. `promptTokens` includes cached input, so the cache comes off the full rate. */
export const completionTokens = ({ promptTokens, usage }: CompletionUsage): Tokens => {
  const cacheReadTokens = usage.cacheReadTokens ?? usage.cachedTokens
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens: usage.outputTokens,
  }
}

interface SessionTotal {
  /** The view cursor of the last event read. The next read starts after it. */
  readonly cursor: string | undefined
  readonly byModel: ReadonlyMap<string, Tokens>
  /** Sub-agents and reminder agents run in child sessions of their own. */
  readonly children: ReadonlySet<string>
}

const emptyTotal: SessionTotal = { cursor: undefined, byModel: new Map(), children: new Set() }

const decodeCompletion = Schema.decodeUnknownOption(CompletionUsage)
const decodeChild = Schema.decodeUnknownOption(
  Schema.Struct({ item: Schema.Struct({ childSessionId: Schema.String }) }),
)
const decodeCursor = Schema.decodeUnknownOption(Schema.Struct({ viewCursor: Schema.String }))

const PAGE_SIZE = 1000

/**
 * Sums what a session and every agent it started spent, from their durable view events, which `view/page` reads
 * without loading the session. Each session's sum is kept with its cursor, so a refresh pages only new events.
 */
export const makeSessionUsage = (
  page: (params: {
    sessionId: string
    cursor?: string
    limit: number
  }) => Effect.Effect<ViewPage, MuseCallError | AgentError>,
) => {
  const totals = new Map<string, SessionTotal>()

  const readSession = (sessionId: string) =>
    Effect.gen(function* () {
      const known = totals.get(sessionId) ?? emptyTotal
      const byModel = new Map(known.byModel)
      const children = new Set(known.children)
      let cursor = known.cursor
      while (true) {
        const result = yield* page({ sessionId, limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) })
        for (const { method, params } of result.events) {
          if (method === "session/tokenUsage") {
            Option.map(decodeCompletion(params), (completion) => {
              const model = completion.modelId ?? "unknown"
              byModel.set(model, addTokens(byModel.get(model) ?? noTokens, completionTokens(completion)))
            })
          }
          if (method === "item/completed")
            Option.map(decodeChild(params), ({ item }) => children.add(item.childSessionId))
          cursor = Option.match(decodeCursor(params), { onNone: () => cursor, onSome: (event) => event.viewCursor })
        }
        if (result.nextCursor === null) break
        cursor = result.nextCursor
      }
      const total: SessionTotal = { cursor, byModel, children }
      totals.set(sessionId, total)
      return total
    })

  /** Null when the session has no durable log. A child without one, such as a reminder that wrote none, is skipped. */
  const read = (sessionId: string): Effect.Effect<ThreadUsage | null, MuseCallError | AgentError> =>
    Effect.gen(function* () {
      const pending = [sessionId]
      const seen = new Set<string>()
      const found: Array<SessionTotal> = []
      while (pending.length > 0) {
        const id = pending.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        const total = yield* readSession(id).pipe(
          Effect.map(Option.some),
          Effect.catchIf(
            (error) => error._tag === "MuseCallError" && error.kind === "sessionNotFound",
            () => Effect.succeedNone,
          ),
        )
        if (Option.isNone(total)) {
          if (id === sessionId) return null
          continue
        }
        found.push(total.value)
        pending.push(...total.value.children)
      }
      const spent = found.flatMap((total) => [...total.byModel].map(([model, tokens]) => ({ model, tokens })))
      return toThreadUsage(spent, found.length)
    })

  return read
}
