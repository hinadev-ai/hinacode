import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { lock } from "proper-lockfile"
import {
  type Artifact,
  type ArtifactAuthor,
  type ArtifactKind,
  ArtifactSchema,
  contentType,
  DOCUMENT_ENTRY,
  isArtifactId,
  normalizeArtifactPath,
  WHITEBOARD_ENTRY,
} from "./artifact.ts"
import {
  type ArtifactComment,
  type ArtifactFeedback,
  ArtifactFeedbackSchema,
  type CommentAnchor,
  CommentAnchorSchema,
  type CommentAuthor,
  type CommentMessage,
  emptyFeedback,
} from "./feedback.ts"
import {
  duplicateId,
  EMPTY_SCENE,
  mergeScene,
  parseScene,
  sceneFile,
  type WhiteboardPatch,
  type WhiteboardScene,
} from "./whiteboard.ts"

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024

export class ArtifactError extends Error {
  override name = "ArtifactError"
}

export class ArtifactConflictError extends ArtifactError {
  override name = "ArtifactConflictError"
  readonly current: Artifact
  constructor(current: Artifact) {
    super(`Artifact ${current.id} is at version ${current.version}.`)
    this.current = current
  }
}

type FileInput = { path: string; content: string; encoding?: "utf8" | "base64" }

type PublishCommon = {
  id?: string
  title?: string
  threadId?: string
  baseRevision?: number
  author?: ArtifactAuthor
}

type ContentInput =
  | { kind?: "page"; entry?: string; files: FileInput[] }
  | { kind: "document"; markdown: string }
  | { kind: "whiteboard"; scene: WhiteboardScene }

export type PublishInput =
  | (PublishCommon & ContentInput)
  | (PublishCommon & { kind: "whiteboard"; patch: WhiteboardPatch })

const sceneOf = (scene: WhiteboardScene) => {
  const duplicate = duplicateId(scene.elements.map((element) => element.id))
  if (duplicate !== undefined) throw new ArtifactError(`The element id "${duplicate}" appears more than once.`)
  return sceneFile(scene)
}

const contentOf = (input: ContentInput): { kind: ArtifactKind; entry: string; files: FileInput[] } => {
  switch (input.kind) {
    case "document":
      return { kind: "document", entry: DOCUMENT_ENTRY, files: [{ path: DOCUMENT_ENTRY, content: input.markdown }] }
    case "whiteboard":
      return {
        kind: "whiteboard",
        entry: WHITEBOARD_ENTRY,
        files: [{ path: WHITEBOARD_ENTRY, content: sceneOf(input.scene) }],
      }
    case "page":
    case undefined:
      return { kind: "page", entry: input.entry ?? "index.html", files: input.files }
  }
}

const updateTool: Record<ArtifactKind, string> = {
  page: "publish_artifact",
  document: "publish_document",
  whiteboard: "publish_whiteboard",
}

const checkPatch = ({ upsert, remove = [] }: WhiteboardPatch) => {
  const duplicate = duplicateId(upsert.map((element) => element.id))
  if (duplicate !== undefined) throw new ArtifactError(`The element id "${duplicate}" appears more than once.`)
  const both = upsert.find((element) => remove.includes(element.id))
  if (both !== undefined) throw new ArtifactError(`The element "${both.id}" is both added and removed. Pass it once.`)
}

export type CommentInput = {
  comment?: string
  anchor?: CommentAnchor
  author: CommentAuthor
  body: string
  resolve?: boolean
  undelivered?: true
}

export type ArtifactFileContent = {
  bytes: Uint8Array<ArrayBuffer>
  type: string
  version: number
  revision: number
  kind: ArtifactKind
}

