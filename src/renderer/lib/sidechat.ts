import type { AgentCommand } from "../../shared/agent.ts"
import { type Attachment, isThreadBusy } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { callPromise } from "./rpc.ts"

export const sidechatCommand = (): AgentCommand => ({
  trigger: "/",
  name: "sidechat",
  description: m.sidechat_command_description(),
  argumentHint: m.sidechat_command_hint(),
  builtin: true,
})

const SIDECHAT_PROMPT = /^\/sidechat(?:\s+([\s\S]*))?$/

export const sidechatQuestion = (text: string): string | null => {
  const match = SIDECHAT_PROMPT.exec(text.trim())
  return match === null ? null : (match[1] ?? "").trim()
}

export const openSidechat = async (threadId: string) => {
  const sidechat = await callPromise("threads.sidechat", { threadId })
  useThreads.getState().upsert(sidechat)
  return sidechat
}

export async function askSidechat(threadId: string, question: string, attachments: ReadonlyArray<Attachment>) {
  useUi.getState().showView(threadId, "sidechat", { focus: true })
  if (question === "" && attachments.length === 0) return
  const sidechat = await openSidechat(threadId)
  await (isThreadBusy(sidechat.status)
    ? callPromise("threads.queue", { threadId: sidechat.id, text: question, attachments })
    : callPromise("threads.send", { threadId: sidechat.id, prompt: question, attachments }))
}
