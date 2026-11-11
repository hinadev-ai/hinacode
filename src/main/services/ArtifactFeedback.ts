import {
  type Artifact,
  ArtifactError,
  type ArtifactStore,
  describeScene,
  parseScene,
  WHITEBOARD_ENTRY,
} from "@hinacode/artifacts"
import { Context, Effect, Layer, Schema } from "effect"
import type {
  ArtifactComment,
  ArtifactFeedback as Feedback,
  CommentAnchor,
  CommentMessage,
} from "../../shared/artifact.ts"
import { artifactFeedbackPrompt, feedbackTargets } from "../../shared/artifactFeedback.ts"
import type { Attachment, Thread } from "../../shared/domain.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { Artifacts } from "./Artifacts.ts"
import { Events } from "./Events.ts"
import { NotFoundError } from "./errors.ts"
import { Messages } from "./Messages.ts"
import { Threads } from "./Threads.ts"

export class ArtifactFeedbackError extends Schema.TaggedError<ArtifactFeedbackError>()("ArtifactFeedbackError", {
  message: Schema.String,
}) {}

type CommentRequest = {
  readonly id: string
  readonly comment?: string
  readonly anchor?: CommentAnchor
  readonly body: string
  readonly attachments?: ReadonlyArray<Attachment>
}

type FeedbackError = NotFoundError | ArtifactFeedbackError

export class ArtifactFeedback extends Context.Service<
  ArtifactFeedback,
  {
    readonly feedback: (id: string) => Effect.Effect<Feedback, NotFoundError>
    readonly comment: (input: CommentRequest) => Effect.Effect<Feedback, FeedbackError>
    readonly resolveComment: (input: {
      readonly id: string
      readonly comment: string
      readonly resolved: boolean
    }) => Effect.Effect<Feedback, FeedbackError>
  }
>()("hinacode/ArtifactFeedback") {}

const writableAnchor = (anchor: CommentAnchor) =>
  anchor.kind === "elements" ? { kind: anchor.kind, ids: [...anchor.ids] } : anchor

const selectedElements = async (store: ArtifactStore, id: string, ids: ReadonlyArray<string>) => {
  const file = await store.file(id, WHITEBOARD_ENTRY)
  const scene = file === null ? null : parseScene(new TextDecoder().decode(file.bytes))
  const isSelected = (elementId: unknown) => typeof elementId === "string" && ids.includes(elementId)
  const selected = (scene?.elements ?? []).filter(
    (element) => isSelected(element.id) || isSelected(element["containerId"]),
  )
  return selected.length === 0 ? undefined : describeScene(selected)
}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      cause instanceof ArtifactError
        ? Effect.fail(new ArtifactFeedbackError({ message: cause.message }))
        : Effect.die(cause),
    ),
  )

type Undelivered = {
  readonly artifact: Artifact
  readonly comment: ArtifactComment
  readonly message: CommentMessage
}

const deliveryId = (message: CommentMessage, threadId: string) => `${message.id}-${threadId}`

const undeliveredIn = (artifact: Artifact, feedback: Feedback): ReadonlyArray<Undelivered> =>
  feedback.comments.flatMap((comment) =>
    comment.messages.flatMap((message, index) =>
      message.undelivered === true
        ? [
            {
              artifact,
              comment: { ...comment, messages: [comment.messages[0], ...comment.messages.slice(1, index + 1)] },
              message,
            },
          ]
        : [],
    ),
  )

