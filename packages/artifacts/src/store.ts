import { randomBytes, randomUUID } from "node:crypto"
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
} from "./artifact.ts"

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

export type PublishInput =
  | (PublishCommon & { kind?: "page"; entry?: string; files: FileInput[] })
  | (PublishCommon & { kind: "document"; markdown: string })

const contentOf = (input: PublishInput) =>
  input.kind === "document"
    ? { kind: "document" as const, entry: DOCUMENT_ENTRY, files: [{ path: DOCUMENT_ENTRY, content: input.markdown }] }
    : { kind: "page" as const, entry: input.entry ?? "index.html", files: input.files }

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
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

const newId = () => Array.from(randomBytes(12), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")

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

const missing = (id: string) => new ArtifactError(`No artifact has the id "${id}". Omit id to publish a new artifact.`)

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

  const writeManifest = async (artifact: Artifact, assertLocked: () => void) => {
    const directory = join(root, artifact.id)
    const temporary = join(directory, `artifact.json.${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`)
    assertLocked()
    await rename(temporary, join(directory, "artifact.json"))
  }

  const publish = async (input: PublishInput): Promise<Artifact> => {
    if (input.id === undefined) titleOf(input.title)
    const content = contentOf(input)
    const files = decodeFiles(content.files)
    const entry = normalizeArtifactPath(content.entry)
    if (entry === null || !files.has(entry)) {
      throw new ArtifactError(
        `The entry "${content.entry}" is not one of the files. Include it, or set entry to a file you publish.`,
      )
    }
    if (input.id !== undefined && !isArtifactId(input.id)) {
      throw new ArtifactError(`Invalid artifact id "${input.id}". Pass an id that publish_artifact returned.`)
    }
    const id = input.id ?? newId()
    return withLock(id, async (assertLocked) => {
      const previous = input.id === undefined ? null : await get(id)
      if (input.id !== undefined && previous === null) throw missing(id)
      const title = titleOf(input.title ?? previous?.title)
      if (previous !== null && previous.kind !== content.kind) {
        throw new ArtifactError(
          `Artifact ${id} is a ${previous.kind}. Update it with ${previous.kind === "document" ? "publish_document" : "publish_artifact"}.`,
        )
      }
      if (previous !== null && input.baseRevision !== undefined && previous.revision !== input.baseRevision) {
        throw new ArtifactConflictError(previous)
      }

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
        kind: content.kind,
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
      const listed = artifact?.files.find((candidate) => candidate.path === normalized)
      if (!artifact || !listed || artifact.version === missingVersion) return null
      try {
        const bytes = await readFile(join(root, id, String(artifact.version), listed.path))
        return { bytes, type: listed.type, version: artifact.version, revision: artifact.revision, kind: artifact.kind }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return null
        missingVersion = artifact.version
      }
    }
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

  return { root, publish, get, list, file, remove, rename: renameArtifact }
}
