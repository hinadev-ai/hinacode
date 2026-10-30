import type { ForkPoint, ProviderId } from "../../shared/agent.ts"
import type { Message } from "../../shared/domain.ts"
import { renderTranscript } from "./handoff.ts"

export const latestForkPoint = (provider: ProviderId, history: ReadonlyArray<Message>): ForkPoint | null =>
  history.findLast(
    (message) => message.forkPoint !== null && (message.forkPoint.owner?.provider ?? provider) === provider,
  )?.forkPoint ?? null

const isAt = (forkedFrom: Omit<ForkPoint, "owner">) => (message: Message) =>
  message.forkPoint?.sessionId === forkedFrom.sessionId && message.forkPoint.checkpoint === forkedFrom.checkpoint

export const unseenSince = (
  history: ReadonlyArray<Message>,
  forkedFrom: Omit<ForkPoint, "owner"> | null,
): ReadonlyArray<Message> => (forkedFrom === null ? history : history.slice(history.findIndex(isAt(forkedFrom)) + 1))

export function sidechatPrompt(input: { readonly unseen: ReadonlyArray<Message>; readonly prompt: string }): string {
  const transcript = renderTranscript(input.unseen)
  return [
    "<side_chat>",
    "This is a side chat. The developer asks you something while the main agent keeps working on this conversation in the same workspace. Answer it, and do not edit files or run commands that change anything.",
    ...(transcript === ""
      ? []
      : [
          "The main conversation went on after your history ends. Here is the rest, oldest first. Tool output is left out, and the last message may still be in progress.",
          "",
          transcript,
        ]),
    "</side_chat>",
    "",
    input.prompt,
  ].join("\n")
}
