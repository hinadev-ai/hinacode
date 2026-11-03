import type { Editor } from "@tiptap/core"
import type { DocumentContent } from "../../../shared/artifact.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, type EnvironmentId } from "../../lib/rpc.ts"

const SAVE_DELAY_MS = 500

export type SaveStatus =
  | { readonly type: "saved" }
  | { readonly type: "saving" }
  | { readonly type: "conflict" }
  | { readonly type: "failed"; readonly message: string }

export type DocumentSync = ReturnType<typeof createDocumentSync>

type Draft = { readonly revision: number; readonly markdown: string }

const unsavedDocuments = new Map<string, Draft>()

export function createDocumentSync(options: {
  readonly id: string
  readonly environment: EnvironmentId
  readonly loaded: DocumentContent
  readonly onStatus: (status: SaveStatus) => void
}) {
  const { id, environment, onStatus } = options
  const key = JSON.stringify([environment, id])
  const restored = unsavedDocuments.get(key)
  const initial = restored ?? options.loaded
  let editor: Editor | null = null
  let base = initial.revision
  let edits = 0
  let savedEdits = 0
  let saving = false
  let theirs: DocumentContent | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const markdown = () =>
    editor !== null && !editor.isDestroyed ? editor.getMarkdown() : (unsavedDocuments.get(key)?.markdown ?? "")

  const clean = () => editor !== null && !saving && edits === savedEdits && theirs === null

  const settle = () => {
    savedEdits = edits
    unsavedDocuments.delete(key)
  }

  const load = (content: Draft) => {
    editor?.commands.setContent(content.markdown, { contentType: "markdown", emitUpdate: false })
    base = content.revision
    settle()
  }

  const save = async (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (saving || theirs !== null || editor === null || edits === savedEdits) return
    saving = true
    const edit = edits
    onStatus({ type: "saving" })
    const outcome = await callPromise(
      "artifacts.saveDocument",
      { id, baseRevision: base, markdown: markdown() },
      { environment },
    ).catch((cause: unknown) => ({ type: "failed" as const, message: errorMessage(cause) }))
    saving = false
    switch (outcome.type) {
      case "failed":
        return onStatus(outcome)
      case "conflict":
        theirs = outcome
        return onStatus({ type: "conflict" })
      case "saved":
        base = outcome.revision
        savedEdits = edit
        if (edits !== savedEdits) return save()
        settle()
        return onStatus({ type: "saved" })
    }
  }

  const edited = () => {
    edits += 1
    if (theirs !== null) return
    onStatus({ type: "saving" })
    clearTimeout(timer)
    timer = setTimeout(() => void save(), SAVE_DELAY_MS)
  }

  const published = async (revision?: number) => {
    if (!clean() || (revision !== undefined && revision <= base)) return
    const latest = await callPromise("artifacts.readDocument", { id }, { environment }).catch(() => null)
    if (latest !== null && clean() && latest.revision > base) load(latest)
  }

  return {
    initial: initial.markdown,
    start: (created: Editor) => {
      editor = created
      if (restored === undefined) void published()
      else edited()
    },
    revision: () => base,
    edited,
    published,
    retry: save,
    flush: () => {
      if (edits === savedEdits) return
      unsavedDocuments.set(key, { revision: base, markdown: markdown() })
      void save()
    },
    keepMine: () => {
      if (theirs === null) return Promise.resolve()
      base = theirs.revision
      theirs = null
      return save()
    },
    useTheirs: () => {
      if (theirs === null) return
      load(theirs)
      theirs = null
      onStatus({ type: "saved" })
    },
  }
}
