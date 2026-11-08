import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, onTestFinished, test } from "vitest"
import { MAX_ARTIFACT_BYTES, openArtifactStore } from "./store.ts"
import { artifactTools } from "./tools.ts"
import { describeScene } from "./whiteboard.ts"

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

const idIn = (result: string) => /^Published \w+ ([a-z0-9]+) version \d+:/.exec(result)?.[1] ?? ""

test("comments on a document's quote as the calling thread, replies and resolves", async () => {
  const store = openTemporaryStore()
  const { comment_on_artifact, read_artifact } = artifactTools
  const document = await store.publish({ kind: "document", title: "Plan", markdown: "The migration runs first." })
  const comment = (input: object) =>
    comment_on_artifact.handle(store, comment_on_artifact.input.parse({ id: document.id, ...input }), {
      threadId: "thread-1",
    })

  const started = await comment({ quote: "migration runs", body: "Before or after the deploy?" })
  const commentId = /^Started comment (c_[a-z0-9]+) on artifact /.exec(started)?.[1] ?? ""
  expect(started).toBe(
    `Started comment ${commentId} on artifact ${document.id}. The developer's answer arrives as a message.`,
  )
  expect((await store.feedback(document.id))?.comments[0]).toMatchObject({
    anchor: { kind: "text", quote: "migration runs", prefix: "", suffix: "" },
    messages: [{ author: { kind: "agent", threadId: "thread-1" }, body: "Before or after the deploy?" }],
  })
  await store.comment(document.id, {
    comment: commentId,
    author: { kind: "developer" },
    body: "After.\nIt needs the table.",
  })

  expect(await read_artifact.handle(store, { id: document.id }, {})).toContain(
    [
      "Open comments:",
      `- ${commentId} on the quote "migration runs", waiting on you`,
      "  agent (thread thread-1): Before or after the deploy?",
      "  developer: After.",
      "    It needs the table.",
    ].join("\n"),
  )
  expect(await comment({ comment: commentId, body: "Moved it.", resolve: true })).toBe(
    `Replied on comment ${commentId} of artifact ${document.id}. It is resolved.`,
  )
  expect(await read_artifact.handle(store, { id: document.id }, {})).not.toContain("Open comments")
  await expect(comment({ comment: "c_gone", body: "Hi" })).rejects.toThrow(/has no comment "c_gone"/)
})

