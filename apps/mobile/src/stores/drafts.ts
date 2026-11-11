import type { Attachment } from "@shared/domain.ts"
import { create } from "zustand"

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

export interface Workspace {
  readonly mode: "local" | "worktree"
  readonly ref: string
}

interface DraftsState {
  readonly byThreadId: Readonly<Record<string, string>>
  readonly images: Readonly<Record<string, readonly DraftImage[]>>
  readonly workspaces: Readonly<Record<string, Workspace>>
  readonly sending: Readonly<Record<string, readonly SendingPrompt[]>>
  readonly setText: (threadId: string, text: string) => void
  readonly addImages: (threadId: string, images: readonly DraftImage[]) => void
  readonly removeImage: (threadId: string, id: string) => void
  readonly setWorkspace: (threadId: string, workspace: Workspace | null) => void
  readonly take: (threadId: string) => Draft
  readonly restore: (threadId: string, draft: Draft) => void
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