const make = Effect.gen(function* () {
  const { store } = yield* Artifacts
  const runner = yield* AgentRunner
  const threads = yield* Threads
  const messages = yield* Messages
  const events = yield* Events

  const existing = (id: string) =>
    Effect.flatMap(
      Effect.promise(() => store.get(id)),
      (artifact): Effect.Effect<Artifact, NotFoundError> =>
        artifact === null ? Effect.fail(new NotFoundError({ entity: "artifact", id })) : Effect.succeed(artifact),
    )

  const reopenArchived = (thread: Thread) =>
    thread.status === "archived"
      ? threads
          .unarchive(thread.id)
          .pipe(Effect.flatMap((reopened) => events.publish({ type: "thread.updated", thread: reopened })))
      : Effect.void

  const archivedByDeveloper = (threadId: string) =>
    threads.get(threadId).pipe(
      Effect.map((thread) => thread.status === "archived"),
      Effect.catch(() => Effect.succeed(false)),
    )

  const deliver = (threadId: string, prompt: string, attachments: ReadonlyArray<Attachment>, messageId: string) =>
    threads.get(threadId).pipe(
      Effect.flatMap(reopenArchived),
      Effect.andThen(
        runner
          .steer(threadId, prompt, attachments, messageId)
          .pipe(Effect.catchTag("AgentError", () => runner.queue(threadId, prompt, attachments, messageId))),
      ),
      Effect.as(true),
      Effect.catchTag("NotFoundError", () => Effect.succeed(true)),
      Effect.catchCause((cause) =>
        Effect.logWarning("artifact feedback did not reach a thread", threadId, cause).pipe(
          Effect.andThen(archivedByDeveloper(threadId)),
        ),
      ),
    )

  const inProject = (projectId: string | undefined) => (threadId: string) =>
    threads.get(threadId).pipe(
      Effect.map((target) => projectId === undefined || target.projectId === projectId),
      Effect.catch(() => Effect.succeed(false)),
    )

  const recipients = (body: string, ownerThreadId: string | undefined) =>
    Effect.gen(function* () {
      const owner =
        ownerThreadId === undefined
          ? undefined
          : yield* threads.get(ownerThreadId).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const mentioned = yield* Effect.filter(feedbackTargets(body), inProject(owner?.projectId))
      if (mentioned.length > 0) return mentioned
      return owner === undefined ? [] : [owner.id]
    })

  const feedback = (id: string) =>
    Effect.flatMap(
      Effect.promise(() => store.feedback(id)),
      (found) => (found === null ? Effect.fail(new NotFoundError({ entity: "artifact", id })) : Effect.succeed(found)),
    )

  const handOver = (
    { artifact, comment, message }: Undelivered,
    attachments: ReadonlyArray<Attachment>,
    alreadyHandedOver: (threadId: string, messageId: string) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const anchor = comment.anchor
      const elements =
        anchor.kind === "elements"
          ? yield* Effect.promise(() => selectedElements(store, artifact.id, anchor.ids))
          : undefined
      const settled = yield* Effect.forEach(yield* recipients(message.body, artifact.threadId), (threadId) => {
        const messageId = deliveryId(message, threadId)
        const prompt = artifactFeedbackPrompt({
          artifact,
          comment,
          mentioned: threadId !== artifact.threadId,
          ...(elements === undefined ? {} : { elements }),
        })
        return Effect.flatMap(alreadyHandedOver(threadId, messageId), (done) =>
          done ? Effect.succeed(true) : deliver(threadId, prompt, attachments, messageId),
        )
      })
      if (!settled.every(Boolean)) return undefined
      return yield* attempt(() => store.markDelivered(artifact.id, message.id))
    })

  const comment = ({ id, comment: replyTo, anchor, body, attachments = [] }: CommentRequest) =>
    Effect.gen(function* () {
      const artifact = yield* existing(id)
      const saved = yield* attempt(() =>
        store.comment(id, {
          author: { kind: "developer" },
          body,
          undelivered: true,
          ...(replyTo === undefined ? {} : { comment: replyTo }),
          ...(anchor === undefined ? {} : { anchor: writableAnchor(anchor) }),
        }),
      )
      const delivered = yield* handOver(
        { artifact, comment: saved.comment, message: saved.comment.messages.at(-1)! },
        attachments,
        () => Effect.succeed(false),
      )
      return delivered ?? saved.feedback
    })

  const resolveComment = ({ id, comment: commentId, resolved }: { id: string; comment: string; resolved: boolean }) =>
    Effect.andThen(
      existing(id),
      attempt(() => store.resolveComment(id, commentId, resolved)),
    )

  const handedOver = (threadId: string, messageId: string) =>
    Effect.gen(function* () {
      const { queue } = yield* threads.get(threadId)
      return queue.some((queued) => queued.id === messageId) || (yield* messages.has(messageId))
    }).pipe(Effect.catch(() => Effect.succeed(false)))

  const undeliveredOf = (artifact: Artifact) =>
    Effect.tryPromise(() => store.feedback(artifact.id)).pipe(
      Effect.map((saved) => (saved === null ? [] : undeliveredIn(artifact, saved))),
      Effect.catch((cause) =>
        Effect.as(Effect.logWarning("artifact feedback could not be read", artifact.id, cause), []),
      ),
    )

  const redeliver = Effect.gen(function* () {
    const artifacts = yield* Effect.tryPromise(() => store.list())
    const pending = yield* Effect.forEach(artifacts, undeliveredOf, { concurrency: 8 })
    yield* Effect.forEach(
      pending.flat(),
      (undelivered) =>
        handOver(undelivered, [], handedOver).pipe(
          Effect.catchCause((cause) => Effect.logWarning("artifact feedback was not redelivered", cause)),
        ),
      { discard: true },
    )
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("artifact feedback recovery did not run", cause)))

  yield* Effect.forkScoped(redeliver)

  return ArtifactFeedback.of({ feedback, comment, resolveComment })
})

export const layer = Layer.effect(ArtifactFeedback, make)
