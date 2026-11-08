import { CaptureUpdateAction, hashElementsVersion } from "@excalidraw/excalidraw"
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types"
import type { WhiteboardContent, WhiteboardScene } from "../../../shared/artifact.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, type EnvironmentId } from "../../lib/rpc.ts"
import { mergeScene } from "./excalidrawScene.ts"
import { EMPTY_SNAPSHOT, savedSnapshot, type Snapshot } from "./whiteboardScene.ts"

const SAVE_DELAY_MS = 500
const MERGE_ATTEMPTS = 5

export type SaveStatus =
  | { readonly type: "saved" }
  | { readonly type: "dirty" }
  | { readonly type: "saving" }
  | { readonly type: "conflict" }
  | { readonly type: "failed"; readonly message: string }

export type WhiteboardSync = ReturnType<typeof createWhiteboardSync>

type Board = { readonly elements: ReadonlyArray<OrderedExcalidrawElement>; readonly files: BinaryFiles }

type Canvas = Board & { readonly appState: AppState }

type Draft = Board & {
  readonly revision: number
  readonly snapshot: Snapshot
  readonly saved: Promise<number | null>
}

const unsavedWhiteboards = new Map<string, Draft>()

const filesOf = (scene: WhiteboardScene) => (scene.files ?? {}) as BinaryFiles

export function createWhiteboardSync(options: {
  readonly id: string
  readonly environment: EnvironmentId
  readonly loaded: WhiteboardContent
  readonly onStatus: (status: SaveStatus) => void
}) {
  const { id, environment, onStatus } = options
  const key = JSON.stringify([environment, id])
  const restored = unsavedWhiteboards.get(key)
  const loaded = restored === undefined ? mergeScene(EMPTY_SNAPSHOT, options.loaded.scene.elements) : null
  const initial: Board = restored ?? { elements: loaded?.elements ?? [], files: filesOf(options.loaded.scene) }
  let snapshot = restored?.snapshot ?? loaded?.snapshot ?? EMPTY_SNAPSHOT
  let base = restored?.revision ?? options.loaded.revision
  let latest = Math.max(base, options.loaded.revision)
  let api: ExcalidrawImperativeAPI | null = null
  let closed: Canvas | null = null
  let applying = false
  let seen = hashElementsVersion(initial.elements)
  let edits = restored === undefined ? 0 : 1
  let savedEdits = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = <A>(operation: () => Promise<A>) => {
    const next = queue.then(operation)
    queue = next.catch(() => undefined)
    return next
  }

  if (restored !== undefined) {
    void enqueue(async () => {
      if ((await restored.saved) !== null) savedEdits = edits
    })
  }

  const canvas = (): Canvas | null =>
    closed ??
    (api === null
      ? null
      : { elements: api.getSceneElementsIncludingDeleted(), files: api.getFiles(), appState: api.getAppState() })

  const show = (elements: ReadonlyArray<OrderedExcalidrawElement>, files: BinaryFiles) => {
    if (closed !== null) {
      closed = { ...closed, elements, files: { ...closed.files, ...files } }
      return
    }
    if (api === null) return
    applying = true
    try {
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
      api.addFiles(Object.values(files) as BinaryFileData[])
    } finally {
      applying = false
    }
    seen = hashElementsVersion(api.getSceneElementsIncludingDeleted())
  }

  const apply = (content: WhiteboardContent) => {
    const current = canvas()
    if (current === null) return
    const merged = mergeScene(snapshot, content.scene.elements, current)
    snapshot = merged.snapshot
    base = content.revision
    latest = Math.max(latest, content.revision)
    show(merged.elements, filesOf(content.scene))
  }

  const settle = () => {
    savedEdits = edits
    unsavedWhiteboards.delete(key)
  }

  const save = () =>
    enqueue(async (): Promise<number | null> => {
      clearTimeout(timer)
      timer = undefined
      for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt += 1) {
        const current = canvas()
        if (current === null || edits === savedEdits) return base
        const edit = edits
        const elements = current.elements.filter((element) => !element.isDeleted)
        onStatus({ type: "saving" })
        const outcome = await callPromise(
          "artifacts.saveWhiteboard",
          { id, baseRevision: base, scene: { elements, files: current.files } },
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
            snapshot = savedSnapshot(elements)
            savedEdits = edit
            if (edits === savedEdits) settle()
            onStatus({ type: edits === savedEdits ? "saved" : "dirty" })
            return base
        }
      }
      return null
    })

  const catchUp = (always = false) =>
    enqueue(async () => {
      if (canvas() === null || (!always && latest <= base)) return
      const current = await callPromise("artifacts.readWhiteboard", { id }, { environment }).catch(() => null)
      if (current !== null && current.revision > base) apply(current)
    })

  return {
    initial,
    attach: (created: ExcalidrawImperativeAPI) => {
      api = created
      if (edits !== savedEdits) void save()
      void catchUp(true)
    },
    changed: (elements: ReadonlyArray<OrderedExcalidrawElement>) => {
      const version = hashElementsVersion(elements)
      if (applying || version === seen) return
      seen = version
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
      const current = canvas()
      if (current === null || edits === savedEdits) return
      closed = current
      api = null
      unsavedWhiteboards.set(key, { ...current, revision: base, snapshot, saved: save() })
    },
  }
}
