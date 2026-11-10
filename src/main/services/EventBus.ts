import { Context, Layer, PubSub } from "effect"

export interface PullRequestLinkedEvent {
  readonly topic: "pullRequest.linked"
  readonly threadId: string
  readonly linkId: string
  readonly url: string
}

export type BusEvent = PullRequestLinkedEvent

export class EventBus extends Context.Service<EventBus, PubSub.PubSub<BusEvent>>()("hinacode/EventBus") {}

const RING_CAPACITY = 256

export const layer = Layer.effect(EventBus, PubSub.sliding<BusEvent>(RING_CAPACITY))
