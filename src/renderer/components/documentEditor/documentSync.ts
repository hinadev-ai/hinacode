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

type Draft = { readonly revision: number; readonly markdown: string; readonly saved?: Promise<number | null> }

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
  let latest = initial.revision
  let handoff = restored?.saved
  let draft = restored
  let edits = 0
  let savedEdits = 0
  let saving = false
  let theirs: DocumentContent | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const markdown = () => (editor !== null && !editor.isDestroyed ? editor.getMarkdown() : (draft?.markdown ?? ""))

  const clean = () => editor !== null && !editor.isDestroyed && !saving && edits === savedEdits && theirs === null

  const settle = () => {
    savedEdits = edits
    if (unsavedDocuments.get(key) === draft) unsavedDocuments.delete(key)
  }

  const load = (content: Draft) => {
    editor?.commands.setContent(content.markdown, { contentType: "markdown", emitUpdate: false })
    base = content.revision
    settle()
  }

  let running: Promise<number | null> = Promise.resolve(null)

  const save = (): Promise<number | null> => {
    if (saving) return running
    running = run()
    return running
  }

  const run = async (): Promise<number | null> => {
    clearTimeout(timer)
    timer = undefined
    if (theirs !== null || editor === null || edits === savedEdits) return null
    saving = true
    if (handoff !== undefined) {
      base = Math.max(base, (await handoff) ?? base)
      handoff = undefined
    }
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
        onStatus(outcome)
        return null
      case "conflict":
        theirs = outcome
        onStatus({ type: "conflict" })
        return null
      case "saved":
        base = outcome.revision
        savedEdits = edit
        if (edits !== savedEdits) return run()
        settle()
        onStatus({ type: "saved" })
        void catchUp()
        return base
    }
  }

  const edited = () => {
    edits += 1
    if (theirs !== null) return
    onStatus({ type: "saving" })
    clearTimeout(timer)
    timer = setTimeout(() => void save(), SAVE_DELAY_MS)
  }

  const catchUp = async (always = false) => {
    if (!clean() || (!always && latest <= base)) return
    const current = await callPromise("artifacts.readDocument", { id }, { environment }).catch(() => null)
    if (current === null) return
    latest = Math.max(latest, current.revision)
    if (clean() && current.revision > base) load(current)
  }

  const published = (revision?: number) => {
    if (revision === undefined) return catchUp(true)
    latest = Math.max(latest, revision)
    return catchUp()
  }

  return {
    initial: initial.markdown,
    start: (created: Editor) => {
      editor = created
      if (restored === undefined) void published()
      else edited()
    },
    saveEdits: async () => {
      await save()
      return edits === savedEdits
    },
    savedRevision: async () => {
      await save()
      return base
    },
    edited,
    published,
    retry: async () => {
      await save()
    },
    flush: () => {
      if (edits === savedEdits) return
      draft = { revision: base, markdown: markdown() }
      draft = { ...draft, saved: save() }
      unsavedDocuments.set(key, draft)
    },
    keepMine: async () => {
      if (theirs === null) return
      base = theirs.revision
      theirs = null
      await save()
    },
    useTheirs: () => {
      if (theirs === null) return
      load(theirs)
      theirs = null
      onStatus({ type: "saved" })
      void catchUp()
    },
  }
}
