import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeTar, encodeTar, readTree, type TarEntry, writeTree } from "./tar.ts"

const text = new TextEncoder()
const file = (path: string, content: string): TarEntry => ({
  type: "file",
  path,
  data: text.encode(content),
  mode: 0o644,
  mtime: 1700000000,
})

describe("encodeTar and decodeTar", () => {
  it("round-trips files, directories and symlinks with one top-level entry", () => {
    const entries: Array<TarEntry> = [
      { type: "dir", path: "proj", mode: 0o755, mtime: 1700000000 },
      file("proj/readme.md", "hello\n"),
      file("proj/empty.bin", ""),
      { type: "symlink", path: "proj/link", target: "readme.md", mode: 0o777, mtime: 1700000000 },
    ]
    const decoded = decodeTar(encodeTar(entries))
    expect(decoded.map((entry) => `${entry.type}:${entry.path}`)).toStrictEqual([
      "dir:proj",
      "file:proj/readme.md",
      "file:proj/empty.bin",
      "symlink:proj/link",
    ])
    const readme = decoded[1]
    expect(readme?.type).toBe("file")
    if (readme?.type === "file") expect(new TextDecoder().decode(readme.data)).toBe("hello\n")
    const link = decoded[3]
    if (link?.type === "symlink") expect(link.target).toBe("readme.md")
  })

  it("emits no platform junk entries and handles names over 100 bytes through the prefix", () => {
    const long = `proj/${"deep/".repeat(20)}file.txt`
    const bytes = encodeTar([file(long, "x")])
    const asText = new TextDecoder("latin1").decode(bytes)
    expect(asText).not.toContain("._")
    expect(asText).not.toContain("PaxHeader")
    expect(decodeTar(bytes)[0]?.path).toBe(long)
  })

  it("rejects a single path segment longer than ustar allows", () => {
    expect(() => encodeTar([file("a".repeat(101), "")])).toThrow("too long")
  })

  it("takes a pax header's path for the next entry, as Go writes non-ASCII names", () => {
    const decoded = decodeTar(Buffer.concat([paxHeader({ path: "報告/請求書.pdf" }), encodeTar([file("x", "pdf")])]))
    expect(decoded.map((entry) => entry.path)).toStrictEqual(["報告/請求書.pdf"])
  })

  it("refuses a pax header over 1 MiB, as Go does", () => {
    const junk = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`k${index}`, "v"]))
    const archive = Buffer.concat([paxHeader(junk), encodeTar([file("x", "ok")])])
    expect(() => decodeTar(archive)).toThrow("too large")
  })

  it("refuses an archive cut off before its end marker", () => {
    const whole = encodeTar([file("proj/a.txt", "a".repeat(600))])
    expect(() => decodeTar(whole.subarray(0, 1024))).toThrow("truncated")
    expect(() => decodeTar(whole.subarray(0, whole.length - 1024))).toThrow("truncated")
  })
})

const paxHeader = (records: Record<string, string>) => {
  const body = Object.entries(records)
    .map(([key, value]) => {
      const rest = ` ${key}=${value}\n`
      const restBytes = text.encode(rest).length
      let length = restBytes + 1
      while (String(length).length + restBytes !== length) length = String(length).length + restBytes
      return `${length}${rest}`
    })
    .join("")
  const archive = Buffer.from(encodeTar([file("PaxHeaders/x", body)]))
  archive[156] = "x".charCodeAt(0)
  return archive.subarray(0, archive.length - 1024)
}

const target = () => join(mkdtempSync(join(tmpdir(), "kk-pull-")), "out")

describe("writeTree", () => {
  it.effect("writes files and folders without exec bits, and skips symlinks", () =>
    Effect.gen(function* () {
      const dir = target()
      const written = yield* writeTree(dir, [
        { type: "dir", path: "proj", mode: 0o777, mtime: 0 },
        { ...file("proj/run.sh", "echo hi"), mode: 0o4755 },
        file("proj/sub/b.txt", "bb"),
        { type: "symlink", path: "proj/link", target: "/etc/passwd", mode: 0o777, mtime: 0 },
      ])
      expect(written).toStrictEqual({ path: join(dir, "proj"), files: 2, bytes: 9, skippedLinks: ["proj/link"] })
      expect(readFileSync(join(dir, "proj/run.sh"), "utf8")).toBe("echo hi")
      expect(lstatSync(join(dir, "proj/run.sh")).mode & 0o7111).toBe(0)
      expect(readFileSync(join(dir, "proj/sub/b.txt"), "utf8")).toBe("bb")
      expect(existsSync(join(dir, "proj/link"))).toBe(false)
    }),
  )

  it.effect("refuses paths that could leave the folder and writes nothing", () =>
    Effect.gen(function* () {
      for (const path of ["../escape", "/etc/cron.d/x", "proj/../../escape", "proj//x", "proj/./x", "proj\\..\\x"]) {
        const dir = target()
        const error = yield* Effect.flip(
          writeTree(dir, [{ type: "dir", path: "proj", mode: 0o755, mtime: 0 }, file(path, "x")]),
        )
        expect(error.message).toContain("unsafe path")
        expect(existsSync(dir)).toBe(false)
      }
      const dir = target()
      const error = yield* Effect.flip(writeTree(dir, [file("proj/a", "a"), file("other/b", "b")]))
      expect(error.message).toContain('"other/b"')
    }),
  )

  it.effect("never overwrites: a repeated file fails and removes the folder", () =>
    Effect.gen(function* () {
      const dir = target()
      yield* Effect.flip(writeTree(dir, [file("proj/a", "first"), file("proj/a", "second")]))
      expect(existsSync(dir)).toBe(false)
    }),
  )

  it.effect("names the target of a symlink asked for directly", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        writeTree(target(), [{ type: "symlink", path: "latest", target: "/tmp/build-42", mode: 0o777, mtime: 0 }]),
      )
      expect(error.message).toBe("latest is a symlink to /tmp/build-42. Copy its target instead.")
    }),
  )

  it.effect("refuses a folder that already exists and leaves it alone", () =>
    Effect.gen(function* () {
      const dir = target()
      mkdirSync(dir)
      writeFileSync(join(dir, "mine.txt"), "keep")
      yield* Effect.flip(writeTree(dir, [file("proj/a", "a")]))
      expect(readdirSync(dir)).toStrictEqual(["mine.txt"])
    }),
  )
})

describe("readTree", () => {
  it.effect("reads a directory with its base name on top and refuses past the size cap", () =>
    Effect.gen(function* () {
      const root = mkdtempSync(join(tmpdir(), "kk-tar-"))
      const dir = join(root, "payload")
      mkdirSync(join(dir, "sub"), { recursive: true })
      writeFileSync(join(dir, "a.txt"), "a".repeat(100))
      writeFileSync(join(dir, "sub", "b.txt"), "b".repeat(100))
      symlinkSync("a.txt", join(dir, "alink"))

      const entries = yield* readTree(dir, 1024)
      expect(entries.map((entry) => `${entry.type}:${entry.path}`)).toStrictEqual([
        "dir:payload",
        "file:payload/a.txt",
        "symlink:payload/alink",
        "dir:payload/sub",
        "file:payload/sub/b.txt",
      ])

      const error = yield* Effect.flip(readTree(dir, 150))
      expect(error._tag).toBe("TarError")
      expect(error.message).toContain("larger than")
    }),
  )
})
