import { create } from "zustand"

interface DraftsState {
  readonly byThreadId: Readonly<Record<string, string>>
  readonly setText: (threadId: string, text: string) => void
  /** Empties the draft for sending and returns what it held, so anything typed while the send is pending is kept. */
  readonly take: (threadId: string) => string
  /** Puts a draft whose send failed back in front of whatever was typed since. */
  readonly restore: (threadId: string, text: string) => void
}

const withText = (byThreadId: Readonly<Record<string, string>>, threadId: string, text: string) => {
  const { [threadId]: _previous, ...rest } = byThreadId
  return text === "" ? rest : { ...rest, [threadId]: text }
}

/** Unsent composer text per thread, so it survives tab and thread switches. Kept in memory only. */
export const useDrafts = create<DraftsState>()((set, get) => ({
  byThreadId: {},
  setText: (threadId, text) => set((state) => ({ byThreadId: withText(state.byThreadId, threadId, text) })),
  take: (threadId) => {
    const text = get().byThreadId[threadId] ?? ""
    get().setText(threadId, "")
    return text
  },
  restore: (threadId, sent) => {
    const typed = get().byThreadId[threadId] ?? ""
    get().setText(threadId, [sent, typed].filter((text) => text !== "").join("\n"))
  },
}))
