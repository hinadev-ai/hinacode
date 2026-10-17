import { describe, expect, it } from "vitest"
import { basename, dirname, entryIcon, extension, fileKind, svgAspectRatio } from "./file-kinds"

describe("paths", () => {
  it("splits a path into its folder and name", () => {
    expect(basename("src/app/index.ts")).toBe("index.ts")
    expect(dirname("src/app/index.ts")).toBe("src/app")
    expect(basename("README.md")).toBe("README.md")
    expect(dirname("README.md")).toBe("")
  })
})

describe("extension", () => {
  it("lowercases the last extension and ignores dots in folders", () => {
    expect(extension("src/app.v2/Logo.PNG")).toBe("png")
    expect(extension("archive.tar.gz")).toBe("gz")
    expect(extension("src.d/Makefile")).toBe("")
    expect(extension(".gitignore")).toBe("gitignore")
  })
})

describe("fileKind", () => {
  it("tells images, SVG and Markdown from text", () => {
    expect(fileKind("a/b.jpeg")).toBe("image")
    expect(fileKind("icon.AVIF")).toBe("image")
    expect(fileKind("logo.svg")).toBe("svg")
    expect(fileKind("docs/README.md")).toBe("markdown")
    expect(fileKind("page.mdx")).toBe("markdown")
    expect(fileKind("src/index.ts")).toBe("text")
    expect(fileKind("LICENSE")).toBe("text")
  })
})

describe("entryIcon", () => {
  it("picks an icon by kind and extension", () => {
    expect(entryIcon("src", "dir")).toBe("RiFolderLine")
    expect(entryIcon("src/index.tsx", "file")).toBe("RiFileCodeLine")
    expect(entryIcon("logo.svg", "file")).toBe("RiImageLine")
    expect(entryIcon("README.md", "symlink")).toBe("RiMarkdownLine")
    expect(entryIcon("notes.txt", "file")).toBe("RiFileTextLine")
    expect(entryIcon("LICENSE", "file")).toBe("RiFileTextLine")
    expect(entryIcon("data.bin", "file")).toBe("RiFileLine")
  })
})

describe("svgAspectRatio", () => {
  it("reads the viewBox first", () => {
    expect(svgAspectRatio(`<?xml version="1.0"?><svg width="10" viewBox="0 0 200 100"></svg>`)).toBe(2)
    expect(svgAspectRatio(`<svg viewBox='0,0,24,48'/>`)).toBe(0.5)
  })

  it("falls back to width and height", () => {
    expect(svgAspectRatio(`<svg width="300px" height="150"></svg>`)).toBe(2)
  })

  it("is null without a usable size", () => {
    expect(svgAspectRatio(`<svg width="100%" height="100%"></svg>`)).toBeNull()
    expect(svgAspectRatio("not an svg")).toBeNull()
  })
})
