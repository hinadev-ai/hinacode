import { Context, Layer, PubSub } from "effect"
import type { PullRequest, PullRequestTopic } from "../../shared/domain.ts"

export interface PullRequestEvent {
  readonly topic: PullRequestTopic
  readonly threadId: string
  readonly pullRequest: PullRequest
}

export interface PullRequestLinkedEvent {
  readonly topic: "pullRequest.linked"
  readonly threadId: string
  readonly linkId: string
  readonly url: string
}

export type BusEvent = PullRequestLinkedEvent | PullRequestEvent

export class EventBus extends Context.Service<EventBus, PubSub.PubSub<BusEvent>>()("hinacode/EventBus") {}

const RING_CAPACITY = 256

export const layer = Layer.effect(EventBus, PubSub.sliding<BusEvent>(RING_CAPACITY))
