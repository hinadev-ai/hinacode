import type { PushEvent, RpcEnvelope } from "../../src/shared/contract.ts"

export type RecordedCall = {
  readonly kind: "call"
  readonly at: number
  readonly method: string
  readonly payload: unknown
  readonly envelope: RpcEnvelope<unknown>
}

export type RecordedEvent = { readonly kind: "event"; readonly at: number; readonly event: typeof PushEvent.Encoded }

export type Recording = { readonly recordedAt: number; readonly entries: ReadonlyArray<RecordedCall | RecordedEvent> }
