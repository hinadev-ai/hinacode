import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import {
  ArtifactConflictError,
  ArtifactError,
  type ArtifactStore,
  DOCUMENT_ENTRY,
  isArtifactId,
  openArtifactStore,
  parseScene,
  type PublishInput,
  WHITEBOARD_ENTRY,
} from "@hinacode/artifacts"
import { Context, Effect, Layer, Schema } from "effect"
import type {
  Artifact,
  DocumentContent,
  DocumentSaveResult,
  WhiteboardContent,
  WhiteboardSaveResult,
  WhiteboardScene,
} from "../../shared/artifact.ts"
import { decodeDataUrl } from "./Attachments.ts"
import { NotFoundError } from "./errors.ts"
import { Events } from "./Events.ts"

const MANIFEST = "artifact.json"
const FEEDBACK = "feedback.json"
const ANNOUNCE_DEBOUNCE_MS = 50

export class DocumentImageError extends Schema.TaggedError<DocumentImageError>()("DocumentImageError", {
  message: Schema.String,
}) {}

type ArtifactFileBytes = { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }

export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly store: ArtifactStore
    readonly list: Effect.Effect<ReadonlyArray<Artifact>>
    readonly file: (id: string, path: string) => Effect.Effect<ArtifactFileBytes | null>
    readonly preview: (id: string, path: string) => Effect.Effect<{ readonly dataUrl: string }, NotFoundError>
    readonly remove: (id: string) => Effect.Effect<void, NotFoundError>
    readonly readDocument: (id: string) => Effect.Effect<DocumentContent, NotFoundError>
    readonly saveDocument: (input: {
      readonly id: string
      readonly baseRevision: number
      readonly markdown: string
    }) => Effect.Effect<DocumentSaveResult, NotFoundError>
    readonly createDocument: (input: { readonly threadId: string; readonly title: string }) => Effect.Effect<Artifact>
    readonly createWhiteboard: (input: { readonly threadId: string; readonly title: string }) => Effect.Effect<Artifact>
    readonly readWhiteboard: (id: string) => Effect.Effect<WhiteboardContent, NotFoundError>
    readonly saveWhiteboard: (input: {
      readonly id: string
      readonly baseRevision: number
      readonly scene: WhiteboardScene
    }) => Effect.Effect<WhiteboardSaveResult, NotFoundError>
    readonly rename: (id: string, title: string) => Effect.Effect<Artifact, NotFoundError>
    readonly addDocumentImage: (input: {
      readonly id: string
      readonly dataUrl: string
    }) => Effect.Effect<{ readonly path: string }, NotFoundError | DocumentImageError>
  }
>()("hinacode/Artifacts") {}

const ownerOf = (name: string | null, expected: string) => {
  const [id = "", file, ...rest] = name?.split(/[\\/]/) ?? []
  return file === expected && rest.length === 0 && isArtifactId(id) ? id : undefined
}

