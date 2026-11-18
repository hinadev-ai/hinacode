import { Effect, Layer, Option, Schema, Stream } from "effect"
import type { SlackLink } from "../../../shared/domain.ts"
import { AgentRunner } from "../AgentRunner.ts"
import { Events } from "../Events.ts"
import { promptWithPayload, Routines } from "../routines/Routines.ts"
import { Settings } from "../Settings.ts"
import { Threads } from "../Threads.ts"
import type { SlackMessage } from "./api.ts"
import { Slack, type SlackBot, type SlackEvent } from "./Slack.ts"
import { AskEvent, askOf, decideAsk, isAfter, type SlackAsk } from "./slackInbound.ts"
import { BOT_NAME, failureText, FOLLOW_UP, peopleIn, refusalText, renderTranscript, select } from "./slackPrompt.ts"

export const HEARD_REACTION = "eyes"

const NAME_LOOKUPS = 4

const decodeAsk = Schema.decodeUnknownOption(AskEvent)

const make = Effect.gen(function* () {
  const slack = yield* Slack
  const settings = yield* Settings
  const threads = yield* Threads
  const routines = yield* Routines
  const runner = yield* AgentRunner
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
      const thread = Option.getOrNull(yield* threads.bySlack(ask.channel, ask.threadTs))
      const routine =
        paired.routineId === null
          ? null
          : yield* routines.get(paired.routineId).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)))
      const link = thread?.slack ?? null
      const decision = decideAsk(ask, {
        owner,
        routine,
        linked:
          thread === null || link === null
            ? null
            : { threadId: thread.id, status: thread.status, deliveredTs: link.deliveredTs },
      })
      return { decision, owner, link }
    })

  const quote = (bot: SlackBot, ask: SlackAsk, permalink: string, messages: ReadonlyArray<SlackMessage>) =>
    Effect.gen(function* () {
      const { kept, omitted } = select(messages, ask)
      const names = yield* namesOf(bot, peopleIn(kept))
      return {
        transcript: renderTranscript({ permalink, kept, omitted, names, developerId: ask.user }),
        newestTs: kept.at(-1)?.ts ?? ask.ts,
      }
    })

  const heard = (ask: SlackAsk) =>
    slack
      .react({ channel: ask.channel, ts: ask.ts }, HEARD_REACTION)
      .pipe(Effect.catch((error) => Effect.logWarning("could not mark a Slack message as heard", error.message)))

  const start = (bot: SlackBot, ask: SlackAsk) =>
    Effect.gen(function* () {
      const root = { channel: ask.channel, ts: ask.threadTs }
      const messages = yield* slack.thread(root)
      const permalink = yield* slack.permalink(root)
      const { transcript, newestTs } = yield* quote(bot, ask, permalink, messages)
      const { decision, owner } = yield* judge(bot, ask)
      if (decision.type === "refuse") return yield* whisper(ask, refusalText(decision.reason, owner))
      if (decision.type !== "start") return
      const run = yield* routines.run(decision.routineId, "slack", transcript, `slack:${ask.channel}:${ask.ts}`)
      if (run.status === "failed") return yield* whisper(ask, failureText(run.error ?? "the routine failed"))
      if (run.status !== "started" || run.threadId === null) return
      const thread = yield* threads.linkSlack(run.threadId, {
        channelId: ask.channel,
        threadTs: ask.threadTs,
        permalink,
        deliveredTs: newestTs,
      })
      yield* events.publish({ type: "thread.updated", thread })
      if (thread.slack !== null) yield* heard(ask)
    })

  const stillContinues = (bot: SlackBot, ask: SlackAsk, threadId: string, cursor: SlackLink) =>
    judge(bot, ask).pipe(
      Effect.map(
        ({ decision, link }) =>
          decision.type === "continue" && decision.threadId === threadId && link?.deliveredTs === cursor.deliveredTs,
      ),
    )

  const resume = (bot: SlackBot, ask: SlackAsk, threadId: string, cursor: SlackLink) =>
    Effect.gen(function* () {
      const messages = yield* slack.thread({ channel: ask.channel, ts: ask.threadTs })
      const { transcript, newestTs } = yield* quote(
        bot,
        ask,
        cursor.permalink,
        messages.filter((message) => isAfter(message.ts, cursor.deliveredTs)),
      )
      const delivered = yield* runner.steerWhen({
        threadId,
        text: promptWithPayload(FOLLOW_UP, transcript),
        attachments: [],
        when: stillContinues(bot, ask, threadId, cursor),
      })
      if (!delivered) {
        const { decision, owner } = yield* judge(bot, ask)
        if (decision.type === "refuse") yield* whisper(ask, refusalText(decision.reason, owner))
        return
      }
      const thread = yield* threads.deliveredSlack(threadId, newestTs)
      yield* events.publish({ type: "thread.updated", thread })
      yield* heard(ask)
    })

  const handle = ({ bot, payload }: SlackEvent) =>
    Effect.gen(function* () {
      const event = decodeAsk(payload)
      const ask = Option.isSome(event) ? askOf(event.value) : null
      if (ask === null) return
      const { decision, owner, link } = yield* judge(bot, ask)
      if (decision.type === "refuse") return yield* whisper(ask, refusalText(decision.reason, owner))
      if (decision.type === "ignore") return
      const act =
        decision.type === "start" || link === null ? start(bot, ask) : resume(bot, ask, decision.threadId, link)
      return yield* act.pipe(Effect.catch((error) => whisper(ask, failureText(error.message))))
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("could not handle a Slack request", cause)))

  yield* (yield* slack.inbound).pipe(Stream.runForEach(handle), Effect.forkScoped)
})

export const layer = Layer.effectDiscard(make)
