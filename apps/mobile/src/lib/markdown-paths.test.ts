import { describe, expect, it } from "vitest"
import { resolveFileLink, resolveImageSource } from "./markdown-paths"

const root = "/abs/root"

describe("resolveImageSource", () => {
  it("loads URLs directly", () => {
    expect(resolveImageSource("https://example.com/a.png", root)).toEqual({
      kind: "uri",
      uri: "https://example.com/a.png",
    })
    expect(resolveImageSource("http://example.com/a.png", null)).toEqual({ kind: "uri", uri: "http://example.com/a.png" })
    expect(resolveImageSource("data:image/png;base64,AAAA", null)).toEqual({
      kind: "uri",
      uri: "data:image/png;base64,AAAA",
    })
  })

  it("resolves relative paths against the root", () => {
    expect(resolveImageSource("./.context/image-1.png", root)).toEqual({
      kind: "file",
      root,
      path: ".context/image-1.png",
    })
    expect(resolveImageSource("docs/a.png", root)).toEqual({ kind: "file", root, path: "docs/a.png" })
    expect(resolveImageSource("docs/../shots/./b.png", root)).toEqual({ kind: "file", root, path: "shots/b.png" })
    expect(resolveImageSource("docs//c.png", root)).toEqual({ kind: "file", root, path: "docs/c.png" })
  })

  it("decodes escapes and drops the query and hash", () => {
    expect(resolveImageSource("./my%20shot.png?raw=1", root)).toEqual({ kind: "file", root, path: "my shot.png" })
    expect(resolveImageSource("a.png#zoom", root)).toEqual({ kind: "file", root, path: "a.png" })
  })

  it("refuses paths that leave the root", () => {
    expect(resolveImageSource("../escape.png", root)).toEqual({ kind: "unavailable", reason: "outsideRoot" })
    expect(resolveImageSource("a/../../escape.png", root)).toEqual({ kind: "unavailable", reason: "outsideRoot" })
    expect(resolveImageSource("/etc/passwd", root)).toEqual({ kind: "unavailable", reason: "outsideRoot" })
    expect(resolveImageSource("/abs/rootish/a.png", root)).toEqual({ kind: "unavailable", reason: "outsideRoot" })
    expect(resolveImageSource("/abs/root/../other/a.png", root)).toEqual({
      kind: "unavailable",
      reason: "outsideRoot",
    })
  })

  it("makes absolute paths inside the root relative", () => {
    expect(resolveImageSource("/abs/root/a.png", root)).toEqual({ kind: "file", root, path: "a.png" })
    expect(resolveImageSource("/abs/root/a.png", "/abs/root/")).toEqual({ kind: "file", root: "/abs/root/", path: "a.png" })
    expect(resolveImageSource("file:///abs/root/img/b.png", root)).toEqual({ kind: "file", root, path: "img/b.png" })
  })

  it("needs a root for a path", () => {
    expect(resolveImageSource("./a.png", null)).toEqual({ kind: "unavailable", reason: "noRoot" })
  })

  it("rejects what is not a file", () => {
    expect(resolveImageSource("", root)).toEqual({ kind: "unavailable", reason: "invalid" })
    expect(resolveImageSource("ftp://example.com/a.png", root)).toEqual({ kind: "unavailable", reason: "invalid" })
    expect(resolveImageSource("./%E0%A4%A.png", root)).toEqual({ kind: "unavailable", reason: "invalid" })
    expect(resolveImageSource("/abs/root", root)).toEqual({ kind: "unavailable", reason: "invalid" })
    expect(resolveImageSource(".", root)).toEqual({ kind: "unavailable", reason: "invalid" })
  })
})

describe("paths in a Markdown file", () => {
  it("start from the file's folder", () => {
    expect(resolveImageSource("./shot.png", root, "docs/guide")).toEqual({ kind: "file", root, path: "docs/guide/shot.png" })
    expect(resolveFileLink("../README.md", root, "docs")).toBe("README.md")
    expect(resolveFileLink("/abs/root/src/a.ts", root, "docs")).toBe("src/a.ts")
  })

  it("treat a link to an anchor as no file", () => {
    expect(resolveFileLink("#setup", root, "docs")).toBeNull()
    expect(resolveFileLink("?tab=1", root, "docs")).toBeNull()
  })

  it("still cannot climb out of the root", () => {
    expect(resolveFileLink("../../x.md", root, "docs")).toBeNull()
  })
})

describe("resolveFileLink", () => {
  it("resolves a relative link to a path in the root", () => {
    expect(resolveFileLink("./README.md", root)).toBe("README.md")
    expect(resolveFileLink("src/a%20b.ts#L10", root)).toBe("src/a b.ts")
  })

  it("returns null for anything that is not a file in the root", () => {
    expect(resolveFileLink("./README.md", null)).toBeNull()
    expect(resolveFileLink("../outside.md", root)).toBeNull()
    expect(resolveFileLink("#section", root)).toBeNull()
    expect(resolveFileLink("mailto:me@example.com", root)).toBeNull()
  })
})