const make = (root: string) =>
  Effect.gen(function* () {
    const events = yield* Events
    const store = openArtifactStore(root)
    const announced = new Map<string, string>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const forget = (id: string) => {
      if (announced.delete(id)) Effect.runFork(events.publish({ type: "artifact.removed", id }))
    }

    const announce = async (id: string) => {
      const artifact = await store.get(id)
      if (artifact === null) return forget(id)
      if (announced.get(id) === artifact.updatedAt) return
      announced.set(id, artifact.updatedAt)
      Effect.runFork(events.publish({ type: "artifact.updated", artifact }))
    }

    const schedule = (key: string, action: () => void) => {
      clearTimeout(timers.get(key))
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          action()
        }, ANNOUNCE_DEBOUNCE_MS),
      )
    }

    const watchRoot = Effect.promise(async () => {
      await mkdir(root, { recursive: true })
      for (const artifact of await store.list()) announced.set(artifact.id, artifact.updatedAt)
      const watcher = watch(root, { recursive: true }, (_event, name) => {
        const manifest = ownerOf(name, MANIFEST)
        if (manifest !== undefined) schedule(manifest, () => void announce(manifest))
        const feedback = ownerOf(name, FEEDBACK)
        if (feedback !== undefined) {
          schedule(`${feedback}/${FEEDBACK}`, () =>
            Effect.runFork(events.publish({ type: "artifact.feedback", id: feedback })),
          )
        }
      })
      watcher.on("error", (cause) => Effect.runFork(Effect.logWarning("stopped watching artifacts", root, cause)))
      return watcher
    })

    const watcher = yield* watchRoot.pipe(
      Effect.catchDefect((cause) => Effect.as(Effect.logWarning("cannot watch artifacts", root, cause), null)),
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        watcher?.close()
        for (const timer of timers.values()) clearTimeout(timer)
      }),
    )

    const file = (id: string, path: string) =>
      Effect.promise(async () => {
        if (path !== "") return store.file(id, path)
        const artifact = await store.get(id)
        return artifact === null ? null : store.file(id, artifact.entry)
      })

    const preview = (id: string, path: string) =>
      Effect.flatMap(file(id, path), (found) =>
        found === null
          ? Effect.fail(new NotFoundError({ entity: "artifact", id: `${id}/${path}` }))
          : Effect.succeed({
              dataUrl: `data:${found.type.replaceAll(" ", "")};base64,${Buffer.from(found.bytes).toString("base64")}`,
            }),
      )

    const remove = (id: string) =>
      Effect.flatMap(
        Effect.promise(() => store.remove(id)),
        (removed) =>
          removed ? Effect.sync(() => forget(id)) : Effect.fail(new NotFoundError({ entity: "artifact", id })),
      )

    const readDocument = (id: string) =>
      Effect.flatMap(
        Effect.promise(() => store.file(id, DOCUMENT_ENTRY)),
        (found) =>
          found === null || found.kind !== "document"
            ? Effect.fail(new NotFoundError({ entity: "document", id }))
            : Effect.succeed({
                version: found.version,
                revision: found.revision,
                markdown: new TextDecoder().decode(found.bytes),
              }),
      )

    const saveDocument = ({ id, baseRevision, markdown }: { id: string; baseRevision: number; markdown: string }) =>
      Effect.gen(function* () {
        const current = yield* Effect.promise(() => store.get(id))
        if (current === null || current.kind !== "document") return yield* new NotFoundError({ entity: "document", id })
        const saved = yield* Effect.tryPromise({
          try: () => store.publish({ kind: "document", id, markdown, baseRevision, author: "developer" }),
          catch: (cause) => cause,
        }).pipe(
          Effect.map(({ version, revision }): DocumentSaveResult => ({ type: "saved", version, revision })),
          Effect.catch((cause) =>
            cause instanceof ArtifactConflictError
              ? Effect.map(readDocument(id), (latest): DocumentSaveResult => ({ type: "conflict", ...latest }))
              : Effect.die(cause),
          ),
        )
        return saved
      })

    const readWhiteboard = (id: string) =>
      Effect.flatMap(
        Effect.promise(() => store.file(id, WHITEBOARD_ENTRY)),
        (found) => {
          const scene = found?.kind === "whiteboard" ? parseScene(new TextDecoder().decode(found.bytes)) : null
          return found === null || scene === null
            ? Effect.fail(new NotFoundError({ entity: "whiteboard", id }))
            : Effect.succeed({ version: found.version, revision: found.revision, scene })
        },
      )

    const saveWhiteboard = ({
      id,
      baseRevision,
      scene,
    }: {
      id: string
      baseRevision: number
      scene: WhiteboardScene
    }) =>
      Effect.gen(function* () {
        const current = yield* Effect.promise(() => store.get(id))
        if (current === null || current.kind !== "whiteboard") {
          return yield* new NotFoundError({ entity: "whiteboard", id })
        }
        return yield* Effect.tryPromise({
          try: () =>
            store.publish({
              kind: "whiteboard",
              id,
              scene: { ...scene, elements: [...scene.elements] },
              baseRevision,
              author: "developer",
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.map(({ version, revision }): WhiteboardSaveResult => ({ type: "saved", version, revision })),
          Effect.catch((cause) =>
            cause instanceof ArtifactConflictError
              ? Effect.map(readWhiteboard(id), (latest): WhiteboardSaveResult => ({ type: "conflict", ...latest }))
              : Effect.die(cause),
          ),
        )
      })

    const create = (input: PublishInput) =>
      Effect.tap(
        Effect.promise(() => store.publish(input)),
        (created) => Effect.promise(() => announce(created.id)),
      )

    const createDocument = ({ threadId, title }: { threadId: string; title: string }) =>
      create({ kind: "document", title, markdown: "", threadId, author: "developer" })

    const createWhiteboard = ({ threadId, title }: { threadId: string; title: string }) =>
      create({ kind: "whiteboard", title, scene: { elements: [] }, threadId, author: "developer" })

    const rename = (id: string, title: string) =>
      Effect.flatMap(
        Effect.promise(() => store.get(id)),
        (found) =>
          found === null
            ? Effect.fail(new NotFoundError({ entity: "artifact", id }))
            : Effect.tap(
                Effect.promise(() => store.rename(id, title)),
                () => Effect.promise(() => announce(id)),
              ),
      )

    const addDocumentImage = ({ id, dataUrl }: { id: string; dataUrl: string }) =>
      Effect.gen(function* () {
        const decoded = decodeDataUrl(dataUrl)
        if (decoded === undefined) {
          return yield* new DocumentImageError({ message: "The pasted image is not a base64 data URL." })
        }
        const current = yield* Effect.promise(() => store.get(id))
        if (current === null) return yield* new NotFoundError({ entity: "document", id })
        const path = yield* Effect.tryPromise({
          try: () => store.addDocumentImage(id, { bytes: decoded.data, type: decoded.mime }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            cause instanceof ArtifactError
              ? Effect.fail(new DocumentImageError({ message: cause.message }))
              : Effect.die(cause),
          ),
        )
        return { path }
      })

    return Artifacts.of({
      store,
      list: Effect.promise(() => store.list()),
      file,
      preview,
      remove,
      readDocument,
      saveDocument,
      createDocument,
      createWhiteboard,
      readWhiteboard,
      saveWhiteboard,
      rename,
      addDocumentImage,
    })
  })

export const layer = (root: string) => Layer.effect(Artifacts, make(root))
