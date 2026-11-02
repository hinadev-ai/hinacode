import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, onTestFinished, test } from "vitest"
import { normalizeArtifactPath } from "./artifact.ts"
import { ArtifactError, MAX_ARTIFACT_BYTES, openArtifactStore } from "./store.ts"

const minutes = () => {
  let minute = 0
  return () => new Date(Date.UTC(2026, 10, 2, 9, minute++))
}

const openTemporaryStore = () => {
  const root = mkdtempSync(join(tmpdir(), "hinacode-artifacts-"))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  return openArtifactStore(root, { now: minutes() })
}

const page = (body: string) => ({ path: "index.html", content: `<!doctype html>${body}` })

describe("normalizeArtifactPath", () => {
  test("keeps relative paths inside the artifact", () => {
    expect(normalizeArtifactPath("index.html")).toBe("index.html")
    expect(normalizeArtifactPath("./assets/../app.js")).toBe("app.js")
  })

  test("refuses paths that are absolute, escape or are ambiguous", () => {
    for (const path of ["", "/etc/passwd", "../secret", "a/../../b", "a\\b", "a//b", "a/", ".", "a\0b"]) {
      expect(normalizeArtifactPath(path), path).toBeNull()
    }
  })
})

describe("openArtifactStore", () => {
  test("publishes a new artifact", async () => {
    const store = openTemporaryStore()
    const artifact = await store.publish({ title: " Report ", files: [page("<h1>Hi</h1>")] })

    expect(artifact).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{12}$/),
      title: "Report",
      entry: "index.html",
      version: 1,
      files: [{ path: "index.html", type: "text/html; charset=utf-8", size: 26 }],
      createdAt: "2026-11-02T09:00:00.000Z",
      updatedAt: "2026-11-02T09:00:00.000Z",
    })
    expect(await store.get(artifact.id)).toEqual(artifact)
    const file = await store.file(artifact.id, "index.html")
    expect(new TextDecoder().decode(file?.bytes)).toBe("<!doctype html><h1>Hi</h1>")
  })

  test("updates in place, keeps createdAt and drops versions older than the previous one", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ title: "Chart", files: [page("v1"), { path: "old.css", content: "a{}" }] })
    const second = await store.publish({ id: first.id, title: "Chart", files: [page("v2")] })

    expect(second).toMatchObject({ id: first.id, version: 2, createdAt: first.createdAt })
    expect(second.updatedAt > first.updatedAt).toBe(true)
    expect(await store.file(first.id, "old.css")).toBeNull()
    expect(existsSync(join(store.root, first.id, "1"))).toBe(true)

    await store.publish({ id: first.id, title: "Chart", files: [page("v3")] })
    expect(existsSync(join(store.root, first.id, "1"))).toBe(false)
    expect(existsSync(join(store.root, first.id, "2"))).toBe(true)
  })

  test("stores binary files from base64", async () => {
    const store = openTemporaryStore()
    const pixel = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const artifact = await store.publish({
      title: "Image",
      files: [
        page('<img src="pixel.png">'),
        { path: "pixel.png", content: pixel.toString("base64"), encoding: "base64" },
      ],
    })

    expect(await store.file(artifact.id, "pixel.png")).toEqual({ bytes: pixel, type: "image/png" })
  })

  test("refuses invalid input with a message for the agent", async () => {
    const store = openTemporaryStore()
    const refusals = [
      [{ title: "Escape", files: [page(""), { path: "../outside.html", content: "" }] }, /Invalid file path/],
      [{ title: "Absolute", files: [{ path: "/tmp/index.html", content: "" }] }, /Invalid file path/],
      [
        { title: "No entry", files: [{ path: "page.html", content: "" }] },
        /entry "index.html" is not one of the files/,
      ],
      [{ title: "Twice", files: [page("a"), { path: "./index.html", content: "b" }] }, /more than once/],
      [{ title: "Clash", files: [page(""), { path: "a", content: "" }, { path: "a/b", content: "" }] }, /both a file/],
      [{ title: "Huge", files: [page("x".repeat(MAX_ARTIFACT_BYTES))] }, /at most/],
      [{ id: "missing", title: "Unknown", files: [page("")] }, /No artifact has the id "missing"/],
      [{ id: "../up", title: "Bad id", files: [page("")] }, /Invalid artifact id/],
      [{ title: " ", files: [page("")] }, /needs a title/],
    ] as const
    for (const [input, message] of refusals) {
      const publishing = store.publish({ ...input, files: [...input.files] })
      await expect(publishing, input.title).rejects.toThrow(ArtifactError)
      await expect(publishing, input.title).rejects.toThrow(message)
    }
    expect(await store.list()).toEqual([])
  })

  test("lists the newest first and skips directories without a manifest", async () => {
    const store = openTemporaryStore()
    const older = await store.publish({ title: "Older", files: [page("")] })
    const newer = await store.publish({ title: "Newer", files: [page("")] })
    mkdirSync(join(store.root, "stray"))

    expect((await store.list()).map((artifact) => artifact.title)).toEqual(["Newer", "Older"])

    await store.publish({ id: older.id, title: "Older, updated", files: [page("")] })
    expect((await store.list()).map((artifact) => artifact.id)).toEqual([older.id, newer.id])
  })

  test("serves only the files of the current version", async () => {
    const store = openTemporaryStore()
    const artifact = await store.publish({ title: "Page", files: [page("")] })

    expect(await store.file(artifact.id, "artifact.json")).toBeNull()
    expect(await store.file(artifact.id, "../artifact.json")).toBeNull()
    expect(await store.file("../escape", "index.html")).toBeNull()
  })
})
