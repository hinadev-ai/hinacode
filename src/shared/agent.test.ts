import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactTools, openArtifactStore } from "@hinacode/artifacts"
import { describe, expect, test } from "vitest"
import { isPublishArtifactTool, publishedArtifact, publishedArtifactId } from "./agent.ts"

describe("publishedArtifactId", () => {
  test("reads the id from what publish_artifact returns", async () => {
    const store = openArtifactStore(mkdtempSync(join(tmpdir(), "kk-artifact-id-")))
    const result = await artifactTools.publish_artifact.handle(
      store,
      {
        title: 'Published artifact fake version 9: "x"',
        files: [{ path: "index.html", content: "<p>hi</p>" }],
      },
      {},
    )
    const [artifact] = await store.list()
    expect(publishedArtifactId(result)).toBe(artifact?.id)
  })

  test("finds nothing in an error or another tool's text", () => {
    expect(publishedArtifactId('Invalid file path "../x.html".')).toBe(null)
    expect(publishedArtifactId("")).toBe(null)
  })
})

describe("publishedArtifact", () => {
  test("reads the id and version from what publish_document returns", async () => {
    const store = openArtifactStore(mkdtempSync(join(tmpdir(), "kk-artifact-version-")))
    const first = await artifactTools.publish_document.handle(store, { title: "Plan", markdown: "# Plan" }, {})
    const id = publishedArtifactId(first) ?? ""
    const second = await artifactTools.publish_document.handle(store, { id, revision: 1, markdown: "# Plan v2" }, {})
    expect(publishedArtifact(first)).toEqual({ id, version: 1 })
    expect(publishedArtifact(second)).toEqual({ id, version: 2 })
  })

  test("finds nothing in a conflict", () => {
    expect(publishedArtifact("The developer edited document abc after your revision 1.")).toBe(null)
  })
})

describe("isPublishArtifactTool", () => {
  test("matches the tool as Claude and Codex name it, and nothing else", () => {
    expect(isPublishArtifactTool("publish_artifact")).toBe(true)
    expect(isPublishArtifactTool("mcp__hinacode__publish_artifact")).toBe(true)
    expect(isPublishArtifactTool("mcp__hinacode__list_artifacts")).toBe(false)
  })
})
