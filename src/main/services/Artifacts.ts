import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import { type ArtifactStore, isArtifactId, openArtifactStore } from "@hinacode/artifacts"
import { Context, Effect, Layer } from "effect"
import type { Artifact } from "../../shared/artifact.ts"
import { NotFoundError } from "./errors.ts"
import { Events } from "./Events.ts"

const MANIFEST = "artifact.json"
const ANNOUNCE_DEBOUNCE_MS = 50

type ArtifactFileBytes = { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string }

export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly store: ArtifactStore
    readonly list: Effect.Effect<ReadonlyArray<Artifact>>
    readonly file: (id: string, path: string) => Effect.Effect<ArtifactFileBytes | null>
    readonly preview: (id: string, path: string) => Effect.Effect<{ readonly dataUrl: string }, NotFoundError>
  }
>()("hinacode/Artifacts") {}

const manifestOwner = (name: string | null) => {
  const [id = "", file, ...rest] = name?.split(/[\\/]/) ?? []
  return file === MANIFEST && rest.length === 0 && isArtifactId(id) ? id : undefined
}

const make = (root: string) =>
  Effect.gen(function* () {
    const events = yield* Events
    const store = openArtifactStore(root)
    const announced = new Map<string, string>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const announce = async (id: string) => {
      const artifact = await store.get(id)
      if (artifact === null || announced.get(id) === artifact.updatedAt) return
      announced.set(id, artifact.updatedAt)
      Effect.runFork(events.publish({ type: "artifact.updated", artifact }))
    }

    const schedule = (id: string) => {
      clearTimeout(timers.get(id))
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id)
          void announce(id)
        }, ANNOUNCE_DEBOUNCE_MS),
      )
    }

    const watchRoot = Effect.promise(async () => {
      await mkdir(root, { recursive: true })
      for (const artifact of await store.list()) announced.set(artifact.id, artifact.updatedAt)
      const watcher = watch(root, { recursive: true }, (_event, name) => {
        const id = manifestOwner(name)
        if (id !== undefined) schedule(id)
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

    return Artifacts.of({ store, list: Effect.promise(() => store.list()), file, preview })
  })

export const layer = (root: string) => Layer.effect(Artifacts, make(root))
