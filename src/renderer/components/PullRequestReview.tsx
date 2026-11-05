import type { AnnotationSide, SelectedLineRange } from "@pierre/diffs"
import { createContext } from "react"
import { toast } from "sonner"
import type { DiffSide, LineComment, PullRequestComment, PullRequestFile } from "../../shared/domain.ts"
import { patchLines } from "../lib/patchLines.ts"
import { callPromise, type EnvironmentId } from "../lib/rpc.ts"
import { windowEntry } from "../lib/windowEntry.ts"
import { m } from "../paraglide/messages.js"
import { useDrafts } from "../stores/drafts.ts"
import { LineCommentForm } from "./LineComment.tsx"
import { Comment } from "./ThreadPullRequests.tsx"

export interface PullRequestReview {
  readonly environment: EnvironmentId
  readonly url: string
  readonly head: string
  readonly baseRef: string
  readonly threadId: string | undefined
  readonly comments: ReadonlyArray<PullRequestComment>
}

export const PullRequestReviewContext = createContext<PullRequestReview | null>(null)

export interface LineSelection {
  readonly side: DiffSide
  readonly startLine: number
  readonly endLine: number
}

const diffSide = (side: AnnotationSide | undefined): DiffSide => (side === "deletions" ? "LEFT" : "RIGHT")

export const annotationSide = (side: DiffSide): AnnotationSide => (side === "LEFT" ? "deletions" : "additions")

export const lineSelection = ({ start, end, side, endSide = side }: SelectedLineRange): LineSelection =>
  diffSide(side) === diffSide(endSide)
    ? { side: diffSide(endSide), startLine: Math.min(start, end), endLine: Math.max(start, end) }
    : { side: diffSide(endSide), startLine: end, endLine: end }

export const commentsOnLines = (comments: ReadonlyArray<PullRequestComment>, path: string) => {
  const byLine = new Map<string, { side: AnnotationSide; lineNumber: number; comments: Array<PullRequestComment> }>()
  for (const comment of comments) {
    const { location } = comment
    if (location?.path !== path || location.line === null) continue
    const side = annotationSide(location.side ?? "RIGHT")
    const key = `${side}:${location.line}`
    const onLine = byLine.get(key) ?? { side, lineNumber: location.line, comments: [] }
    onLine.comments.push(comment)
    byLine.set(key, onLine)
  }
  return [...byLine.values()]
}

const addToThread = async (threadId: string, comment: LineComment) => {
  if (windowEntry === null) useDrafts.getState().addComment(threadId, comment)
  else await callPromise("windows.addLineComment", { threadId, comment })
  toast.success(m.pr_review_comment_added())
}

export function ReviewCommentForm({
  review,
  file,
  selection,
  onDone,
}: {
  review: PullRequestReview
  file: PullRequestFile
  selection: LineSelection
  onDone: () => void
}) {
  const { environment, url, head, threadId } = review
  const { side, startLine, endLine } = selection

  const toGitHub = async (body: string) => {
    await callPromise(
      "github.reviewComment",
      { url, comment: { body, commit: head, path: file.path, side, startLine, endLine } },
      { environment },
    )
    onDone()
  }

  const toThread =
    threadId === undefined
      ? undefined
      : async (body: string) => {
          await addToThread(threadId, {
            id: crypto.randomUUID(),
            path: file.path,
            startLine,
            endLine,
            code: patchLines(file.patch, side, startLine, endLine),
            body,
          })
          onDone()
        }

  return (
    <LineCommentForm
      path={file.path}
      startLine={startLine}
      endLine={endLine}
      placeholder={m.pr_review_comment_placeholder()}
      submitLabel={toThread ? m.pr_review_comment_thread() : m.pr_review_comment_github()}
      onSubmit={toThread ?? toGitHub}
      alternate={toThread && { label: m.pr_review_comment_github(), onSubmit: toGitHub }}
      onCancel={onDone}
    />
  )
}

export function ReviewCommentThread({ comments }: { comments: ReadonlyArray<PullRequestComment> }) {
  return (
    <ul className="m-2 flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-background p-2.5 font-sans">
      {comments.map((comment) => (
        <Comment key={comment.id} comment={comment} showLocation={false} />
      ))}
    </ul>
  )
}
