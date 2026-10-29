import type { MessagePart } from "./domain.ts"

export const isActivity = (part: MessagePart) =>
  part.type === "reasoning" || part.type === "tool_call" || part.type === "file_change"

export function collapsedParts<T extends { readonly part: MessagePart }>(parts: ReadonlyArray<T>): ReadonlyArray<T> {
  const lastActivity = parts.findLastIndex(({ part }) => isActivity(part))
  const lastText = parts.findLastIndex(({ part }) => part.type === "text")
  const narrates = (position: number) => position < lastActivity && position !== lastText
  return parts.filter(({ part }, position) => !isActivity(part) && !(part.type === "text" && narrates(position)))
}
