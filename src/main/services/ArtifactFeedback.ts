import {
  type Artifact,
  ArtifactError,
  type ArtifactStore,
  describeScene,
  parseScene,
  WHITEBOARD_ENTRY,
} from "@hinacode/artifacts"
import { Context, Effect, Layer, Schema } from "effect"
import type { ArtifactFeedback as Feedback, CommentAnchor, VerdictDecision } from "../../shared/artifact.ts"
import { artifactFeedbackPrompt, feedbackTargets } from "../../shared/artifactFeedback.ts"
import type { Attachment } from "../../shared/domain.ts"
import { AgentRunner } from "./AgentRunner.ts"
import { Artifacts } from "./Artifacts.ts"
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
    readonly decide: (input: {
      readonly id: string
      readonly version: number
      readonly decision: VerdictDecision
      readonly reason: string
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

  const existing = (id: string) =>
    Effect.flatMap(
      Effect.promise(() => store.get(id)),
      (artifact): Effect.Effect<Artifact, NotFoundError> =>
        artifact === null ? Effect.fail(new NotFoundError({ entity: "artifact", id })) : Effect.succeed(artifact),
    )

  const deliver = (threadId: string, prompt: string, attachments: ReadonlyArray<Attachment>) =>
    threads.get(threadId).pipe(
      Effect.andThen(
        runner
          .steer(threadId, prompt, attachments)
          .pipe(Effect.catchTag("AgentError", () => runner.queue(threadId, prompt, attachments))),
      ),
      Effect.catchTag("NotFoundError", () => Effect.void),
      Effect.catchCause((cause) => Effect.logWarning("artifact feedback did not reach a thread", threadId, cause)),
    )

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
        feedbackTargets(body, artifact.threadId),
        (threadId) =>
          deliver(
            threadId,
            artifactFeedbackPrompt({
              type: "comment",
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

  const decide = ({
    id,
    version,
    decision,
    reason,
  }: {
    id: string
    version: number
    decision: VerdictDecision
    reason: string
  }) =>
    Effect.gen(function* () {
      const artifact = yield* existing(id)
      const decided = yield* attempt(() => store.decide(id, { version, decision, reason }))
      const verdict = decided.verdicts.at(-1)
      if (artifact.threadId !== undefined && verdict !== undefined) {
        yield* deliver(artifact.threadId, artifactFeedbackPrompt({ type: "verdict", artifact, verdict }), [])
      }
      return decided
    })

  return ArtifactFeedback.of({ feedback, comment, resolveComment, decide })
})

export const layer = Layer.effect(ArtifactFeedback, make)
