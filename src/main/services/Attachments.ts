import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, sep } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { Attachment } from "../../shared/domain.ts"
import { isInside } from "../security.ts"

const MAX_BYTES = 20 * 1024 * 1024

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
}

export type AttachmentSource = { readonly path: string } | { readonly dataUrl: string; readonly name: string }

class AttachmentTooLargeError extends Schema.TaggedError<AttachmentTooLargeError>()("AttachmentTooLargeError", {
  name: Schema.String,
  bytes: Schema.Number,
}) {
  override get message(): string {
    return `${this.name} is ${(this.bytes / 1024 / 1024).toFixed(1)} MB; attachments are limited to ${MAX_BYTES / 1024 / 1024} MB`
  }
}

export class AttachmentError extends Schema.TaggedError<AttachmentError>()("AttachmentError", {
  message: Schema.String,
}) {}

const safeName = (name: string) =>
  basename(name)
    .replace(/[^\w.-]+/g, "_")
    .slice(-100) || "file"

export const extensionForMime = (mime: string) =>
  Object.entries(MIME_BY_EXTENSION).find(([, known]) => known === mime)?.[0] ?? ""

const mimeOf = (name: string) => MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream"

export const decodeDataUrl = (dataUrl: string) => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (match === null) return undefined
  return { mime: match[1]!, data: Buffer.from(match[2]!, "base64") }
}

