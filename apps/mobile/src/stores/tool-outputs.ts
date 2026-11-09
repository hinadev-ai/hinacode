import { create } from "zustand"
import { call } from "@/lib/connection"
import { errorText } from "@/lib/error-text"
import { shownOutput } from "@/lib/tool-call"

export type ToolOutputState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "error"; readonly message: string }

interface ToolOutputsState {
  readonly byCall: Readonly<Record<string, ToolOutputState>>
  readonly load: (threadId: string, callId: string) => Promise<void>
}

export const toolOutputKey = (threadId: string, callId: string) => `${threadId}:${callId}`

/**
 * Compact transcripts ship tool calls without their output, so a row fetches it when someone opens it. Rows
 * unmount as the transcript scrolls, so the result lives here instead of in the row.
 */
export const useToolOutputs = create<ToolOutputsState>()((set, get) => {
  const put = (key: string, state: ToolOutputState) =>
    set((current) => ({ byCall: { ...current.byCall, [key]: state } }))
  return {
    byCall: {},
    load: async (threadId, callId) => {
      const key = toolOutputKey(threadId, callId)
      if (get().byCall[key]?.status === "loading") return
      put(key, { status: "loading" })
      try {
        put(key, { status: "ready", ...shownOutput(await call("threads.toolOutput", { threadId, callId })) })
      } catch (cause) {
        put(key, { status: "error", message: errorText(cause) })
      }
    },
  }
})
