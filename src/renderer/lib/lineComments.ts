import { fenceFor } from "../../shared/fence.ts"
import type { LineComment } from "../stores/drafts.ts"

export const lineRange = ({ startLine, endLine }: Pick<LineComment, "startLine" | "endLine">) =>
  startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`

const commentBlock = (comment: LineComment) => {
  const fence = fenceFor(comment.code)
  return [`${comment.path}:${lineRange(comment)}`, fence, comment.code, fence, comment.body].join("\n")
}

/** What the agent receives for a draft: the typed text, then every line comment with the code it is about. */
export const promptWithComments = (text: string, comments: ReadonlyArray<LineComment>) => {
  const typed = text.trim()
  if (comments.length === 0) return typed
  const block = ["Comments on lines of the workspace:", ...comments.map(commentBlock)].join("\n\n")
  return typed === "" ? block : `${typed}\n\n${block}`
}
