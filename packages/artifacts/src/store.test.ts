import { fork } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, onTestFinished, test } from "vitest"
import { ArtifactSchema, normalizeArtifactPath } from "./artifact.ts"
import { ArtifactConflictError, ArtifactError, MAX_ARTIFACT_BYTES, openArtifactStore } from "./store.ts"

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

const storeProcess = async (mode: "publish" | "hold", root: string, id: string) => {
  const child = fork(new URL("./store.test.process.ts", import.meta.url), [mode, root, id], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  const closed = once(child, "exit")
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed
  })
  const [ready] = await once(child, "message")
  expect(ready).toBe("ready")
  return { child, closed }
}

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
      kind: "page",
      title: "Report",
      entry: "index.html",
      version: 1,
      revision: 1,
      author: "agent",
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

  test("gives concurrent updates of one artifact their own versions", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ title: "Chart", files: [page("v1")] })
    const updates = await Promise.all(
      ["a", "b"].map((body) => store.publish({ id: first.id, title: "Chart", files: [page(body)] })),
    )

    expect(updates.map((update) => update.version).toSorted()).toEqual([2, 3])
    const current = await store.get(first.id)
    const entry = await store.file(first.id, "index.html")
    const published = updates.find((update) => update.version === current?.version)
    expect(new TextDecoder().decode(entry?.bytes)).toBe(`<!doctype html>${published === updates[0] ? "a" : "b"}`)
  })

  test("publishes independent processes without deleting active writes or rolling the manifest back", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ title: "Chart", files: [page("v1")] })
    const publishers = await Promise.all(
      Array.from({ length: 11 }, () => storeProcess("publish", store.root, first.id)),
    )
    const publishing = Promise.allSettled(
      publishers.map(({ child }, index) => {
        const published = once(child, "message").then(([message]) => ArtifactSchema.parse(message))
        const files = [page(`v${index}`)]
        if (index === 0)
          files.push(...Array.from({ length: 1000 }, (_, file) => ({ path: `assets/${file}.txt`, content: "slow" })))
        child.send({ id: first.id, title: `Chart ${index}`, files })
        return published
      }),
    )
    let finished = false
    void publishing.then(() => {
      finished = true
    })
    const readWhilePublishing = async () => {
      for (;;) {
        expect(await store.file(first.id, "index.html")).not.toBeNull()
        if (finished) return
      }
    }
    const [outcomes] = await Promise.all([publishing, readWhilePublishing()])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(publishers.map(() => "fulfilled"))
    const updates = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []))
    const current = await store.get(first.id)
    expect(current?.version).toBe(Math.max(...updates.map((update) => update.version)))
    expect(new Set(updates.map((update) => update.version)).size).toBe(publishers.length)
    for (const file of current?.files ?? []) {
      const found = await store.file(first.id, file.path)
      expect(found?.bytes.byteLength, file.path).toBe(file.size)
    }
  }, 30_000)

  test("recovers an abandoned process lock and keeps the previous committed version after a partial write", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ title: "Chart", files: [page("v1")] })
    const partial = join(store.root, first.id, "2")
    mkdirSync(partial)
    writeFileSync(join(partial, "index.html"), "incomplete")
    const { child, closed } = await storeProcess("hold", store.root, first.id)
    expect(new TextDecoder().decode((await store.file(first.id, "index.html"))?.bytes)).toBe("<!doctype html>v1")
    child.kill("SIGKILL")
    await closed
    const stale = new Date("2000-01-01T00:00:00.000Z")
    utimesSync(join(store.root, `${first.id}.lock`), stale, stale)

    const current = await store.publish({ id: first.id, title: "Chart", files: [page("v3")] })
    expect(current.version).toBe(3)
    expect((await store.get(first.id))?.version).toBe(3)
    expect(new TextDecoder().decode((await store.file(first.id, "index.html"))?.bytes)).toBe("<!doctype html>v3")
    expect(
      readdirSync(join(store.root, first.id))
        .filter((name) => /^\d+$/.test(name))
        .toSorted(),
    ).toEqual(["1", "3"])
    expect(existsSync(join(store.root, `${first.id}.lock`))).toBe(false)
  })

  test("deleting an artifact waits for its active publisher and leaves no resurrected manifest", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ title: "Chart", files: [page("v1")] })
    const { child } = await storeProcess("publish", store.root, first.id)
    const writing = new Promise<void>((resolve, reject) => {
      const watcher = watch(join(store.root, first.id), (_event, name) => {
        if (name !== "2") return
        watcher.close()
        resolve()
      })
      watcher.once("error", reject)
      onTestFinished(() => watcher.close())
    })
    const published = once(child, "message").then(([message]) => ArtifactSchema.parse(message))
    child.send({
      id: first.id,
      title: "Chart",
      files: [
        page("v2"),
        ...Array.from({ length: 1000 }, (_, file) => ({ path: `assets/${file}.txt`, content: "slow" })),
      ],
    })
    await writing
    const [updated, removed] = await Promise.all([published, store.remove(first.id)])
    expect(updated.version).toBe(2)
    expect(removed).toBe(true)
    expect(await store.get(first.id)).toBeNull()
    expect(existsSync(join(store.root, first.id))).toBe(false)
    expect(existsSync(join(store.root, `${first.id}.lock`))).toBe(false)
  })

  test("a failed file write keeps the committed version and releases the lock for a later publish", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ title: "Chart", files: [page("v1")] })
    await expect(
      store.publish({
        id: first.id,
        title: "Chart",
        files: [page("v2"), { path: "x".repeat(300), content: "invalid file name" }],
      }),
    ).rejects.toThrow()
    expect(await store.get(first.id)).toEqual(first)
    expect(new TextDecoder().decode((await store.file(first.id, "index.html"))?.bytes)).toBe("<!doctype html>v1")
    expect(existsSync(join(store.root, `${first.id}.lock`))).toBe(false)

    const recovered = await store.publish({ id: first.id, title: "Chart", files: [page("v3")] })
    expect(recovered.version).toBe(3)
    expect(
      readdirSync(join(store.root, first.id))
        .filter((name) => /^\d+$/.test(name))
        .toSorted(),
    ).toEqual(["1", "3"])
  })

  test("surfaces a permanent lock filesystem error without retrying forever", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ title: "Chart", files: [page("v1")] })
    const lockPath = join(store.root, `${first.id}.lock`)
    writeFileSync(lockPath, "not a lock directory")
    const stale = new Date("2000-01-01T00:00:00.000Z")
    utimesSync(lockPath, stale, stale)

    await expect(store.publish({ id: first.id, title: "Chart", files: [page("v2")] })).rejects.toThrow()
    expect(await store.get(first.id)).toEqual(first)
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

    expect(await store.file(artifact.id, "pixel.png")).toEqual({
      bytes: pixel,
      type: "image/png",
      version: 1,
      revision: 1,
      kind: "page",
    })
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

  test("publishes a document as one Markdown file", async () => {
    const store = openTemporaryStore()
    const document = await store.publish({ kind: "document", title: "Plan", markdown: "# Plan\n\n- [ ] Ship\n" })

    expect(document).toMatchObject({
      kind: "document",
      title: "Plan",
      entry: "document.md",
      version: 1,
      files: [{ path: "document.md", type: "text/markdown; charset=utf-8", size: 19 }],
    })
    const file = await store.file(document.id, "document.md")
    expect(new TextDecoder().decode(file?.bytes)).toBe("# Plan\n\n- [ ] Ship\n")
  })

  test("reads manifests written before kinds and revisions existed as an agent's page", async () => {
    const store = openTemporaryStore()
    const artifact = await store.publish({ title: "Old", files: [page("old")] })
    const { kind: _kind, revision: _revision, author: _author, ...legacy } = artifact
    writeFileSync(join(store.root, artifact.id, "artifact.json"), JSON.stringify(legacy))

    expect(await store.get(artifact.id)).toEqual({ ...artifact, revision: 0 })
  })

  test("keeps an artifact's kind across updates", async () => {
    const store = openTemporaryStore()
    const page_ = await store.publish({ title: "Page", files: [page("p")] })
    const document = await store.publish({ kind: "document", title: "Doc", markdown: "" })

    await expect(store.publish({ kind: "document", id: page_.id, title: "Page", markdown: "x" })).rejects.toThrow(
      /is a page/,
    )
    await expect(store.publish({ id: document.id, title: "Doc", files: [page("p")] })).rejects.toThrow(/is a document/)
  })

  test("keeps the developer's consecutive saves in one version and starts a new one when the author changes", async () => {
    const store = openTemporaryStore()
    const edit = (id: string, baseRevision: number, markdown: string) =>
      store.publish({ kind: "document", id, title: "Notes", markdown, baseRevision, author: "developer" })
    const read = async (id: string) => new TextDecoder().decode((await store.file(id, "document.md"))?.bytes)

    const agent = await store.publish({ kind: "document", title: "Notes", markdown: "agent" })
    const first = await edit(agent.id, 1, "one")
    const second = await edit(agent.id, 2, "two")
    const third = await edit(agent.id, 3, "three")

    expect([first, second, third].map(({ version, revision, author }) => ({ version, revision, author }))).toEqual([
      { version: 2, revision: 2, author: "developer" },
      { version: 2, revision: 3, author: "developer" },
      { version: 2, revision: 4, author: "developer" },
    ])
    expect(await read(agent.id)).toBe("three")
    expect(
      readdirSync(join(store.root, agent.id))
        .filter((name) => /^\d+$/.test(name))
        .toSorted(),
    ).toEqual(["1", "2"])

    const again = await store.publish({ kind: "document", id: agent.id, title: "Notes", markdown: "agent two" })
    expect(again).toMatchObject({ version: 3, revision: 5, author: "agent" })
    expect(await edit(agent.id, 5, "mine")).toMatchObject({ version: 4, revision: 6, author: "developer" })
  })

  test("refuses an update based on a revision that is no longer current", async () => {
    const store = openTemporaryStore()
    const first = await store.publish({ kind: "document", title: "Notes", markdown: "one" })
    const second = await store.publish({
      kind: "document",
      id: first.id,
      title: "Notes",
      markdown: "two",
      baseRevision: 1,
      author: "developer",
    })

    const stale = store.publish({ kind: "document", id: first.id, title: "Notes", markdown: "three", baseRevision: 1 })
    await expect(stale).rejects.toBeInstanceOf(ArtifactConflictError)
    await expect(stale).rejects.toMatchObject({ current: { revision: second.revision } })
    expect((await store.get(first.id))?.revision).toBe(2)
  })

  test("renames an artifact without a new revision, and later updates keep the name", async () => {
    const store = openTemporaryStore()
    const published = await store.publish({ kind: "document", title: "Notes", markdown: "one" })

    const renamed = await store.rename(published.id, "  Launch notes ")
    expect(renamed).toMatchObject({ title: "Launch notes", version: 1, revision: 1 })
    expect(renamed.updatedAt > published.updatedAt).toBe(true)

    const updated = await store.publish({ kind: "document", id: published.id, markdown: "two", baseRevision: 1 })
    expect(updated).toMatchObject({ title: "Launch notes", revision: 2 })
    await expect(store.rename(published.id, " ")).rejects.toThrow(/needs a title/)
    await expect(store.rename("gone", "Name")).rejects.toThrow(/No artifact has the id "gone"/)
    await expect(store.publish({ kind: "document", markdown: "new" })).rejects.toThrow(/needs a title/)
  })

  test("removes an artifact and refuses ids it does not hold", async () => {
    const store = openTemporaryStore()
    const kept = await store.publish({ title: "Kept", files: [page("")] })
    const removed = await store.publish({ title: "Removed", files: [page("")] })
    mkdirSync(join(store.root, "stray"))

    expect(await store.remove(removed.id)).toBe(true)
    expect(existsSync(join(store.root, removed.id))).toBe(false)
    expect((await store.list()).map((artifact) => artifact.id)).toEqual([kept.id])

    for (const id of [removed.id, "stray", "..", "../escape"]) expect(await store.remove(id), id).toBe(false)
    expect(existsSync(join(store.root, "stray"))).toBe(true)
  })
})

