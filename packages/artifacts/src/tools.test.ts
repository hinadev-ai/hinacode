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
  )
  const id = published.match(/artifact ([a-z0-9]+), version 1/)?.[1] ?? ""

  expect(JSON.parse(await list_artifacts.handle(store, {}))).toEqual([
    { id, title: "Notes", version: 1, updatedAt: expect.any(String) },
  ])
  expect(JSON.parse(await read_artifact.handle(store, { id }))).toMatchObject({ id, entry: "index.html" })
  expect(await read_artifact.handle(store, { id, path: "index.html" })).toBe("<p>notes</p>")
  await expect(read_artifact.handle(store, { id, path: "dot.png" })).rejects.toThrow(/binary \(image\/png\)/)
  await expect(read_artifact.handle(store, { id: "gone" })).rejects.toThrow(/No artifact has the id "gone"/)
})

test("lists nothing in an empty store", async () => {
  expect(await artifactTools.list_artifacts.handle(openTemporaryStore(), {})).toBe("No artifacts yet.")
})
