import { create } from "zustand"
import type { Attachment } from "../../shared/domain.ts"

export interface Draft {
  readonly text: string
  readonly attachments: ReadonlyArray<Attachment>
  /** Before the first message only: run the thread in a new worktree. An empty base ref means the current branch. */
  readonly worktree: { readonly baseRef: string } | null
}

export const emptyDraft: Draft = { text: "", attachments: [], worktree: null }

interface DraftsState {
  readonly byThreadId: Readonly<Record<string, Draft>>
  readonly setText: (threadId: string, text: string) => void
  readonly addAttachments: (threadId: string, attachments: ReadonlyArray<Attachment>) => void
  readonly removeAttachment: (threadId: string, attachmentId: string) => void
  readonly setWorktree: (threadId: string, worktree: Draft["worktree"]) => void
  /** Empties the draft for sending and returns what it held, so anything typed while the send is pending is kept. */
  readonly take: (threadId: string) => Draft
  /** Puts a draft whose send failed back in front of whatever was typed since. */
  readonly restore: (threadId: string, draft: Draft) => void
  readonly discard: (threadId: string) => void
}

const withDraft = (byThreadId: Readonly<Record<string, Draft>>, threadId: string, draft: Draft) => {
  const { [threadId]: _previous, ...rest } = byThreadId
  return draft.text === "" && draft.attachments.length === 0 && draft.worktree === null
    ? rest
    : { ...rest, [threadId]: draft }
}

/**
 * Unsent composer text and staged attachments per thread. Lives outside the composer so it survives
 * thread switches, Settings and locale remounts. Kept in memory only, so drafts end with the app.
 */
export const useDrafts = create<DraftsState>()((set, get) => {
  const update = (threadId: string, change: (draft: Draft) => Draft) =>
    set((state) => ({
      byThreadId: withDraft(state.byThreadId, threadId, change(state.byThreadId[threadId] ?? emptyDraft)),
    }))

  return {
    byThreadId: {},
    setText: (threadId, text) => update(threadId, (draft) => ({ ...draft, text })),
    addAttachments: (threadId, attachments) =>
      update(threadId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...attachments] })),
    removeAttachment: (threadId, attachmentId) =>
      update(threadId, (draft) => ({
        ...draft,
        attachments: draft.attachments.filter((attachment) => attachment.id !== attachmentId),
      })),
    setWorktree: (threadId, worktree) => update(threadId, (draft) => ({ ...draft, worktree })),
    take: (threadId) => {
      const draft = get().byThreadId[threadId] ?? emptyDraft
      update(threadId, () => emptyDraft)
      return draft
    },
    restore: (threadId, sent) =>
      update(threadId, (draft) => ({
        text: [sent.text, draft.text].filter((text) => text !== "").join("\n"),
        attachments: [...sent.attachments, ...draft.attachments],
        worktree: draft.worktree ?? sent.worktree,
      })),
    discard: (threadId) => update(threadId, () => emptyDraft),
  }
})