test("takes one anchor for a new comment and none for a reply", () => {
  const { comment_on_artifact } = artifactTools
  const issue = (input: object) => comment_on_artifact.input.safeParse({ id: "a", ...input }).error?.issues[0]?.message

  expect(issue({ body: "Hi" })).toBeUndefined()
  expect(issue({ comment: "c_1", resolve: true })).toBeUndefined()
  expect(issue({ quote: "x", elements: ["a"], body: "Hi" })).toBe("Pass quote or elements, not both.")
  expect(issue({ comment: "c_1", quote: "x", body: "Hi" })).toMatch(/keeps its comment's anchor/)
  expect(issue({ body: " " })).toBe("Pass a body, or comment and resolve to only resolve it.")
  expect(issue({ resolve: true })).toBe("Pass a body, or comment and resolve to only resolve it.")
})

test("publishes a whiteboard, merges what the agent sends and summarizes the scene", async () => {
  const store = openTemporaryStore()
  const { publish_whiteboard, read_artifact, list_artifacts } = artifactTools
  const publish = (input: object) =>
    publish_whiteboard.handle(store, publish_whiteboard.input.parse(input), { threadId: "thread-1" })

  const first = await publish({
    title: "Checkout",
    elements: [
      { id: "api", type: "rectangle", x: 0, y: 0, width: 180.4, height: 80, label: { text: "API" } },
      { id: "db", type: "ellipse", x: 300, y: 0, width: 120, height: 80, label: { text: "Postgres" } },
    ],
  })
  const id = idIn(first)
  expect(first).toBe(
    `Published whiteboard ${id} version 1: "Checkout". Pass id "${id}" to publish_whiteboard to add, change or remove elements.`,
  )
  await publish({
    id,
    elements: [
      { id: "api-db", type: "arrow", x: 180, y: 40, start: { id: "api" }, end: { id: "db" }, label: { text: "reads" } },
    ],
  })
  await publish({ id, elements: [], remove: ["db"] })

  expect(await read_artifact.handle(store, { id }, {})).toMatch(
    /"kind": "whiteboard"[\s\S]*\n\nElements:\napi rectangle "API" at 0,0 180x80\napi-db arrow: api -> db "reads"$/,
  )
  expect(JSON.parse(await list_artifacts.handle(store, {}, { threadId: "thread-1" }))).toEqual([
    { id, kind: "whiteboard", title: "Checkout", version: 3, updatedAt: expect.any(String) },
  ])
  expect(publish_whiteboard.input.safeParse({ title: "Board", elements: [{ type: "text" }] }).success).toBe(false)
  expect(publish_whiteboard.input.safeParse({ elements: [] }).success).toBe(false)
})

test("summarizes a scene the developer saved with bound text and arrow bindings", () => {
  expect(
    describeScene([
      { id: "box", type: "rectangle", x: 10.6, y: 20, width: 100, height: 50 },
      { id: "box-text", type: "text", text: "Queue", containerId: "box" },
      { id: "gone", type: "rectangle", isDeleted: true },
      { id: "line", type: "arrow", x: 0, y: 0, startBinding: { elementId: "box" }, endBinding: null },
      { id: "free", type: "freedraw" },
    ]),
  ).toBe(['box rectangle "Queue" at 11,20 100x50', "line arrow: box -> ?", "free freedraw"].join("\n"))
  expect(describeScene([])).toBe("The whiteboard is empty.")
})

test("requests verification with copies of the captures and reports the verdict", async () => {
  const store = openTemporaryStore()
  const { request_verification, read_artifact } = artifactTools
  const mockup = await store.publish({ title: "Mockup", files: [{ path: "index.html", content: "<p>mock</p>" }] })
  const shot = temporaryFile("Shot.PNG", new Uint8Array([0x89, 0x50]))
  const recording = temporaryFile("run.webm", new Uint8Array([0x1a, 0x45]))

  const published = await request_verification.handle(
    store,
    request_verification.input.parse({
      title: "Settings page",
      notes: "Check the header.",
      expected: [{ label: "Approved", artifactId: mockup.id }, { sourcePath: shot }],
      actual: [{ label: "Built", sourcePath: shot }, { sourcePath: recording }],
    }),
    { threadId: "thread-1" },
  )
  const id = idIn(published)
  expect(published).toBe(
    `Published verification ${id} version 1: "Settings page". The developer will pass or reject it, and the verdict arrives as a message. After a fix, pass id "${id}" to request_verification.`,
  )
  expect(JSON.parse(await read_artifact.handle(store, { id, path: "verify.json" }, {}))).toEqual({
    notes: "Check the header.",
    expected: [{ label: "Approved", artifactId: mockup.id }, { path: "expected/2.png" }],
    actual: [{ label: "Built", path: "actual/1.png" }, { path: "actual/2.webm" }],
  })
  expect(new Uint8Array((await store.file(id, "actual/2.webm"))?.bytes ?? [])).toEqual(new Uint8Array([0x1a, 0x45]))
  expect(await read_artifact.handle(store, { id }, {})).toMatch(/\n\nVerdict on version 1: pending$/)
  await store.decide(id, { version: 1, decision: "reject", reason: "The header wraps." })
  expect(await read_artifact.handle(store, { id }, {})).toMatch(
    /\n\nVerdict on version 1: rejected\. The header wraps\.$/,
  )

  const parse = (input: object) =>
    request_verification.input.safeParse({ title: "Check", actual: [{ sourcePath: shot }], ...input })
  expect(parse({ expected: [{ artifactId: "a", sourcePath: shot }] }).success).toBe(false)
  expect(parse({ expected: [{ label: "Nothing" }] }).success).toBe(false)
  expect(parse({ expected: [], actual: [] }).success).toBe(false)
  await expect(
    request_verification.handle(store, parse({ expected: [{ artifactId: "gone" }] }).data!, {}),
  ).rejects.toThrow(/No artifact has the id "gone"/)
})
