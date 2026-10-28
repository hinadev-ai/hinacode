import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { Effect, Schema } from "effect"

/** One entry of a tar archive. `path` is relative, slash-separated, with no leading slash. */
export type TarEntry =
  | {
      readonly type: "file"
      readonly path: string
      readonly data: Uint8Array
      readonly mode: number
      readonly mtime: number
    }
  | { readonly type: "dir"; readonly path: string; readonly mode: number; readonly mtime: number }
  | {
      readonly type: "symlink"
      readonly path: string
      readonly target: string
      readonly mode: number
      readonly mtime: number
    }

export class TarError extends Schema.TaggedError<TarError>()("TarError", { message: Schema.String }) {}

const BLOCK = 512
const textEncoder = new TextEncoder()

const octal = (value: number, width: number) => {
  const digits = Math.trunc(value).toString(8)
  if (digits.length > width - 1) throw new TarError({ message: `value ${value} does not fit a tar header field` })
  return digits.padStart(width - 1, "0") + "\0"
}

const writeText = (header: Buffer, offset: number, text: string, width: number) => {
  const bytes = textEncoder.encode(text)
  if (bytes.length > width) throw new TarError({ message: `"${text}" does not fit a tar header field` })
  header.set(bytes, offset)
}

/** Ustar holds a path of at most 100 bytes, or a prefix of 155 plus a name of 100, split at a slash. */
const splitPath = (path: string): { readonly name: string; readonly prefix: string } => {
  if (textEncoder.encode(path).length <= 100) return { name: path, prefix: "" }
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (textEncoder.encode(prefix).length <= 155 && textEncoder.encode(name).length <= 100) return { name, prefix }
  }
  throw new TarError({ message: `"${path}" is too long for a tar archive` })
}

const header = (entry: TarEntry, size: number, typeflag: string) => {
  const { name, prefix } = splitPath(entry.path)
  const bytes = Buffer.alloc(BLOCK)
  writeText(bytes, 0, name, 100)
  writeText(bytes, 100, octal(entry.mode & 0o7777, 8), 8)
  writeText(bytes, 108, octal(0, 8), 8)
  writeText(bytes, 116, octal(0, 8), 8)
  writeText(bytes, 124, octal(size, 12), 12)
  writeText(bytes, 136, octal(entry.mtime, 12), 12)
  bytes[156] = typeflag.charCodeAt(0)
  if (entry.type === "symlink") writeText(bytes, 157, entry.target, 100)
  writeText(bytes, 257, "ustar\0", 6)
  writeText(bytes, 263, "00", 2)
  writeText(bytes, 329, octal(0, 8), 8)
  writeText(bytes, 337, octal(0, 8), 8)
  if (prefix) writeText(bytes, 345, prefix, 155)
  bytes.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of bytes) sum += byte
  writeText(bytes, 148, sum.toString(8).padStart(6, "0") + "\0 ", 8)
  return bytes
}

/**
 * Encodes entries as an uncompressed ustar archive: no pax headers and no platform junk entries, so a strict
 * reader sees exactly these entries. System tar on macOS adds AppleDouble `._` entries instead, which is why
 * this writer exists.
 */
export const encodeTar = (entries: ReadonlyArray<TarEntry>): Uint8Array => {
  const parts: Array<Uint8Array> = []
  for (const entry of entries) {
    if (entry.type === "dir") {
      parts.push(header({ ...entry, path: entry.path.replace(/\/?$/, "/") }, 0, "5"))
    } else if (entry.type === "symlink") {
      parts.push(header(entry, 0, "2"))
    } else {
      parts.push(header(entry, entry.data.length, "0"))
      parts.push(entry.data)
      const rest = entry.data.length % BLOCK
      if (rest > 0) parts.push(new Uint8Array(BLOCK - rest))
    }
  }
  parts.push(new Uint8Array(BLOCK * 2))
  return Buffer.concat(parts)
}

const toTarError = (path: string) => (cause: unknown) =>
  new TarError({ message: `Cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}` })

/**
 * Reads the file or directory at `topPath` into entries whose first path segment is its base name, refusing
 * once the files would total more than `maxBytes`. Symlinks are stored as links and never followed.
 */