export type ArtifactStore = {
  root: string
  publish(input: PublishInput): Promise<Artifact>
  get(id: string): Promise<Artifact | null>
  list(): Promise<Artifact[]>
  file(id: string, path: string): Promise<ArtifactFileContent | null>
  remove(id: string): Promise<boolean>
  rename(id: string, title: string): Promise<Artifact>
  addDocumentImage(id: string, image: { bytes: Uint8Array; type: string }): Promise<string>
  feedback(id: string): Promise<ArtifactFeedback | null>
  comment(id: string, input: CommentInput): Promise<{ feedback: ArtifactFeedback; comment: ArtifactComment }>
  resolveComment(id: string, comment: string, resolved: boolean): Promise<ArtifactFeedback>
  markDelivered(id: string, message: string): Promise<ArtifactFeedback>
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

const randomText = (length: number) =>
  Array.from(randomBytes(length), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")

const newId = () => randomText(12)

const shortId = (prefix: "c" | "m") => `${prefix}_${randomText(6)}`

const FEEDBACK_FILE = "feedback.json"

const decodeFiles = (files: FileInput[]) => {
  if (files.length === 0) throw new ArtifactError("An artifact needs at least one file, such as index.html.")
  const decoded = new Map<string, Buffer>()
  let total = 0
  for (const file of files) {
    const path = normalizeArtifactPath(file.path)
    if (path === null) {
      throw new ArtifactError(
        `Invalid file path "${file.path}". Use a relative path inside the artifact, such as "index.html" or "assets/app.js".`,
      )
    }
    if (decoded.has(path)) throw new ArtifactError(`The file "${path}" appears more than once.`)
    const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")
    total += bytes.byteLength
    decoded.set(path, bytes)
  }
  if (total > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(`The artifact is ${total} bytes. A version holds at most ${MAX_ARTIFACT_BYTES} bytes.`)
  }
  for (const path of decoded.keys()) {
    const parts = path.split("/")
    for (let depth = 1; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join("/")
      if (decoded.has(parent)) throw new ArtifactError(`"${parent}" cannot be both a file and a directory.`)
    }
  }
  return decoded
}

const claimVersion = async (directory: string, from: number): Promise<number> => {
  try {
    await mkdir(join(directory, String(from)))
    return from
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
    return claimVersion(directory, from + 1)
  }
}

const lockArtifact = async (directory: string, onCompromised: (error: Error) => void) => {
  for (;;) {
    try {
      return await lock(directory, { realpath: false, onCompromised })
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ELOCKED") throw error
      await delay(25)
    }
  }
}

const titleOf = (title: string | undefined) => {
  const trimmed = title?.trim() ?? ""
  if (trimmed === "") throw new ArtifactError("An artifact needs a title.")
  return trimmed
}

const IMAGE_DIRECTORY = "images"

const imageExtensions: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

const isDocumentImagePath = (path: string) => {
  const [directory, name, ...rest] = path.split("/")
  return directory === IMAGE_DIRECTORY && name !== undefined && rest.length === 0
}

const imageName = ({ bytes, type }: { bytes: Uint8Array; type: string }) => {
  const extension = imageExtensions[type]
  if (extension === undefined) {
    throw new ArtifactError(`A document image cannot be ${type}. Paste a PNG, JPEG, GIF or WebP image.`)
  }
  if (bytes.byteLength === 0) throw new ArtifactError("The image is empty. Paste an image with content.")
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(
      `The image is ${bytes.byteLength} bytes. An image holds at most ${MAX_ARTIFACT_BYTES} bytes.`,
    )
  }
  return `${createHash("sha256").update(bytes).digest("hex")}.${extension}`
}

const missing = (id: string) => new ArtifactError(`No artifact has the id "${id}". Omit id to publish a new artifact.`)

const unknown = (id: string) => new ArtifactError(`No artifact has the id "${id}". Call list_artifacts to see the ids.`)

const isMissingFile = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")

const anchorOn = (artifact: Artifact, anchor: CommentAnchor): CommentAnchor => {
  const parsed = CommentAnchorSchema.safeParse(anchor)
  if (!parsed.success) throw new ArtifactError(parsed.error.issues[0]?.message ?? "Invalid anchor.")
  if (parsed.data.kind === "text" && artifact.kind !== "document") {
    throw new ArtifactError(`Artifact ${artifact.id} is a ${artifact.kind}. Only a document's comments quote text.`)
  }
  if (parsed.data.kind === "elements" && artifact.kind !== "whiteboard") {
    throw new ArtifactError(
      `Artifact ${artifact.id} is a ${artifact.kind}. Only a whiteboard's comments name elements.`,
    )
  }
  return parsed.data
}

const withComment = (current: ArtifactFeedback, comment: ArtifactComment) => {
  const comments = current.comments.some((existing) => existing.id === comment.id)
    ? current.comments.map((existing) => (existing.id === comment.id ? comment : existing))
    : [...current.comments, comment]
  const updated = { ...current, comments }
  return { feedback: updated, result: { feedback: updated, comment } }
}

const findComment = (current: ArtifactFeedback, artifact: Artifact, id: string) => {
  const found = current.comments.find((comment) => comment.id === id)
  if (found === undefined) {
    throw new ArtifactError(`Artifact ${artifact.id} has no comment "${id}". read_artifact lists its open comments.`)
  }
  return found
}

export const openArtifactStore = (root: string, options: { now?: () => Date } = {}): ArtifactStore => {
  const now = options.now ?? (() => new Date())

  const withLock = async <T>(id: string, operation: (assertLocked: () => void) => Promise<T>): Promise<T> => {
    await mkdir(root, { recursive: true })
    let compromised: Error | undefined
    const release = await lockArtifact(join(root, id), (error) => {
      compromised = error
    })
    const assertLocked = () => {
      if (compromised !== undefined)
        throw new ArtifactError("The artifact lock was lost. Try publishing again.", { cause: compromised })
    }
    try {
      const result = await operation(assertLocked)
      assertLocked()
      return result
    } finally {
      if (compromised === undefined) await release()
    }
  }

  const get = async (id: string): Promise<Artifact | null> => {
    if (!isArtifactId(id)) return null
    try {
      const manifest = ArtifactSchema.safeParse(JSON.parse(await readFile(join(root, id, "artifact.json"), "utf8")))
      return manifest.success && manifest.data.id === id ? manifest.data : null
    } catch {
      return null
    }
  }

  const list = async () => {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const artifacts = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => get(entry.name)))
    return artifacts.filter((artifact) => artifact !== null).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  const writeJson = async (id: string, name: string, value: unknown, assertLocked: () => void) => {
    const directory = join(root, id)
    const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
    assertLocked()
    await rename(temporary, join(directory, name))
  }

  const writeManifest = (artifact: Artifact, assertLocked: () => void) =>
    writeJson(artifact.id, "artifact.json", artifact, assertLocked)

  const currentScene = async (artifact: Artifact | null) => {
    if (artifact === null) return EMPTY_SCENE
    const text = await readFile(join(root, artifact.id, String(artifact.version), WHITEBOARD_ENTRY), "utf8")
    const scene = parseScene(text)
    if (scene === null) throw new ArtifactError(`Whiteboard ${artifact.id} holds a scene that cannot be read.`)
    return scene
  }

  const prepare = (input: ContentInput) => {
    const content = contentOf(input)
    const files = decodeFiles(content.files)
    const entry = normalizeArtifactPath(content.entry)
    if (entry === null || !files.has(entry)) {
      throw new ArtifactError(
        `The entry "${content.entry}" is not one of the files. Include it, or set entry to a file you publish.`,
      )
    }
    return { kind: content.kind, entry, files }
  }

  const publish = async (input: PublishInput): Promise<Artifact> => {
    if (input.id === undefined) titleOf(input.title)
    const patch = "patch" in input ? input.patch : undefined
    if (patch !== undefined) checkPatch(patch)
    const prepared = "patch" in input ? null : prepare(input)
    if (input.id !== undefined && !isArtifactId(input.id)) {
      throw new ArtifactError(
        `Invalid artifact id "${input.id}". Pass an id that ${updateTool[input.kind ?? "page"]} returned.`,
      )
    }
    const id = input.id ?? newId()
    return withLock(id, async (assertLocked) => {
      const previous = input.id === undefined ? null : await get(id)
      if (input.id !== undefined && previous === null) throw missing(id)
      const title = titleOf(input.title ?? previous?.title)
      const kind = input.kind ?? "page"
      if (previous !== null && previous.kind !== kind) {
        throw new ArtifactError(`Artifact ${id} is a ${previous.kind}. Update it with ${updateTool[previous.kind]}.`)
      }
      if (previous !== null && input.baseRevision !== undefined && previous.revision !== input.baseRevision) {
        throw new ArtifactConflictError(previous)
      }
      const { entry, files } =
        prepared ??
        prepare({
          kind: "whiteboard",
          scene: mergeScene(await currentScene(previous), patch ?? { upsert: [] }),
        })

      const author = input.author ?? "agent"
      const inPlace = previous !== null && author === "developer" && previous.author === "developer"
      const directory = join(root, id)
      await mkdir(directory, { recursive: true })
      const version = inPlace ? previous.version : await claimVersion(directory, (previous?.version ?? 0) + 1)
      const versionDirectory = join(directory, String(version))
      for (const [path, bytes] of files) {
        assertLocked()
        const target = join(versionDirectory, path)
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.${randomUUID()}.tmp`
        await writeFile(temporary, bytes)
        await rename(temporary, target)
      }

      const timestamp = now().toISOString()
      const threadId = previous?.threadId ?? input.threadId
      const artifact: Artifact = {
        id,
        kind,
        title,
        entry,
        version,
        revision: (previous?.revision ?? 0) + 1,
        author,
        files: Array.from(files, ([path, bytes]) => ({ path, type: contentType(path), size: bytes.byteLength })),
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        ...(threadId === undefined ? {} : { threadId }),
      }
      await writeManifest(artifact, assertLocked)
      if (inPlace) return artifact

      const stale = (await readdir(directory)).filter(
        (name) => /^\d+$/.test(name) && Number(name) !== version && Number(name) !== previous?.version,
      )
      assertLocked()
      await Promise.all(stale.map((name) => rm(join(directory, name), { recursive: true, force: true })))
      return artifact
    })
  }

  const file = async (id: string, path: string) => {
    const normalized = normalizeArtifactPath(path)
    if (normalized === null) return null
    let missingVersion: number | undefined
    for (;;) {
      const artifact = await get(id)
      if (!artifact) return null
      const listed = artifact.files.find((candidate) => candidate.path === normalized)
      if (!listed)
        return artifact.kind === "document" && isDocumentImagePath(normalized) ? image(artifact, normalized) : null
      if (artifact.version === missingVersion) return null
      try {
        const bytes = await readFile(join(root, id, String(artifact.version), listed.path))
        return {
          bytes,
          type: contentType(listed.path),
          version: artifact.version,
          revision: artifact.revision,
          kind: artifact.kind,
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return null
        missingVersion = artifact.version
      }
    }
  }

  const image = async (artifact: Artifact, path: string): Promise<ArtifactFileContent | null> => {
    try {
      const bytes = await readFile(join(root, artifact.id, path))
      return {
        bytes,
        type: contentType(path),
        version: artifact.version,
        revision: artifact.revision,
        kind: artifact.kind,
      }
    } catch {
      return null
    }
  }

  const addDocumentImage = async (id: string, input: { bytes: Uint8Array; type: string }) => {
    const name = imageName(input)
    if (!isArtifactId(id)) throw missing(id)
    return withLock(id, async (assertLocked) => {
      const artifact = await get(id)
      if (artifact === null) throw missing(id)
      if (artifact.kind !== "document") {
        throw new ArtifactError(`Artifact ${id} is a ${artifact.kind}. Only a document stores pasted images.`)
      }
      const path = `${IMAGE_DIRECTORY}/${name}`
      const target = join(root, id, path)
      await mkdir(dirname(target), { recursive: true })
      const temporary = `${target}.${randomUUID()}.tmp`
      await writeFile(temporary, input.bytes)
      assertLocked()
      await rename(temporary, target)
      return path
    })
  }

  const remove = async (id: string) => {
    if (!isArtifactId(id)) return false
    return withLock(id, async (assertLocked) => {
      if ((await get(id)) === null) return false
      assertLocked()
      await rm(join(root, id), { recursive: true, force: true })
      return true
    })
  }

  const renameArtifact = async (id: string, title: string) => {
    const name = titleOf(title)
    if (!isArtifactId(id)) throw missing(id)
    return withLock(id, async (assertLocked) => {
      const previous = await get(id)
      if (previous === null) throw missing(id)
      const artifact = { ...previous, title: name, updatedAt: now().toISOString() }
      await writeManifest(artifact, assertLocked)
      return artifact
    })
  }

  const readFeedback = async (id: string): Promise<ArtifactFeedback> => {
    let text: string
    try {
      text = await readFile(join(root, id, FEEDBACK_FILE), "utf8")
    } catch (error) {
      if (isMissingFile(error)) return emptyFeedback()
      throw error
    }
    const parsed = ArtifactFeedbackSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new ArtifactError(`The feedback of artifact ${id} cannot be read.`)
    return parsed.data
  }

  const feedback = async (id: string) => ((await get(id)) === null ? null : readFeedback(id))

  const updateFeedback = async <T>(
    id: string,
    change: (
      current: ArtifactFeedback,
      artifact: Artifact,
      timestamp: string,
    ) => { feedback: ArtifactFeedback; result: T },
  ) => {
    if (!isArtifactId(id)) throw unknown(id)
    return withLock(id, async (assertLocked) => {
      const artifact = await get(id)
      if (artifact === null) throw unknown(id)
      const next = change(await readFeedback(id), artifact, now().toISOString())
      await writeJson(id, FEEDBACK_FILE, next.feedback, assertLocked)
      return next.result
    })
  }

  const comment = (id: string, input: CommentInput) =>
    updateFeedback(id, (current, artifact, timestamp) => {
      const body = input.body.trim()
      const message: CommentMessage | null =
        body === ""
          ? null
          : {
              id: shortId("m"),
              author: input.author,
              body,
              createdAt: timestamp,
              ...(input.undelivered && { undelivered: true }),
            }
      if (input.comment === undefined) {
        if (message === null) throw new ArtifactError("A comment needs a body.")
        return withComment(current, {
          id: shortId("c"),
          anchor: anchorOn(artifact, input.anchor ?? { kind: "artifact" }),
          resolved: input.resolve ?? false,
          messages: [message],
          createdAt: timestamp,
          updatedAt: timestamp,
        })
      }
      if (input.anchor !== undefined) {
        throw new ArtifactError("A reply keeps its comment's anchor. Pass either a comment to reply to or an anchor.")
      }
      const replied = findComment(current, artifact, input.comment)
      if (message === null && input.resolve === undefined) {
        throw new ArtifactError("A reply needs a body, unless it only resolves the comment.")
      }
      return withComment(current, {
        ...replied,
        resolved: input.resolve ?? (message === null ? replied.resolved : false),
        messages: message === null ? replied.messages : [...replied.messages, message],
        updatedAt: timestamp,
      })
    })

  const resolveComment = (id: string, commentId: string, resolved: boolean) =>
    updateFeedback(id, (current, artifact, timestamp) => {
      const { feedback: updated } = withComment(current, {
        ...findComment(current, artifact, commentId),
        resolved,
        updatedAt: timestamp,
      })
      return { feedback: updated, result: updated }
    })

  const markDelivered = (id: string, messageId: string) =>
    updateFeedback(id, (current) => {
      const delivered = (message: CommentMessage): CommentMessage => {
        if (message.id !== messageId) return message
        const { undelivered: _, ...rest } = message
        return rest
      }
      const comments = current.comments.map(({ messages: [first, ...rest], ...comment }) => ({
        ...comment,
        messages: [delivered(first), ...rest.map(delivered)] satisfies ArtifactComment["messages"],
      }))
      const feedback = { ...current, comments }
      return { feedback, result: feedback }
    })

  return {
    root,
    publish,
    get,
    list,
    file,
    remove,
    rename: renameArtifact,
    addDocumentImage,
    feedback,
    comment,
    resolveComment,
    markDelivered,
  }
}
