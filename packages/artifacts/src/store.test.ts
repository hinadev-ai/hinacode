import { fork } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, onTestFinished, test } from "vitest"
import { ArtifactSchema, normalizeArtifactPath } from "./artifact.ts"
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