export const readTree = (topPath: string, maxBytes: number): Effect.Effect<ReadonlyArray<TarEntry>, TarError> =>
  Effect.gen(function* () {
    const entries: Array<TarEntry> = []
    let total = 0
    const walk = (path: string, archivePath: string): Effect.Effect<void, TarError> =>
      Effect.gen(function* () {
        const stats = yield* Effect.tryPromise({ try: () => lstat(path), catch: toTarError(path) })
        const mtime = Math.floor(stats.mtimeMs / 1000)
        if (stats.isSymbolicLink()) {
          const target = yield* Effect.tryPromise({ try: () => readlink(path), catch: toTarError(path) })
          entries.push({ type: "symlink", path: archivePath, target, mode: stats.mode, mtime })
        } else if (stats.isDirectory()) {
          entries.push({ type: "dir", path: archivePath, mode: stats.mode, mtime })
          const names = yield* Effect.tryPromise({ try: () => readdir(path), catch: toTarError(path) })
          for (const name of names.toSorted()) yield* walk(join(path, name), `${archivePath}/${name}`)
        } else if (stats.isFile()) {
          total += stats.size
          if (total > maxBytes)
            return yield* new TarError({
              message: `${topPath} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`,
            })
          const data = yield* Effect.tryPromise({ try: () => readFile(path), catch: toTarError(path) })
          entries.push({ type: "file", path: archivePath, data, mode: stats.mode, mtime })
        }
      })
    yield* walk(topPath, basename(topPath))
    return entries
  })

/** The pax keys `decodeTar` applies; any other record is skipped. */
const PAX_KEYS = new Set(["path", "linkpath", "size"])
/** Go's archive/tar refuses larger pax headers too, which bounds the work an untrusted archive can cause. */
const MAX_PAX_BYTES = 1024 * 1024

/** Reads the records `decodeTar` uses from a pax extended header of `length key=value\n` records. */
const paxRecords = (data: Uint8Array) => {
  if (data.length > MAX_PAX_BYTES) throw new TarError({ message: "pax header in tar archive is too large" })
  const records = new Map<string, string>()
  const decoder = new TextDecoder()
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(0x20, offset)
    const length = Number(decoder.decode(data.subarray(offset, space)))
    const end = offset + length
    if (space < 0 || !Number.isInteger(length) || end <= space || end > data.length || data[end - 1] !== 0x0a)
      throw new TarError({ message: "malformed pax header in tar archive" })
    const record = decoder.decode(data.subarray(space + 1, end - 1))
    const equals = record.indexOf("=")
    if (equals < 0) throw new TarError({ message: "malformed pax header in tar archive" })
    const key = record.slice(0, equals)
    if (PAX_KEYS.has(key)) records.set(key, record.slice(equals + 1))
    offset = end
  }
  return records
}

/**
 * Reads back an archive `encodeTar` wrote, and the ustar and pax archives Go's `archive/tar` writes in the
 * guest. Throws on a truncated archive, so a transfer that broke midway never passes for a whole one.
 */
