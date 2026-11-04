import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, onTestFinished, test } from "vitest"
import { MAX_ARTIFACT_BYTES, openArtifactStore } from "./store.ts"
import { artifactTools } from "./tools.ts"

const openTemporaryStore = () => {
  const root = mkdtempSync(join(tmpdir(), "hinacode-artifacts-"))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  return openArtifactStore(root)
}

test("publishes, lists and reads back an artifact through the tool handlers", async () => {
  const store = openTemporaryStore()
  const { publish_artifact, list_artifacts, read_artifact } = artifactTools

  const published = await publish_artifact.handle(
    store,
    publish_artifact.input.parse({
      title: "Notes",
      files: [
        { path: "index.html", content: "<p>notes</p>" },
        { path: "dot.png", content: "iVBORw==", encoding: "base64" },
      ],
    }),
    {},
  )
  const id = published.match(/^Published artifact ([a-z0-9]+) version 1:/)?.[1] ?? ""

  expect(JSON.parse(await list_artifacts.handle(store, {}, {}))).toEqual([
    { id, title: "Notes", version: 1, updatedAt: expect.any(String) },
  ])
  expect(JSON.parse(await read_artifact.handle(store, { id }, {}))).toMatchObject({ id, entry: "index.html" })
  expect(await read_artifact.handle(store, { id, path: "index.html" }, {})).toBe("<p>notes</p>")
  await expect(read_artifact.handle(store, { id, path: "dot.png" }, {})).rejects.toThrow(/binary \(image\/png\)/)
  await expect(read_artifact.handle(store, { id: "gone" }, {})).rejects.toThrow(/No artifact has the id "gone"/)
})

test("lists nothing in an empty store", async () => {
  expect(await artifactTools.list_artifacts.handle(openTemporaryStore(), {}, {})).toBe("No artifacts yet.")
})

test("publishes a document and refuses an update that would drop the developer's edits", async () => {
  const store = openTemporaryStore()
  const { publish_document, list_artifacts, read_artifact } = artifactTools

  const published = await publish_document.handle(
    store,
    publish_document.input.parse({ title: "Release plan", markdown: "# Release plan\n" }),
    { threadId: "thread-1" },
  )
  const id = published.match(/^Published document ([a-z0-9]+) version 1:/)?.[1] ?? ""
  expect(published).toContain(`id "${id}" and revision 1`)
  expect(JSON.parse(await list_artifacts.handle(store, {}, { threadId: "thread-1" }))).toEqual([
    { id, kind: "document", title: "Release plan", version: 1, updatedAt: expect.any(String) },
  ])

  const developer = { kind: "document" as const, id, title: "Release plan", author: "developer" as const }
  await store.publish({ ...developer, markdown: "# Release plan\n\nDraft.\n", baseRevision: 1 })
  await store.publish({ ...developer, markdown: "# Release plan\n\nEdited.\n", baseRevision: 2 })
  await expect(
    publish_document.handle(
      store,
      publish_document.input.parse({ id, revision: 1, title: "Release plan", markdown: "# Release plan\n\nMine.\n" }),
      { threadId: "thread-1" },
    ),
  ).rejects.toThrow(/edited document \w+ after your revision 1\. It is now at revision 3[\s\S]*Edited\./)
  expect(await read_artifact.handle(store, { id, path: "document.md" }, {})).toBe("# Release plan\n\nEdited.\n")
  expect(publish_document.input.safeParse({ id, title: "Release plan", markdown: "" }).success).toBe(false)
})

test("keeps a document's name, which the developer may have changed, when the agent updates without a title", async () => {
  const store = openTemporaryStore()
  const { publish_document } = artifactTools
  const published = await store.publish({ kind: "document", title: "Notes", markdown: "one" })
  await store.rename(published.id, "Launch notes")

  const reply = await publish_document.handle(
    store,
    publish_document.input.parse({ id: published.id, revision: 1, markdown: "two" }),
    {},
  )

  expect(reply).toContain('"Launch notes"')
  expect(publish_document.input.safeParse({ markdown: "new" }).success).toBe(false)
})