describe("addDocumentImage", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

  test("stores an image with its document and serves it", async () => {
    const store = openTemporaryStore()
    const document = await store.publish({ kind: "document", title: "Notes", markdown: "" })

    const path = await store.addDocumentImage(document.id, { bytes: png, type: "image/png" })

    expect(path).toMatch(/^images\/[0-9a-f]{64}\.png$/)
    expect(await store.file(document.id, path)).toEqual({
      bytes: Buffer.from(png),
      type: "image/png",
      version: 1,
      revision: 1,
      kind: "document",
    })
    expect(await store.get(document.id)).toEqual(document)
    expect(await store.file(document.id, "images/missing.png")).toBeNull()
  })

  test("keeps the image when the developer or an agent publishes the document again", async () => {
    const store = openTemporaryStore()
    const document = await store.publish({ kind: "document", title: "Notes", markdown: "" })
    const path = await store.addDocumentImage(document.id, { bytes: png, type: "image/png" })
    const publish = (author: "agent" | "developer", markdown: string) =>
      store.publish({ kind: "document", id: document.id, markdown, author })

    await publish("developer", `![](${path})`)
    await publish("agent", "one")
    await publish("agent", "two")
    await publish("developer", "three")

    expect((await store.file(document.id, path))?.bytes).toEqual(Buffer.from(png))
  })

  test("stores the same bytes once under the same path", async () => {
    const store = openTemporaryStore()
    const document = await store.publish({ kind: "document", title: "Notes", markdown: "" })

    const first = await store.addDocumentImage(document.id, { bytes: png, type: "image/png" })
    const second = await store.addDocumentImage(document.id, { bytes: png, type: "image/png" })

    expect(second).toBe(first)
    expect(readdirSync(join(store.root, document.id, "images"))).toEqual([first.slice("images/".length)])
  })

  test("refuses what is not an image, an empty image, a page and an unknown id", async () => {
    const store = openTemporaryStore()
    const document = await store.publish({ kind: "document", title: "Notes", markdown: "" })
    const page_ = await store.publish({ title: "Page", files: [page("")] })

    await expect(store.addDocumentImage(document.id, { bytes: png, type: "image/svg+xml" })).rejects.toThrow(
      /PNG, JPEG, GIF or WebP/,
    )
    await expect(store.addDocumentImage(document.id, { bytes: new Uint8Array(), type: "image/png" })).rejects.toThrow(
      /empty/,
    )
    await expect(
      store.addDocumentImage(document.id, { bytes: new Uint8Array(MAX_ARTIFACT_BYTES + 1), type: "image/png" }),
    ).rejects.toThrow(/at most/)
    await expect(store.addDocumentImage(page_.id, { bytes: png, type: "image/png" })).rejects.toThrow(/is a page/)
    await expect(store.addDocumentImage("gone", { bytes: png, type: "image/png" })).rejects.toThrow(
      /No artifact has the id "gone"/,
    )
    await expect(store.addDocumentImage("../escape", { bytes: png, type: "image/png" })).rejects.toBeInstanceOf(
      ArtifactError,
    )
  })

  test("serves only files directly inside images", async () => {
    const store = openTemporaryStore()
    const document = await store.publish({ kind: "document", title: "Notes", markdown: "secret" })
    const page_ = await store.publish({ title: "Page", files: [page("")] })
    mkdirSync(join(store.root, page_.id, "images"))
    writeFileSync(join(store.root, page_.id, "images", "a.png"), png)
    mkdirSync(join(store.root, document.id, "images", "nested"), { recursive: true })
    writeFileSync(join(store.root, document.id, "images", "nested", "a.png"), png)

    for (const path of ["images/../1/document.md", "images/../artifact.json", "images/nested/a.png", "images"]) {
      expect(await store.file(document.id, path), path).toBeNull()
    }
    expect(await store.file(page_.id, "images/a.png")).toBeNull()
  })
})