export const decodeTar = (bytes: Uint8Array): ReadonlyArray<TarEntry> => {
  const readText = (offset: number, width: number) => {
    const slice = bytes.subarray(offset, offset + width)
    const end = slice.indexOf(0)
    return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end))
  }
  const readOctal = (offset: number, width: number) => {
    const text = readText(offset, width).trim()
    if (!/^[0-7]*$/.test(text)) throw new TarError({ message: `bad number "${text}" in tar header` })
    return text === "" ? 0 : Number.parseInt(text, 8)
  }
  const entries: Array<TarEntry> = []
  let pax = new Map<string, string>()
  for (let offset = 0; offset + BLOCK <= bytes.length;) {
    const block = bytes.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) return entries
    const name = readText(offset, 100)
    const prefix = readText(offset + 345, 155)
    const path = pax.get("path") ?? (prefix ? `${prefix}/${name}` : name)
    const mode = readOctal(offset + 100, 8)
    const paxSize = pax.get("size")
    const size = paxSize === undefined ? readOctal(offset + 124, 12) : Number(paxSize)
    const mtime = readOctal(offset + 136, 12)
    const typeflag = String.fromCharCode(block[156] ?? 0)
    const linkTarget = pax.get("linkpath") ?? readText(offset + 157, 100)
    offset += BLOCK
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > bytes.length)
      throw new TarError({ message: `tar archive is truncated at "${path}"` })
    const data = bytes.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK
    if (typeflag === "x") {
      pax = paxRecords(data)
      continue
    }
    pax = new Map()
    if (typeflag === "g") {
      if (size > MAX_PAX_BYTES) throw new TarError({ message: "pax header in tar archive is too large" })
      continue
    }
    if (typeflag === "5") {
      entries.push({ type: "dir", path: path.replace(/\/$/, ""), mode, mtime })
    } else if (typeflag === "2") {
      entries.push({ type: "symlink", path, target: linkTarget, mode, mtime })
    } else if (typeflag === "0" || typeflag === "\0") {
      entries.push({ type: "file", path, data, mode, mtime })
    } else {
      throw new TarError({ message: `unsupported tar entry type "${typeflag}" for "${path}"` })
    }
  }
  throw new TarError({ message: "tar archive is truncated" })
}

/** What `writeTree` put on disk. */
export interface WrittenTree {
  /** Absolute path of the archive's top-level entry. */
  readonly path: string
  readonly files: number
  readonly bytes: number
  /** Archive paths of the symlinks it skipped. */
  readonly skippedLinks: ReadonlyArray<string>
}

/** The path's segments, or undefined when one is empty, `.`, `..` or holds a backslash or NUL. */
const segmentsOf = (path: string) => {
  const segments = path.split("/")
  const safe = segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\\\0]/.test(segment),
  )
  return safe ? segments : undefined
}

const writeEntries = (dir: string, entries: ReadonlyArray<TarEntry>) =>
  Effect.gen(function* () {
    let files = 0
    let bytes = 0
    const skippedLinks: Array<string> = []
    for (const entry of entries) {
      const target = join(dir, entry.path)
      if (entry.type === "symlink") {
        skippedLinks.push(entry.path)
      } else if (entry.type === "dir") {
        yield* Effect.tryPromise({
          try: () => mkdir(target, { recursive: true, mode: 0o755 }),
          catch: toTarError(target),
        })
      } else {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(target), { recursive: true, mode: 0o755 })
            await writeFile(target, entry.data, { flag: "wx", mode: 0o644 })
          },
          catch: toTarError(target),
        })
        files++
        bytes += entry.data.length
      }
    }
    return { files, bytes, skippedLinks: skippedLinks as ReadonlyArray<string> }
  })

/**
 * Writes the files and directories of an archive with one top-level entry into `dir`, which this creates and
 * which must not exist yet. It never writes a symlink and refuses any path that could leave `dir`, so an
 * archive from an untrusted source can only add new files under `dir`. Files are written 0644 and
 * directories 0755, whatever the archive says. If writing fails partway, `dir` is removed again.
 */
export const writeTree = (dir: string, entries: ReadonlyArray<TarEntry>): Effect.Effect<WrittenTree, TarError> =>
  Effect.gen(function* () {
    const top = entries[0]
    if (top === undefined) return yield* new TarError({ message: "The archive is empty" })
    if (top.type === "symlink" && !top.path.includes("/"))
      return yield* new TarError({ message: `${top.path} is a symlink to ${top.target}. Copy its target instead.` })
    const root = segmentsOf(top.path)?.[0]
    const unsafe = entries.find((entry) => root === undefined || segmentsOf(entry.path)?.[0] !== root)
    if (root === undefined || unsafe !== undefined)
      return yield* new TarError({ message: `The archive holds an unsafe path: "${(unsafe ?? top).path}"` })
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(dir), { recursive: true })
        await mkdir(dir)
      },
      catch: toTarError(dir),
    })
    return yield* writeEntries(dir, entries).pipe(
      Effect.map((written) => ({ path: join(dir, root), ...written })),
      Effect.tapError(() => Effect.promise(() => rm(dir, { recursive: true, force: true }).catch(() => undefined))),
    )
  })