const failure = (message: string) => (cause: unknown) =>
  new AttachmentError({ message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}` })

export class Attachments extends Context.Service<
  Attachments,
  {
    readonly stage: (
      threadId: string,
      source: AttachmentSource,
    ) => Effect.Effect<Attachment, AttachmentError | AttachmentTooLargeError>
    readonly read: (path: string) => Effect.Effect<{ readonly dataUrl: string }, AttachmentError>
    readonly copyInto: (
      threadId: string,
      attachment: Attachment,
    ) => Effect.Effect<Attachment, AttachmentError | AttachmentTooLargeError>
    readonly prune: Effect.Effect<void, AttachmentError>
  }
>()("hinacode/Attachments") {}

const stage = (root: string) => (threadId: string, source: AttachmentSource) =>
  Effect.gen(function* () {
    const id = randomUUID()
    const dir = join(root, safeName(threadId))
    yield* Effect.tryPromise({
      try: () => mkdir(dir, { recursive: true }),
      catch: failure("Cannot create attachments dir"),
    })

    if ("path" in source) {
      const name = basename(source.path)
      const { size } = yield* Effect.tryPromise({ try: () => stat(source.path), catch: failure(`Cannot read ${name}`) })
      if (size > MAX_BYTES) return yield* new AttachmentTooLargeError({ name, bytes: size })
      const path = join(dir, `${id}-${safeName(name)}`)
      yield* Effect.tryPromise({ try: () => copyFile(source.path, path), catch: failure(`Cannot copy ${name}`) })
      return attachment(id, name, path, mimeOf(name), size)
    }

    const decoded = decodeDataUrl(source.dataUrl)
    if (decoded === undefined) return yield* new AttachmentError({ message: `${source.name} is not a base64 data URL` })
    if (decoded.data.byteLength > MAX_BYTES) {
      return yield* new AttachmentTooLargeError({ name: source.name, bytes: decoded.data.byteLength })
    }
    const path = join(dir, `${id}-${safeName(source.name)}`)
    yield* Effect.tryPromise({
      try: () => writeFile(path, decoded.data),
      catch: failure(`Cannot write ${source.name}`),
    })
    return attachment(id, source.name, path, decoded.mime, decoded.data.byteLength)
  })

export const inlineSource = (path: string) =>
  Effect.gen(function* () {
    const name = basename(path)
    const { size } = yield* Effect.tryPromise({ try: () => stat(path), catch: failure(`Cannot read ${name}`) })
    if (size > MAX_BYTES) return yield* new AttachmentTooLargeError({ name, bytes: size })
    const data = yield* Effect.tryPromise({ try: () => readFile(path), catch: failure(`Cannot read ${name}`) })
    return { dataUrl: `data:${mimeOf(name)};base64,${data.toString("base64")}`, name }
  })

const read = (root: string) => (path: string) =>
  isInside(root, path)
    ? Effect.tryPromise({ try: () => readFile(path), catch: failure(`Cannot read ${basename(path)}`) }).pipe(
        Effect.map((data) => ({ dataUrl: `data:${mimeOf(path)};base64,${data.toString("base64")}` })),
      )
    : Effect.fail(new AttachmentError({ message: `${path} is not a staged attachment` }))

const attachment = (id: string, name: string, path: string, mime: string, bytes: number): Attachment => ({
  id,
  name,
  path,
  mime,
  kind: mime.startsWith("image/") ? "image" : "file",
  bytes,
})

const errorCode = (cause: unknown) => (cause as NodeJS.ErrnoException).code

const namesIn = (folder: string, kind: "files" | "folders") =>
  Effect.tryPromise({ try: () => readdir(folder, { withFileTypes: true }), catch: (cause) => cause }).pipe(
    Effect.catchIf(
      (cause) => errorCode(cause) === "ENOENT",
      () => Effect.succeed([]),
    ),
    Effect.mapError(failure(`Cannot list ${folder}`)),
    Effect.map((entries) =>
      entries.filter((entry) => (kind === "files" ? entry.isFile() : entry.isDirectory())).map((entry) => entry.name),
    ),
  )

const asJsonText = (text: string) => JSON.stringify(text).slice(1, -1)

const mentions = (texts: ReadonlyArray<string>, path: string) =>
  texts.some((text) => text.includes(path) || text.includes(asJsonText(path)))

const ARTIFACT_TEXT_EXTENSIONS = new Set([".json", ".md", ".html", ".excalidraw", ".svg", ".txt", ".js", ".css"])

const artifactTexts = (artifactsRoot: string | undefined) =>
  artifactsRoot === undefined
    ? Effect.succeed([])
    : Effect.tryPromise({
        try: async () => {
          const entries = await readdir(artifactsRoot, { recursive: true, withFileTypes: true }).catch(
            (cause: unknown) => {
              if (errorCode(cause) === "ENOENT") return []
              throw cause
            },
          )
          const files = entries.filter((entry) => entry.isFile() && ARTIFACT_TEXT_EXTENSIONS.has(extname(entry.name)))
          return Promise.all(files.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")))
        },
        catch: failure("Cannot read artifacts"),
      })

const removeIfEmpty = (folder: string) =>
  Effect.tryPromise({ try: () => rmdir(folder), catch: (cause) => cause }).pipe(
    Effect.catchIf(
      (cause) => errorCode(cause) === "ENOTEMPTY" || errorCode(cause) === "ENOENT",
      () => Effect.void,
    ),
    Effect.mapError(failure(`Cannot remove ${folder}`)),
  )

export const layer = (root: string, { artifactsRoot }: { readonly artifactsRoot?: string } = {}) =>
  Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const textsMentioning = (needle: string) =>
        sql<{ readonly text: string }>`
          SELECT parts AS text FROM message WHERE instr(parts, ${needle}) > 0
          UNION ALL SELECT part FROM message_part WHERE instr(part, ${needle}) > 0
          UNION ALL SELECT queue FROM thread WHERE instr(queue, ${needle}) > 0
          UNION ALL SELECT scheduled FROM thread WHERE instr(scheduled, ${needle}) > 0
        `.pipe(
          Effect.map((rows) => rows.map((row) => row.text)),
          Effect.mapError(failure("Cannot look up attachment references")),
        )

      const release = (folder: string, artifacts: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const names = yield* namesIn(folder, "files")
          if (names.length === 0) return yield* removeIfEmpty(folder)
          const texts = [...(yield* textsMentioning(asJsonText(folder + sep))), ...artifacts]
          const unreferenced = names.map((name) => join(folder, name)).filter((path) => !mentions(texts, path))
          yield* Effect.forEach(
            unreferenced,
            (path) =>
              Effect.tryPromise({ try: () => rm(path, { force: true }), catch: failure(`Cannot delete ${path}`) }),
            { discard: true },
          )
          yield* removeIfEmpty(folder)
        })

      const prune = Effect.gen(function* () {
        const folders = yield* namesIn(root, "folders")
        const threads = yield* sql<{ readonly id: string }>`SELECT id FROM thread`.pipe(
          Effect.mapError(failure("Cannot list threads")),
        )
        const live = new Set(threads.map((thread) => safeName(thread.id)))
        const orphans = folders.filter((folder) => !live.has(folder))
        if (orphans.length === 0) return
        const artifacts = yield* artifactTexts(artifactsRoot)
        yield* Effect.forEach(orphans, (folder) => release(join(root, folder), artifacts), { discard: true })
      })

      yield* prune.pipe(
        Effect.catchCause((cause) => Effect.logWarning("attachment sweep failed", cause)),
        Effect.forkScoped,
      )

      const copyInto = (threadId: string, original: Attachment) =>
        dirname(original.path) === join(root, safeName(threadId))
          ? Effect.succeed(original)
          : Effect.map(stage(root)(threadId, { path: original.path }), ({ id, path, bytes }) => ({
              ...original,
              id,
              path,
              bytes,
            }))

      return Attachments.of({ stage: stage(root), read: read(root), copyInto, prune })
    }),
  )
