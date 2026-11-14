import type { DocumentContent, DocumentSaveResult } from "../artifact.ts"

const SAVE_DELAY_MS = 500

export type SaveStatus =
  | { readonly type: "saved" }
  | { readonly type: "saving" }
  | { readonly type: "conflict" }
  | { readonly type: "failed"; readonly message: string }

export type DocumentSync = ReturnType<typeof createDocumentSync>

type Draft = { readonly revision: number; readonly markdown: string; readonly saved?: Promise<number | null> }

const unsavedDocuments = new Map<string, Draft>()

export type DocumentRpc = {
  readonly save: (input: { readonly baseRevision: number; readonly markdown: string }) => Promise<DocumentSaveResult>
  readonly read: () => Promise<DocumentContent>
}

export type DocumentEditorBinding = {
  readonly markdown: () => string
  readonly load: (markdown: string) => void
  readonly live: () => boolean
}

export function createDocumentSync(options: {
  readonly key: string
  readonly loaded: DocumentContent
  readonly rpc: DocumentRpc
  readonly onStatus: (status: SaveStatus) => void
  readonly describe: (cause: unknown) => string
}) {
  const { key, rpc, onStatus, describe } = options
  const restored = unsavedDocuments.get(key)
  const initial = restored ?? options.loaded
  let editor: DocumentEditorBinding | null = null
  let base = initial.revision
  let latest = initial.revision
  let handoff = restored?.saved
  let draft = restored
  let edits = 0
  let savedEdits = 0
  let saving = false
  let theirs: DocumentContent | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const markdown = () => (editor !== null && editor.live() ? editor.markdown() : (draft?.markdown ?? ""))

  const clean = () => editor !== null && editor.live() && !saving && edits === savedEdits && theirs === null

  const settle = () => {
    savedEdits = edits
    if (unsavedDocuments.get(key) === draft) unsavedDocuments.delete(key)
  }

  const load = (content: Draft) => {
    editor?.load(content.markdown)
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
    const outcome = await rpc
      .save({ baseRevision: base, markdown: markdown() })
      .catch((cause: unknown) => ({ type: "failed" as const, message: describe(cause) }))
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
    const current = await rpc.read().catch(() => null)
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
    start: (created: DocumentEditorBinding) => {
      editor = created
      if (restored === undefined) void published()
      else edited()
    },
    saveEdits: async (): Promise<number | null> => {
      await save()
      return edits === savedEdits ? base : null
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
