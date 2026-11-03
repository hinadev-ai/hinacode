import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, onTestFinished, test } from "vitest"
import { openArtifactStore } from "./store.ts"
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
