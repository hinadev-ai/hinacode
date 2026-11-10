import type { ArtifactComment, ArtifactKind } from "./artifact.ts"
import { MENTION } from "./mentions.ts"

type ArtifactRef = { readonly id: string; readonly kind?: ArtifactKind; readonly title: string }

type FeedbackPromptInput = {
  readonly artifact: ArtifactRef
  readonly comment: ArtifactComment
  readonly elements?: string
  readonly mentioned?: boolean
}

const kindNames: Record<ArtifactKind, string> = {
  page: "page",
  document: "document",
  whiteboard: "whiteboard",
}

const quoted = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

const anchorLines = (comment: ArtifactComment, elements: string | undefined) => {
  switch (comment.anchor.kind) {
    case "artifact":
      return []
    case "text":
      return [quoted(comment.anchor.quote)]
    case "elements":
      return [`About elements ${comment.anchor.ids.join(", ")}:`, ...(elements === undefined ? [] : [elements])]
  }
}

const answerLine = (kind: ArtifactKind, comment: ArtifactComment) => {
  if (kind === "document") return "Answer with comment_on_artifact, and change the document if needed."
  if (kind === "whiteboard") {
    return comment.anchor.kind === "elements"
      ? "Answer with comment_on_artifact, and change the whiteboard with publish_whiteboard if needed, placing new elements next to these."
      : "Answer with comment_on_artifact, and change the whiteboard with publish_whiteboard if needed."
  }
  return "Answer with comment_on_artifact."
}

export const artifactFeedbackPrompt = ({ artifact, comment, elements, mentioned }: FeedbackPromptInput) => {
  const kind = artifact.kind ?? "page"
  const latest = comment.messages.at(-1)
  const what = comment.messages.length > 1 ? "Reply" : "Comment"
  return [
    `${what} on ${kindNames[kind]} ${JSON.stringify(artifact.title)} (artifact ${artifact.id}, comment ${comment.id}):`,
    ...anchorLines(comment, elements),
    latest?.body ?? "",
    "",
    ...(mentioned === true ? ["You were mentioned. Read the artifact with read_artifact first."] : []),
    answerLine(kind, comment),
  ].join("\n")
}

export const feedbackTargets = (body: string): ReadonlyArray<string> => {
  const mentioned = new Set<string>()
  for (const [, kind, id] of body.matchAll(MENTION)) if (kind === "thread" && id !== undefined) mentioned.add(id)
  return [...mentioned]
}
