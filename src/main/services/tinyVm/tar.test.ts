import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeTar, encodeTar, readTree, type TarEntry } from "./tar.ts"

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
