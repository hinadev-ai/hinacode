import { Schema } from "effect"

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
