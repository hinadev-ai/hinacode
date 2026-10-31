import type { Attachment } from "@shared/domain.ts"
import { create } from "zustand"

/** An image staged on the desktop, with the phone's own copy to show while it waits in the draft. */
export interface DraftImage {
  readonly attachment: Attachment
  readonly preview: string
}

export interface Draft {
  readonly text: string
  readonly images: readonly DraftImage[]
}

export interface SendingPrompt {
  readonly id: number
  readonly text: string
}

/**
 * Where the first turn runs. `ref` is what the user typed: a branch, or a pull request number or URL.
 * `local` switches the project root to it, `worktree` makes a new worktree from it.
 */
export interface Workspace {
  readonly mode: "local" | "worktree"
  readonly ref: string
}

interface DraftsState {
  readonly byThreadId: Readonly<Record<string, string>>
  readonly images: Readonly<Record<string, readonly DraftImage[]>>
  /** Picked before the first message. A thread without one runs in the project root as it is. */
  readonly workspaces: Readonly<Record<string, Workspace>>
  /** Prompts sent but not answered yet, shown until the desktop accepts or finally refuses them. */
  readonly sending: Readonly<Record<string, readonly SendingPrompt[]>>
  readonly setText: (threadId: string, text: string) => void
  readonly addImages: (threadId: string, images: readonly DraftImage[]) => void
  readonly removeImage: (threadId: string, id: string) => void
  readonly setWorkspace: (threadId: string, workspace: Workspace | null) => void
  /** Empties the draft for sending and returns what it held, so anything typed while the send is pending is kept. */
  readonly take: (threadId: string) => Draft
  /** Puts a draft whose send failed back in front of whatever was typed since. */
  readonly restore: (threadId: string, draft: Draft) => void
  /** Runs `send` for `text`, listing it as sending until it settles. */
  readonly trackSending: <T>(threadId: string, text: string, send: () => Promise<T>) => Promise<T>
}

let nextSendingId = 1

const withText = (byThreadId: Readonly<Record<string, string>>, threadId: string, text: string) => {
  const { [threadId]: _previous, ...rest } = byThreadId
  return text === "" ? rest : { ...rest, [threadId]: text }
}

const withImages = (
  byThreadId: Readonly<Record<string, readonly DraftImage[]>>,
  threadId: string,
  images: readonly DraftImage[],
) => {
  const { [threadId]: _previous, ...rest } = byThreadId
  return images.length === 0 ? rest : { ...rest, [threadId]: images }
}

/** Unsent composer text per thread, so it survives tab and thread switches. Kept in memory only. */
export const useDrafts = create<DraftsState>()((set, get) => ({
  byThreadId: {},
  images: {},
  workspaces: {},
  sending: {},
  setText: (threadId, text) => set((state) => ({ byThreadId: withText(state.byThreadId, threadId, text) })),
  addImages: (threadId, images) =>
    set((state) => ({ images: withImages(state.images, threadId, [...(state.images[threadId] ?? []), ...images]) })),
  removeImage: (threadId, id) =>
    set((state) => ({
      images: withImages(
        state.images,
        threadId,
        (state.images[threadId] ?? []).filter((image) => image.attachment.id !== id),
      ),
    })),
  setWorkspace: (threadId, workspace) =>
    set((state) => {
      const { [threadId]: _previous, ...rest } = state.workspaces
      return { workspaces: workspace === null ? rest : { ...rest, [threadId]: workspace } }
    }),
  take: (threadId) => {
    const draft = { text: get().byThreadId[threadId] ?? "", images: get().images[threadId] ?? [] }
    set((state) => ({
      byThreadId: withText(state.byThreadId, threadId, ""),
      images: withImages(state.images, threadId, []),
    }))
    return draft
  },
  restore: (threadId, sent) => {
    const typed = get().byThreadId[threadId] ?? ""
    get().setText(threadId, [sent.text, typed].filter((text) => text !== "").join("\n"))
    set((state) => ({
      images: withImages(state.images, threadId, [...sent.images, ...(state.images[threadId] ?? [])]),
    }))
  },
  trackSending: (threadId, text, send) => {
    const prompt = { id: nextSendingId++, text }
    const update = (change: (prompts: readonly SendingPrompt[]) => readonly SendingPrompt[]) =>
      set((state) => {
        const { [threadId]: prompts = [], ...rest } = state.sending
        const next = change(prompts)
        return { sending: next.length === 0 ? rest : { ...rest, [threadId]: next } }
      })
    update((prompts) => [...prompts, prompt])
    return send().finally(() => update((prompts) => prompts.filter((existing) => existing !== prompt)))
  },
}))
