import type { MessagePart } from "./domain.ts"

/** Reasoning, tool calls and file changes. A finished response folds them behind its Worked for row. */
export const isActivity = (part: MessagePart) =>
  part.type === "reasoning" || part.type === "tool_call" || part.type === "file_change"

/**
 * What a finished response shows with its activity folded: no activity, and none of the text written before the
 * last of it, which narrated the work rather than answering. A response the user steered or stopped mid-work keeps
 * its last text anyway, because that is what the user's next message answers.
 */
export function collapsedParts<T extends { readonly part: MessagePart }>(parts: ReadonlyArray<T>): ReadonlyArray<T> {
  const lastActivity = parts.findLastIndex(({ part }) => isActivity(part))
  const lastText = parts.findLastIndex(({ part }) => part.type === "text")
  const narrates = (position: number) => position < lastActivity && position !== lastText
  return parts.filter(({ part }, position) => !isActivity(part) && !(part.type === "text" && narrates(position)))
}
