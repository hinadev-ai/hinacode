import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, onTestFinished, test } from "vitest"
import { handleArtifactRequest } from "./http.ts"
import { openArtifactStore } from "./store.ts"

const publishedStore = async () => {
  const root = mkdtempSync(join(tmpdir(), "hinacode-artifacts-"))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const store = openArtifactStore(root)
  const artifact = await store.publish({
    title: "Page",
    files: [
      { path: "index.html", content: '<script src="assets/app.js"></script>' },
      { path: "assets/app.js", content: "document.title = 'ok'" },
    ],
  })
  const get = (path: string) => handleArtifactRequest(store, new Request(`http://localhost${path}`))
  return { id: artifact.id, get }
}

describe("handleArtifactRequest", () => {
  test("serves the entry for an empty path with the sandbox headers", async () => {
    const { id, get } = await publishedStore()
    const response = await get(`/${id}/`)

    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "sandbox allow-scripts",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    expect(await response.text()).toBe('<script src="assets/app.js"></script>')
  })

  test("serves nested files with their type", async () => {
    const { id, get } = await publishedStore()
    const response = await get(`/${id}/assets/app.js`)

    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(await response.text()).toBe("document.title = 'ok'")
  })

  test("answers 404 for unknown artifacts, files and escapes", async () => {
    const { id, get } = await publishedStore()
    for (const path of [
      "/nope/",
      `/${id}/missing.html`,
      `/${id}/assets%2F..%2F..%2Fartifact.json`,
      `/${id}/%E0%A4%A`,
    ]) {
      expect((await get(path)).status, path).toBe(404)
    }
  })
})
