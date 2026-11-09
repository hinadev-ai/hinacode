import type { WhiteboardContent, WhiteboardElement } from "../../../../shared/artifact.ts"
import type { EnvironmentId } from "../../../lib/rpc.ts"
import { callPromise } from "../../../lib/rpc.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { EMPTY_SNAPSHOT, mergeScene, sceneSnapshot, type Snapshot } from "./scene.ts"
import type { OwnElement } from "./elements.ts"

const SAVE_DELAY_MS = 500
const MERGE_ATTEMPTS = 5

export type SaveStatus =
  | { readonly type: "saved" }
  | { readonly type: "dirty" }
  | { readonly type: "saving" }
  | { readonly type: "conflict" }
  | { readonly type: "failed"; readonly message: string }

export type WhiteboardSync = ReturnType<typeof createWhiteboardSync>

type Draft = {
  readonly elements: OwnElement[]
  readonly snapshot: Snapshot
  readonly revision: number
  readonly saved: Promise<number | null>
}

const unsavedWhiteboards = new Map<string, Draft>()

const draftKey = (environment: EnvironmentId, id: string) => JSON.stringify([environment, id])

export const initialElements = (environment: EnvironmentId, id: string, loaded: WhiteboardContent): OwnElement[] =>
  unsavedWhiteboards.get(draftKey(environment, id))?.elements ??
  mergeScene(EMPTY_SNAPSHOT, loaded.scene.elements).elements

export function createWhiteboardSync(options: {
  readonly id: string
  readonly environment: EnvironmentId
  readonly loaded: WhiteboardContent
  readonly onStatus: (status: SaveStatus) => void
  readonly onElements: (elements: OwnElement[]) => void
}) {
  const { id, environment, onStatus, onElements } = options
  const key = draftKey(environment, id)
  const restored = unsavedWhiteboards.get(key)
  const initial: { readonly elements: OwnElement[]; readonly snapshot: Snapshot } =
    restored ?? mergeScene(EMPTY_SNAPSHOT, options.loaded.scene.elements)
  let snapshot = initial.snapshot
  let elements: OwnElement[] = initial.elements
  let base = restored?.revision ?? options.loaded.revision
  let latest = Math.max(base, options.loaded.revision)
  let edits = restored === undefined ? 0 : 1
  let savedEdits = 0
  let closed = false
  let handedOff: Draft | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = <A>(operation: () => Promise<A>) => {
    const next = queue.then(operation)
    queue = next.catch(() => undefined)
    return next
  }

  const settle = () => {
    savedEdits = edits
    const pending = unsavedWhiteboards.get(key)
    if (pending === restored || pending === handedOff) unsavedWhiteboards.delete(key)
  }

  const apply = (content: WhiteboardContent) => {
    const merged = mergeScene(snapshot, content.scene.elements, elements)
    snapshot = merged.snapshot
    elements = merged.elements
    base = Math.max(base, content.revision)
    latest = Math.max(latest, content.revision)
    onElements(elements)
  }

  const catchUp = (always = false) =>
    enqueue(async () => {
      if (closed || (!always && latest <= base)) return
      const current = await callPromise("artifacts.readWhiteboard", { id }, { environment }).catch(() => null)
      if (current !== null && current.revision > base) apply(current)
    })

  const save = () =>
    enqueue(async (): Promise<number | null> => {
      clearTimeout(timer)
      timer = undefined
      for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt += 1) {
        if (edits === savedEdits) return base
        const edit = edits
        const sending = elements.filter((element) => element.isDeleted !== true)
        onStatus({ type: "saving" })
        const outcome = await callPromise(
          "artifacts.saveWhiteboard",
          { id, baseRevision: base, scene: { elements: sending as ReadonlyArray<WhiteboardElement> } },
          { environment },
        ).catch((cause: unknown) => ({ type: "failed" as const, message: errorMessage(cause) }))
        switch (outcome.type) {
          case "failed":
            onStatus(outcome)
            return null
          case "conflict":
            onStatus({ type: "conflict" })
            apply(outcome)
            continue
          case "saved":
            base = outcome.revision
            latest = Math.max(latest, base)
            snapshot = sceneSnapshot(sending)
            savedEdits = edit
            if (edits === savedEdits) settle()
            onStatus({ type: edits === savedEdits ? "saved" : "dirty" })
            return base
        }
      }
      return null
    })

  if (restored !== undefined) {
    const covered = edits
    void enqueue(async () => {
      const revision = await restored.saved
      if (revision === null) return
      savedEdits = Math.max(savedEdits, covered)
      latest = Math.max(latest, revision)
      if (edits === savedEdits) settle()
      const current = await callPromise("artifacts.readWhiteboard", { id }, { environment }).catch(() => null)
      if (current !== null && current.revision > base) apply(current)
    })
  }

  return {
    open: () => {
      closed = false
    },
    changed: (next: OwnElement[]) => {
      if (closed) return
      elements = next
      edits += 1
      onStatus({ type: "dirty" })
      clearTimeout(timer)
      timer = setTimeout(() => void save(), SAVE_DELAY_MS)
    },
    published: (revision?: number) => {
      if (revision === undefined) return void catchUp(true)
      latest = Math.max(latest, revision)
      void catchUp()
    },
    save,
    close: () => {
      clearTimeout(timer)
      closed = true
      if (edits === savedEdits) return
      handedOff = { elements, snapshot, revision: base, saved: save() }
      unsavedWhiteboards.set(key, handedOff)
    },
  }
}
