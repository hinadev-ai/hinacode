import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { basename, join } from "node:path"
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
          for (const name of names.sort()) yield* walk(join(path, name), `${archivePath}/${name}`)
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

/** Reads back an archive `encodeTar` wrote, and archives in the same plain ustar shape. */
export const decodeTar = (bytes: Uint8Array): ReadonlyArray<TarEntry> => {
  const readText = (offset: number, width: number) => {
    const slice = bytes.subarray(offset, offset + width)
    const end = slice.indexOf(0)
    return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end))
  }
  const readOctal = (offset: number, width: number) => {
    const text = readText(offset, width).trim()
    return text === "" ? 0 : Number.parseInt(text, 8)
  }
  const entries: Array<TarEntry> = []
  for (let offset = 0; offset + BLOCK <= bytes.length;) {
    const block = bytes.subarray(offset, offset + BLOCK)
    if (block.every((byte) => byte === 0)) break
    const name = readText(offset, 100)
    const prefix = readText(offset + 345, 155)
    const path = prefix ? `${prefix}/${name}` : name
    const mode = readOctal(offset + 100, 8)
    const size = readOctal(offset + 124, 12)
    const mtime = readOctal(offset + 136, 12)
    const typeflag = String.fromCharCode(block[156] ?? 0)
    offset += BLOCK
    if (typeflag === "5") {
      entries.push({ type: "dir", path: path.replace(/\/$/, ""), mode, mtime })
    } else if (typeflag === "2") {
      entries.push({ type: "symlink", path, target: readText(offset - BLOCK + 157, 100), mode, mtime })
    } else if (typeflag === "0" || typeflag === "\0") {
      entries.push({ type: "file", path, data: bytes.slice(offset, offset + size), mode, mtime })
      offset += Math.ceil(size / BLOCK) * BLOCK
    } else {
      throw new TarError({ message: `unsupported tar entry type "${typeflag}" for "${path}"` })
    }
  }
  return entries
}
