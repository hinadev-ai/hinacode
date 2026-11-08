import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { Atom, AsyncResult } from "effect/reactivity"
import { useContext } from "react"
import type { Artifact, ArtifactFeedback, CommentAnchor, VerdictDecision } from "../../../shared/artifact.ts"
import { call, callPromise, type EnvironmentId, familyOf, onPushEvent } from "../../lib/rpc.ts"

export const feedbackAtom = familyOf((environment: EnvironmentId, id: string) =>
  Atom.make((get) => {
    get.addFinalizer(
      onPushEvent((event) => {
        if (event.type === "artifact.feedback" && event.id === id) get.refreshSelf()
      }),
    )
    return call("artifacts.feedback", { id }, { environment })
  }),
)

const noFeedback: ArtifactFeedback = { comments: [], verdicts: [] }

const feedbackOf = (artifact: Artifact) => feedbackAtom(artifact.environmentId ?? null, artifact.id)

export const useFeedback = (artifact: Artifact) => useAtomValue(feedbackOf(artifact))

export const loadedFeedback = (result: AsyncResult.AsyncResult<ArtifactFeedback, unknown>) =>
  AsyncResult.getOrElse(result, () => noFeedback)

export type FeedbackActions = ReturnType<typeof useFeedbackActions>

export function useFeedbackActions(artifact: Artifact) {
  const registry = useContext(RegistryContext)
  const options = { environment: artifact.environmentId }
  const refreshed = async (saved: Promise<ArtifactFeedback>) => {
    await saved
    registry.refresh(feedbackOf(artifact))
  }
  return {
    comment: (input: { readonly body: string; readonly anchor?: CommentAnchor; readonly comment?: string }) =>
      refreshed(callPromise("artifacts.comment", { id: artifact.id, ...input }, options)),
    resolve: (comment: string, resolved: boolean) =>
      refreshed(callPromise("artifacts.resolveComment", { id: artifact.id, comment, resolved }, options)),
    decide: (decision: VerdictDecision, reason: string) =>
      refreshed(
        callPromise("artifacts.decide", { id: artifact.id, version: artifact.version, decision, reason }, options),
      ),
  }
}
