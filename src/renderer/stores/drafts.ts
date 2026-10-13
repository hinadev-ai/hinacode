import { create } from "zustand"
import type { Attachment, WorktreeSource } from "../../shared/domain.ts"
import { parsePullRequestSelector } from "../../shared/github.ts"

/** A comment on lines of a file, sent as context with the next message. */
export interface LineComment {
  readonly id: string
  /** Relative to the thread's working directory. */
  readonly path: string
  /** 1-based and inclusive. */
  readonly startLine: number
  readonly endLine: number
  /** The commented lines as the user saw them, so the agent finds them even after the file moved on. */
  readonly code: string
  readonly body: string
}

export interface Draft {
  readonly text: string
  readonly attachments: ReadonlyArray<Attachment>
  /**
   * Before the first message only: run the thread in a new worktree. `ref` is what the user typed: a branch to fork
   * from, or a pull request number or URL to check out.
   */
  readonly worktree: { readonly ref: string } | null
  readonly comments: ReadonlyArray<LineComment>
}

export const toWorktreeSource = (ref: string): WorktreeSource => {
  const selector = parsePullRequestSelector(ref)
  return selector === undefined ? { _tag: "branch", baseRef: ref.trim() } : { _tag: "pullRequest", selector }
}

export const emptyDraft: Draft = { text: "", attachments: [], worktree: null, comments: [] }

interface DraftsState {
  readonly byThreadId: Readonly<Record<string, Draft>>
  readonly setText: (threadId: string, text: string) => void
  /** Adds `@path ` at the end of the text, as if typed there. */
  readonly appendMention: (threadId: string, path: string) => void
  readonly addAttachments: (threadId: string, attachments: ReadonlyArray<Attachment>) => void
  readonly removeAttachment: (threadId: string, attachmentId: string) => void
  readonly setWorktree: (threadId: string, worktree: Draft["worktree"]) => void
  readonly addComment: (threadId: string, comment: LineComment) => void
  readonly updateComment: (threadId: string, commentId: string, body: string) => void
  readonly removeComment: (threadId: string, commentId: string) => void
  /** Empties the draft for sending and returns what it held, so anything typed while the send is pending is kept. */
  readonly take: (threadId: string) => Draft
  /** Puts a draft whose send failed back in front of whatever was typed since. */
  readonly restore: (threadId: string, draft: Draft) => void
  readonly discard: (threadId: string) => void
}

const withDraft = (byThreadId: Readonly<Record<string, Draft>>, threadId: string, draft: Draft) => {
  const { [threadId]: _previous, ...rest } = byThreadId
  return draft.text === "" && draft.attachments.length === 0 && draft.worktree === null && draft.comments.length === 0
    ? rest
    : { ...rest, [threadId]: draft }
}

/**
 * Unsent composer text, staged attachments and line comments per thread. Lives outside the composer so it survives
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
    appendMention: (threadId, path) =>
      update(threadId, (draft) => ({
        ...draft,
        text: `${draft.text}${draft.text === "" || /\s$/.test(draft.text) ? "" : " "}@${path} `,
      })),
    addAttachments: (threadId, attachments) =>
      update(threadId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...attachments] })),
    removeAttachment: (threadId, attachmentId) =>
      update(threadId, (draft) => ({
        ...draft,
        attachments: draft.attachments.filter((attachment) => attachment.id !== attachmentId),
      })),
    setWorktree: (threadId, worktree) => update(threadId, (draft) => ({ ...draft, worktree })),
    addComment: (threadId, comment) =>
      update(threadId, (draft) => ({ ...draft, comments: [...draft.comments, comment] })),
    updateComment: (threadId, commentId, body) =>
      update(threadId, (draft) => ({
        ...draft,
        comments: draft.comments.map((comment) => (comment.id === commentId ? { ...comment, body } : comment)),
      })),
    removeComment: (threadId, commentId) =>
      update(threadId, (draft) => ({
        ...draft,
        comments: draft.comments.filter((comment) => comment.id !== commentId),
      })),
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
        comments: [...sent.comments, ...draft.comments],
      })),
    discard: (threadId) => update(threadId, () => emptyDraft),
  }
})
