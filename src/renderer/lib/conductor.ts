import type { AgentCommand } from "../../shared/agent.ts"
import { m } from "../paraglide/messages.js"
import { useMessages } from "../stores/messages.ts"
import { useThreads } from "../stores/threads.ts"
import { callPromise } from "./rpc.ts"

export const clearCommand = (): AgentCommand => ({
  trigger: "/",
  name: "clear",
  description: m.conductor_clear_description(),
  argumentHint: "",
  builtin: true,
})

export const isClearCommand = (prompt: string) => prompt.trim() === "/clear"

export async function clearConversation(threadId: string) {
  useThreads.getState().upsert(await callPromise("threads.clear", { threadId }))
  await useMessages.getState().reload(threadId)
}
