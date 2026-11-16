import { constants } from "node:fs"
import { existsSync } from "node:fs"
import { copyFile, mkdir, open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, parse } from "node:path"
import { Effect, Schema } from "effect"
import { RpcMethods } from "../shared/contract.ts"
import type { HandlerError } from "./rpc.ts"
import { Environments } from "./services/Environments.ts"
import { Files } from "./services/Files.ts"

const decodeChunk = Schema.decodeUnknownEffect(RpcMethods["fs.readChunk"].response)

const copyFailed = (cause: unknown): HandlerError => ({
  _tag: "CopyFailed",
  message: cause instanceof Error ? cause.message : String(cause),
})

const pullFromCloud = (cloud: string, root: string, path: string, target: string) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(target, "wx"), catch: copyFailed }),
    (handle) =>
      Effect.gen(function* () {
        const environments = yield* Environments
        let offset = 0
        while (true) {
          const envelope = yield* environments.forward(cloud, {
            method: "fs.readChunk",
            payload: { root, path, offset },
          })
          if ("error" in envelope)
            return yield* Effect.fail({ _tag: envelope.error.tag, message: envelope.error.message })
          const chunk = yield* decodeChunk(envelope.result)
          const bytes = Buffer.from(chunk.data, "base64")
          yield* Effect.tryPromise({ try: () => handle.write(bytes), catch: copyFailed })
          offset += bytes.length
          if (bytes.length === 0 || offset >= chunk.size) return
        }
      }),
    (handle) => Effect.promise(() => handle.close()),
  ).pipe(Effect.onError(() => Effect.promise(() => rm(target, { force: true }))))

const copyProjectFile = (root: string, path: string, target: string) =>
  Effect.gen(function* () {
    const cloud = (yield* Environments).owner("root", root)
    if (cloud !== undefined) return yield* pullFromCloud(cloud, root, path, target)
    const source = yield* Files.use((files) => files.resolve(root, path))
    yield* Effect.tryPromise({ try: () => copyFile(source, target, constants.COPYFILE_EXCL), catch: copyFailed })
  })

export const localFileOf = (root: string, path: string) =>
  Effect.gen(function* () {
    const cloud = (yield* Environments).owner("root", root)
    if (cloud === undefined) return yield* Files.use((files) => files.resolve(root, path))
    const folder = join(tmpdir(), "hinacode-drag")
    yield* Effect.tryPromise({
      try: async () => {
        await rm(folder, { recursive: true, force: true })
        await mkdir(folder, { recursive: true })
      },
      catch: copyFailed,
    })
    const target = join(folder, basename(path))
    yield* pullFromCloud(cloud, root, path, target)
    return target
  })

const freePath = (folder: string, name: string) => {
  const { name: stem, ext } = parse(name)
  for (let copy = 0; ; copy++) {
    const candidate = join(folder, copy === 0 ? name : `${stem} (${copy})${ext}`)
    if (!existsSync(candidate)) return candidate
  }
}

export const downloadProjectFile = (root: string, path: string, folder: string) =>
  Effect.gen(function* () {
    const target = freePath(folder, basename(path))
    yield* copyProjectFile(root, path, target)
    return target
  })
