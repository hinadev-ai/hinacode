import {
  type Artifact,
  ArtifactError,
  type ArtifactStore,
  describeScene,
  parseScene,
  WHITEBOARD_ENTRY,
} from "@hinacode/artifacts"
import { Context, Effect, Layer, Schema } from "effect"
import type { ArtifactFeedback as Feedback, CommentAnchor } from "../../shared/artifact.ts"
import { artifactFeedbackPrompt, feedbackTargets } from "../../shared/artifactFeedback.ts"
import type { Attachment, Thread } from "../../shared/domain.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { Artifacts } from "./Artifacts.ts"
import { Events } from "./Events.ts"
import { NotFoundError } from "./errors.ts"
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

const make = Effect.gen(function* () {
  const { store } = yield* Artifacts
  const runner = yield* AgentRunner
  const threads = yield* Threads
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

  const deliver = (threadId: string, prompt: string, attachments: ReadonlyArray<Attachment>) =>
    threads.get(threadId).pipe(
      Effect.flatMap(reopenArchived),
      Effect.andThen(
        runner
          .steer(threadId, prompt, attachments)
          .pipe(Effect.catchTag("AgentError", () => runner.queue(threadId, prompt, attachments))),
      ),
      Effect.catchTag("NotFoundError", () => Effect.void),
      Effect.catchCause((cause) => Effect.logWarning("artifact feedback did not reach a thread", threadId, cause)),
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
      const mentioned = yield* Effect.filter(feedbackTargets(body, undefined), inProject(owner?.projectId))
      if (mentioned.length > 0) return mentioned
      return owner === undefined ? [] : [owner.id]
    })

  const feedback = (id: string) =>
    Effect.flatMap(
      Effect.promise(() => store.feedback(id)),
      (found) => (found === null ? Effect.fail(new NotFoundError({ entity: "artifact", id })) : Effect.succeed(found)),
    )

  const comment = ({ id, comment: replyTo, anchor, body, attachments = [] }: CommentRequest) =>
    Effect.gen(function* () {
      const artifact = yield* existing(id)
      const saved = yield* attempt(() =>
        store.comment(id, {
          author: { kind: "developer" },
          body,
          ...(replyTo === undefined ? {} : { comment: replyTo }),
          ...(anchor === undefined ? {} : { anchor: writableAnchor(anchor) }),
        }),
      )
      const savedAnchor = saved.comment.anchor
      const elements =
        savedAnchor.kind === "elements"
          ? yield* Effect.promise(() => selectedElements(store, id, savedAnchor.ids))
          : undefined
      yield* Effect.forEach(
        yield* recipients(body, artifact.threadId),
        (threadId) =>
          deliver(
            threadId,
            artifactFeedbackPrompt({
              artifact,
              comment: saved.comment,
              mentioned: threadId !== artifact.threadId,
              ...(elements === undefined ? {} : { elements }),
            }),
            attachments,
          ),
        { discard: true },
      )
      return saved.feedback
    })

  const resolveComment = ({ id, comment: commentId, resolved }: { id: string; comment: string; resolved: boolean }) =>
    Effect.andThen(
      existing(id),
      attempt(() => store.resolveComment(id, commentId, resolved)),
    )

  return ArtifactFeedback.of({ feedback, comment, resolveComment })
})

export const layer = Layer.effect(ArtifactFeedback, make)
