import { Effect, Layer, Option, Schema, Stream } from "effect"
import { Events } from "../Events.ts"
import { Routines } from "../routines/Routines.ts"
import { Settings } from "../Settings.ts"
import { Threads } from "../Threads.ts"
import { Slack, type SlackBot, type SlackEvent } from "./Slack.ts"
import { AskEvent, askOf, decideAsk, type SlackAsk } from "./slackInbound.ts"
import { BOT_NAME, failureText, peopleIn, refusalText, renderTranscript, select } from "./slackPrompt.ts"

export const HEARD_REACTION = "eyes"

const NAME_LOOKUPS = 4

const decodeAsk = Schema.decodeUnknownOption(AskEvent)

const make = Effect.gen(function* () {
  const slack = yield* Slack
  const settings = yield* Settings
  const threads = yield* Threads
  const routines = yield* Routines
  const events = yield* Events

  const whisper = (ask: SlackAsk, text: string) =>
    slack
      .whisper({ channel: ask.channel, user: ask.user, text, threadTs: ask.inThread ? ask.threadTs : null })
      .pipe(Effect.catch((error) => Effect.logWarning("could not answer a Slack message", error.message)))

  const namesOf = (bot: SlackBot, userIds: ReadonlyArray<string>) =>
    Effect.forEach(
      userIds.filter((id) => id !== bot.userId),
      (id) =>
        slack.userName(id).pipe(
          Effect.orElseSucceed(() => id),
          Effect.map((name) => [id, name] as const),
        ),
      { concurrency: NAME_LOOKUPS },
    ).pipe(Effect.map((entries) => new Map([...entries, [bot.userId, BOT_NAME]])))

  const judge = (bot: SlackBot, ask: SlackAsk) =>
    Effect.gen(function* () {
      const { slack: paired, experimental } = yield* settings.get
      const owner = experimental.slack && paired.owner?.teamId === bot.teamId ? paired.owner : null
      const linked = yield* threads.bySlack(ask.channel, ask.threadTs)
      const routine =
        paired.routineId === null
          ? null
          : yield* routines.get(paired.routineId).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)))
      const decision = decideAsk(ask, {
        owner,
        routine,
        deliveredTs: Option.getOrNull(linked)?.slack?.deliveredTs ?? null,
      })
      return { decision, owner }
    })

  const start = (bot: SlackBot, ask: SlackAsk) =>
    Effect.gen(function* () {
      const root = { channel: ask.channel, ts: ask.threadTs }
      const { kept, omitted } = select(yield* slack.thread(root), ask)
      const permalink = yield* slack.permalink(root)
      const names = yield* namesOf(bot, peopleIn(kept))
      const { decision, owner } = yield* judge(bot, ask)
      if (decision.type === "refuse") return yield* whisper(ask, refusalText(decision.reason, owner))
      if (decision.type === "ignore") return
      const run = yield* routines.run(
        decision.routineId,
        "slack",
        renderTranscript({ permalink, kept, omitted, names, developerId: ask.user }),
        `slack:${ask.channel}:${ask.ts}`,
      )
      if (run.status === "failed") return yield* whisper(ask, failureText(run.error ?? "the routine failed"))
      if (run.status !== "started" || run.threadId === null) return
      const thread = yield* threads.linkSlack(run.threadId, {
        channelId: ask.channel,
        threadTs: ask.threadTs,
        permalink,
        deliveredTs: kept.at(-1)?.ts ?? ask.ts,
      })
      yield* events.publish({ type: "thread.updated", thread })
      if (thread.slack === null) return
      yield* slack
        .react({ channel: ask.channel, ts: ask.ts }, HEARD_REACTION)
        .pipe(Effect.catch((error) => Effect.logWarning("could not mark a Slack message as heard", error.message)))
    }).pipe(Effect.catch((error) => whisper(ask, failureText(error.message))))

  const handle = ({ bot, payload }: SlackEvent) =>
    Effect.gen(function* () {
      const event = decodeAsk(payload)
      const ask = Option.isSome(event) ? askOf(event.value) : null
      if (ask === null) return
      const { decision, owner } = yield* judge(bot, ask)
      if (decision.type === "refuse") return yield* whisper(ask, refusalText(decision.reason, owner))
      if (decision.type === "start") return yield* start(bot, ask)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("could not handle a Slack request", cause)))

  yield* (yield* slack.inbound).pipe(Stream.runForEach(handle), Effect.forkScoped)
})

export const layer = Layer.effectDiscard(make)
