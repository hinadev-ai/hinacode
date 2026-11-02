import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type Artifact, ArtifactSchema, contentType, isArtifactId, normalizeArtifactPath } from "./artifact.ts"

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024

export class ArtifactError extends Error {
  override name = "ArtifactError"
}

export type PublishInput = {
  id?: string
  title: string
  entry?: string
  files: Array<{ path: string; content: string; encoding?: "utf8" | "base64" }>
}

export type ArtifactStore = {
  root: string
  publish(input: PublishInput): Promise<Artifact>
  get(id: string): Promise<Artifact | null>
  list(): Promise<Artifact[]>
  file(id: string, path: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null>
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

const newId = () => Array.from(randomBytes(12), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")

const decodeFiles = (files: PublishInput["files"]) => {
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

export const openArtifactStore = (root: string, options: { now?: () => Date } = {}): ArtifactStore => {
  const now = options.now ?? (() => new Date())

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

  const publish = async (input: PublishInput): Promise<Artifact> => {
    const title = input.title.trim()
    if (title === "") throw new ArtifactError("An artifact needs a title.")
    const files = decodeFiles(input.files)
    const entry = normalizeArtifactPath(input.entry ?? "index.html")
    if (entry === null || !files.has(entry)) {
      throw new ArtifactError(
        `The entry "${input.entry ?? "index.html"}" is not one of the files. Include it, or set entry to a file you publish.`,
      )
    }
    if (input.id !== undefined && !isArtifactId(input.id)) {
      throw new ArtifactError(`Invalid artifact id "${input.id}". Pass an id that publish_artifact returned.`)
    }
    const previous = input.id === undefined ? null : await get(input.id)
    if (input.id !== undefined && previous === null) {
      throw new ArtifactError(`No artifact has the id "${input.id}". Omit id to publish a new artifact.`)
    }

    const id = previous?.id ?? newId()
    const version = (previous?.version ?? 0) + 1
    const directory = join(root, id)
    const versionDirectory = join(directory, String(version))
    await rm(versionDirectory, { recursive: true, force: true })
    for (const [path, bytes] of files) {
      const target = join(versionDirectory, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }

    const timestamp = now().toISOString()
    const artifact: Artifact = {
      id,
      title,
      entry,
      version,
      files: Array.from(files, ([path, bytes]) => ({ path, type: contentType(path), size: bytes.byteLength })),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    const temporary = join(directory, `artifact.json.${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`)
    await rename(temporary, join(directory, "artifact.json"))

    const stale = (await readdir(directory)).filter((name) => /^\d+$/.test(name) && Number(name) < version - 1)
    await Promise.all(stale.map((name) => rm(join(directory, name), { recursive: true, force: true })))
    return artifact
  }

  const file = async (id: string, path: string) => {
    const normalized = normalizeArtifactPath(path)
    const artifact = normalized === null ? null : await get(id)
    const listed = artifact?.files.find((candidate) => candidate.path === normalized)
    if (!artifact || !listed) return null
    try {
      return { bytes: await readFile(join(root, id, String(artifact.version), listed.path)), type: listed.type }
    } catch {
      return null
    }
  }

  return { root, publish, get, list, file }
}
