import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { app } from "electron"
import { Context, Effect, Layer, Schema } from "effect"
import type { Attachment } from "../../shared/domain.ts"
import { isInside } from "../security.ts"

const MAX_BYTES = 20 * 1024 * 1024

/** Images limited to the formats both Claude and Codex accept; anything else is attached as a file. */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
}

export type AttachmentSource = { readonly path: string } | { readonly dataUrl: string; readonly name: string }

export class AttachmentTooLargeError extends Schema.TaggedError<AttachmentTooLargeError>()("AttachmentTooLargeError", {
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

export const attachmentsRoot = () => join(app.getPath("userData"), "attachments")

const safeName = (name: string) =>
  basename(name)
    .replace(/[^\w.-]+/g, "_")
    .slice(-100) || "file"

const mimeOf = (name: string) => MIME_BY_EXTENSION[extname(name).toLowerCase()] ?? "application/octet-stream"

const decodeDataUrl = (dataUrl: string) => {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (match === null) return undefined
  return { mime: match[1]!, data: Buffer.from(match[2]!, "base64") }
}

const failure = (message: string) => (cause: unknown) =>
  new AttachmentError({ message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}` })

/** Copies user-supplied files into `<userData>/attachments/<threadId>/` so agents get a stable absolute path. */
export class Attachments extends Context.Service<
  Attachments,
  {
    readonly stage: (
      threadId: string,
      source: AttachmentSource,
    ) => Effect.Effect<Attachment, AttachmentError | AttachmentTooLargeError>
    readonly read: (path: string) => Effect.Effect<{ readonly dataUrl: string }, AttachmentError>
  }
>()("hinacode/Attachments") {}

const stage = (threadId: string, source: AttachmentSource) =>
  Effect.gen(function* () {
    const id = randomUUID()
    const dir = join(attachmentsRoot(), safeName(threadId))
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

const read = (path: string) =>
  isInside(attachmentsRoot(), path)
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

export const layer = Layer.succeed(Attachments, Attachments.of({ stage, read }))