const temporaryFile = (name: string, content: string | Uint8Array) => {
  const directory = mkdtempSync(join(tmpdir(), "hinacode-artifact-source-"))
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, name)
  writeFileSync(path, content)
  return path
}

test("publishes a page's text and binary files from paths on disk", async () => {
  const store = openTemporaryStore()
  const { publish_artifact } = artifactTools
  const pixel = new Uint8Array([0x89, 0x50, 0x00, 0xff])

  const published = await publish_artifact.handle(
    store,
    publish_artifact.input.parse({
      title: "Report",
      files: [
        { path: "index.html", sourcePath: temporaryFile("report.html", "<h1>日本語</h1>") },
        { path: "dot.png", sourcePath: temporaryFile("dot.png", pixel) },
        { path: "inline.txt", content: "inline" },
      ],
    }),
    {},
  )
  const id = published.match(/^Published artifact ([a-z0-9]+) version 1:/)?.[1] ?? ""

  const read = async (path: string) => (await store.file(id, path))?.bytes ?? new Uint8Array()
  expect(new TextDecoder().decode(await read("index.html"))).toBe("<h1>日本語</h1>")
  expect(new Uint8Array(await read("dot.png"))).toEqual(pixel)
  expect(new TextDecoder().decode(await read("inline.txt"))).toBe("inline")
})

test("publishes a document from a path on disk and still refuses a stale revision", async () => {
  const store = openTemporaryStore()
  const { publish_document, read_artifact } = artifactTools
  const sourcePath = temporaryFile("plan.md", "# Plan\n")

  const published = await publish_document.handle(
    store,
    publish_document.input.parse({ title: "Plan", sourcePath }),
    {},
  )
  const id = published.match(/^Published document ([a-z0-9]+) version 1:/)?.[1] ?? ""
  expect(await read_artifact.handle(store, { id, path: "document.md" }, {})).toBe("# Plan\n")

  await store.publish({ kind: "document", id, author: "developer", markdown: "# Edited\n", baseRevision: 1 })
  await expect(
    publish_document.handle(store, publish_document.input.parse({ id, revision: 1, sourcePath }), {}),
  ).rejects.toThrow(/after your revision 1[\s\S]*# Edited/)
})

test("takes exactly one of the inline content and its sourcePath", () => {
  const { publish_artifact, publish_document } = artifactTools
  const page = (file: object) =>
    publish_artifact.input.safeParse({ title: "Page", files: [{ path: "a.html", ...file }] })
  const document = (input: object) => publish_document.input.safeParse({ title: "Doc", ...input })

  expect(page({}).error?.issues[0]?.message).toBe("Pass either content or sourcePath.")
  expect(page({ content: "", sourcePath: "/a" }).success).toBe(false)
  expect(document({}).error?.issues[0]?.message).toBe("Pass either markdown or sourcePath.")
  expect(document({ markdown: "", sourcePath: "/a" }).success).toBe(false)
})

test("explains a sourcePath it cannot read and writes nothing", async () => {
  const store = openTemporaryStore()
  const { publish_document } = artifactTools
  const publish = (sourcePath: string) =>
    publish_document.handle(store, publish_document.input.parse({ title: "Doc", sourcePath }), {})
  const oversized = temporaryFile("big.md", new Uint8Array(MAX_ARTIFACT_BYTES + 1))

  await expect(publish("plan.md")).rejects.toThrow('sourcePath must be absolute, but got "plan.md".')
  await expect(publish("/no/such/file.md")).rejects.toThrow(/Cannot read sourcePath "\/no\/such\/file\.md": .*ENOENT/)
  await expect(publish(tmpdir())).rejects.toThrow(/is not a file/)
  await expect(publish(oversized)).rejects.toThrow(/A version holds at most/)
  expect(await store.list()).toEqual([])
})
