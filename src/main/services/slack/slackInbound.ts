import { Schema } from "effect"
import type { SlackOwner, ThreadStatus } from "../../../shared/domain.ts"

export const DirectMessage = Schema.Struct({
  event: Schema.Struct({
    type: Schema.Literal("message"),
    channel_type: Schema.Literal("im"),
    channel: Schema.String,
    ts: Schema.String,
    user: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    bot_id: Schema.optionalKey(Schema.String),
    subtype: Schema.optionalKey(Schema.String),
  }),
})
export type DirectMessage = typeof DirectMessage.Type

export interface InboundState {
  readonly pairingCode: string | null
}

export type Decision =
  | { readonly type: "ignore" }
  | {
      readonly type: "pair"
      readonly userId: string
      readonly message: { readonly channel: string; readonly ts: string }
    }

const ignore: Decision = { type: "ignore" }

export const decide = ({ event }: DirectMessage, { pairingCode }: InboundState): Decision => {
  if (event.bot_id !== undefined || event.subtype !== undefined || event.user === undefined) return ignore
  if (pairingCode === null || event.text?.trim().toUpperCase() !== pairingCode) return ignore
  return { type: "pair", userId: event.user, message: { channel: event.channel, ts: event.ts } }
}

export const AskEvent = Schema.Struct({
  is_ext_shared_channel: Schema.optionalKey(Schema.Boolean),
  event: Schema.Struct({
    type: Schema.Literals(["app_mention", "message"]),
    channel_type: Schema.optionalKey(Schema.String),
    channel: Schema.String,
    ts: Schema.String,
    thread_ts: Schema.optionalKey(Schema.String),
    user: Schema.optionalKey(Schema.String),
    user_team: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    bot_id: Schema.optionalKey(Schema.String),
    subtype: Schema.optionalKey(Schema.String),
  }),
})
export type AskEvent = typeof AskEvent.Type

export interface SlackAsk {
  readonly channel: string
  readonly ts: string
  readonly threadTs: string
  readonly inThread: boolean
  readonly user: string
  readonly userTeam: string | null
  readonly text: string
  readonly external: boolean
}

export const askOf = ({ event, is_ext_shared_channel }: AskEvent): SlackAsk | null => {
  if (event.bot_id !== undefined || event.subtype !== undefined || event.user === undefined) return null
  if (event.type === "message" && event.channel_type !== "im") return null
  return {
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts ?? event.ts,
    inThread: event.thread_ts !== undefined,
    user: event.user,
    userTeam: event.user_team ?? null,
    text: event.text ?? "",
    external: is_ext_shared_channel === true,
  }
}

export interface AskState {
  readonly owner: SlackOwner | null
  readonly routine: { readonly id: string; readonly enabled: boolean } | null
  readonly linked: { readonly threadId: string; readonly status: ThreadStatus; readonly deliveredTs: string } | null
}

export type Refusal = "notOwner" | "externalChannel" | "threadWaiting" | "noRoutine" | "routineDisabled"

export type AskDecision =
  | { readonly type: "ignore" }
  | { readonly type: "refuse"; readonly reason: Refusal }
  | { readonly type: "start"; readonly routineId: string }
  | { readonly type: "continue"; readonly threadId: string }

const refuse = (reason: Refusal): AskDecision => ({ type: "refuse", reason })

const clock = (ts: string) => {
  const [seconds = "0", micros = "0"] = ts.split(".")
  return [Number(seconds), Number(micros)] as const
}

export const isAfter = (ts: string, other: string) => {
  const [seconds, micros] = clock(ts)
  const [otherSeconds, otherMicros] = clock(other)
  return seconds > otherSeconds || (seconds === otherSeconds && micros > otherMicros)
}

export const decideAsk = (ask: SlackAsk, { owner, routine, linked }: AskState): AskDecision => {
  const fromOwner =
    owner !== null && ask.user === owner.userId && (ask.userTeam === null || ask.userTeam === owner.teamId)
  if (!fromOwner) return refuse("notOwner")
  if (ask.external) return refuse("externalChannel")
  if (linked !== null) {
    if (!isAfter(ask.ts, linked.deliveredTs)) return { type: "ignore" }
    return linked.status === "idle" || linked.status === "running"
      ? { type: "continue", threadId: linked.threadId }
      : refuse("threadWaiting")
  }
  if (routine === null) return refuse("noRoutine")
  if (!routine.enabled) return refuse("routineDisabled")
  return { type: "start", routineId: routine.id }
}
