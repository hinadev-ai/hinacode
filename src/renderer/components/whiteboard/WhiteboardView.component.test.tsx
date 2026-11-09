import { Schema } from "effect"
import { StrictMode } from "react"
import { beforeEach, expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { Artifact, ArtifactFeedback, WhiteboardContent, WhiteboardElement } from "../../../shared/artifact.ts"
import { type HinacodeBridge, type PushEvent, RpcMethods } from "../../../shared/contract.ts"
import { defaultClientSettings, type Thread } from "../../../shared/domain.ts"
import "../../index.css"
import { useArtifacts } from "../../stores/artifacts.ts"
import { ArtifactsView } from "../sidePanel/ArtifactsView.tsx"

const AGENT_SCENE: ReadonlyArray<WhiteboardElement> = [
  { id: "api", type: "rectangle", x: 0, y: 0, width: 180, height: 80, label: { text: "API" } },
  { id: "db", type: "ellipse", x: 320, y: 0, width: 160, height: 80, label: { text: "Database" } },
  { id: "api-db", type: "arrow", x: 180, y: 40, start: { id: "api" }, end: { id: "db" } },
]

type Saved = { baseRevision: number; scene: { elements: ReadonlyArray<WhiteboardElement> } }
type Staged = { threadId: string; source: { dataUrl: string; name: string } }
type Comment = { anchor: { kind: string; ids: ReadonlyArray<string> }; body: string; attachments: unknown[] }

let boardId = "board-0"
let stored: WhiteboardContent = { version: 1, revision: 1, scene: { elements: AGENT_SCENE } }
let calls: Array<string> = []
let saves: Array<Saved> = []
let comments: Array<Comment> = []
let staged: Array<Staged> = []
let feedback: ArtifactFeedback = { comments: [] }
let agentWrites: WhiteboardContent | undefined
let heldSaves: Promise<void> | undefined
const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()

const boardAt = (revision: number): Artifact => ({
  id: boardId,
  kind: "whiteboard",
  title: "Checkout flow",
  entry: "scene.excalidraw",
  version: revision,
  revision,
  files: [{ path: "scene.excalidraw", type: "application/json", size: 10 }],
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
  threadId: "t-1",
})

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    calls.push(method)
    if (method === "artifacts.list") return { result: [boardAt(stored.revision)] }
    if (method === "artifacts.readWhiteboard") return { result: stored }
    if (method === "artifacts.saveWhiteboard") {
      const save = payload as Saved
      saves.push(save)
      await heldSaves
      if (agentWrites !== undefined) {
        stored = agentWrites
        agentWrites = undefined
        return { result: { type: "conflict", ...stored } }
      }
      stored = { version: 2, revision: stored.revision + 1, scene: save.scene }
      return { result: { type: "saved", version: stored.version, revision: stored.revision } }
    }
    if (method === "attachments.stage") {
      staged.push(payload as Staged)
      return {
        result: {
          id: "a-1",
          name: "Checkout flow.png",
          path: "/tmp/selection.png",
          mime: "image/png",
          kind: "image",
          bytes: 10,
        },
      }
    }
    if (method === "artifacts.comment") {
      comments.push(payload as Comment)
      return { result: { comments: [] } }
    }
    if (method === "artifacts.feedback") return { result: feedback }
    if (method === "environments.list") return { result: { clouds: [] } }
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const thread = { id: "t-1" } as Thread

const push = (event: typeof PushEvent.Encoded) => {
  for (const listener of listeners) listener(event)
}

const canvas = () => document.querySelector<HTMLElement>("[data-whiteboard]")
const hasCanvas = () => canvas() !== null
const idsOnCanvas = () =>
  [...document.querySelectorAll("[data-element-id]")].map((element) => element.getAttribute("data-element-id"))
const selectedIds = () =>
  [...document.querySelectorAll("[data-element-id][data-selected]")].map((element) =>
    element.getAttribute("data-element-id"),
  )

beforeEach(({ task }) => {
  boardId = `board-${task.id}`
  stored = { version: 1, revision: 1, scene: { elements: AGENT_SCENE } }
  calls = []
  saves = []
  comments = []
  staged = []
  feedback = { comments: [] }
  agentWrites = undefined
  heldSaves = undefined
  useArtifacts.getState().select(thread.id, boardId)
  push({ type: "artifact.updated", artifact: boardAt(1) })
})

const openBoard = async (width = 800) => {
  const view = await render(
    <div style={{ width, height: 600, display: "flex", flexDirection: "column" }}>
      <ArtifactsView thread={thread} />
    </div>,
  )
  await expect.poll(() => idsOnCanvas(), { timeout: 15_000 }).toEqual(expect.arrayContaining(["api", "db"]))
  return view
}

const selectAll = async () => {
  await userEvent.keyboard("{Control>}a{/Control}")
  await expect.poll(() => selectedIds().length, { timeout: 2000 }).toBeGreaterThan(0)
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const target = canvas()
  if (target === null) return
  const box = target.getBoundingClientRect()
  const at = ({ x, y }: { x: number; y: number }, buttons: number) => ({
    clientX: box.left + x,
    clientY: box.top + y,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons,
    bubbles: true,
  })
  target.dispatchEvent(new PointerEvent("pointerdown", at(from, 1)))
  await nextFrame()
  target.dispatchEvent(new PointerEvent("pointermove", at(to, 1)))
  await nextFrame()
  target.dispatchEvent(new PointerEvent("pointerup", at(to, 0)))
  await nextFrame()
}

test("completes an agent's skeleton scene on the canvas without saving it", async () => {
  await openBoard()

  expect(idsOnCanvas().toSorted()).toEqual(["api", "api-db", "db"])
  expect(page.getByText("API")).toBeInTheDocument()
  expect(page.getByText("Database")).toBeInTheDocument()
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 800)))
  expect(saves).toEqual([])
  expect(page.getByText("Saved")).toBeInTheDocument()
})

test("saves full elements with the revision it loaded after the developer moves them", async () => {
  await openBoard()
  await selectAll()
  await userEvent.keyboard("{ArrowRight}")

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  const [save] = saves
  expect(save?.baseRevision).toBe(1)
  const api = save?.scene.elements.find((element) => element.id === "api")
  expect(api).toMatchObject({ x: 1 })
  expect(api?.version).toBeGreaterThan(1)
  expect(api?.label).toEqual({ text: "API" })
  await expect.element(page.getByText("Saved")).toBeInTheDocument()
})

test("closing the board saves the edit it was still waiting to save", async () => {
  const view = await openBoard()
  await selectAll()
  await userEvent.keyboard("{ArrowRight}")

  view.unmount()

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  expect(saves[0]?.scene.elements.find((element) => element.id === "api")).toMatchObject({ x: 1 })
})

test("saves the developer's edit under StrictMode", async () => {
  await render(
    <StrictMode>
      <div style={{ width: 800, height: 600, display: "flex", flexDirection: "column" }}>
        <ArtifactsView thread={thread} />
      </div>
    </StrictMode>,
  )
  await expect.poll(() => idsOnCanvas(), { timeout: 15_000 }).toEqual(expect.arrayContaining(["api", "db"]))

  await selectAll()
  await userEvent.keyboard("{ArrowRight}")

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  expect(saves[0]?.scene.elements.find((element) => element.id === "api")).toMatchObject({ x: 1 })
})

test("an edit made after reopening the board saves once the closing save lands", async () => {
  let release = () => {}
  heldSaves = new Promise<void>((resolve) => {
    release = resolve
  })
  const closing = await openBoard()
  await selectAll()
  await userEvent.keyboard("{ArrowRight}")
  closing.unmount()
  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)

  const reopened = await openBoard()
  await selectAll()
  await userEvent.keyboard("{ArrowRight}")
  await new Promise((resolve) => setTimeout(resolve, 800))
  release()

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(2)
  expect(saves[1]?.scene.elements.find((element) => element.id === "api")).toMatchObject({ x: 2 })
  reopened.unmount()
})

test("a board reopened during its closing save keeps what that save merged from the agent", async () => {
  let release = () => {}
  heldSaves = new Promise<void>((resolve) => {
    release = resolve
  })
  const closing = await openBoard()
  await selectAll()
  await userEvent.keyboard("{ArrowRight}")
  closing.unmount()
  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  agentWrites = {
    version: 2,
    revision: 5,
    scene: { elements: [...AGENT_SCENE, { id: "queue", type: "rectangle", x: 0, y: 300, width: 120, height: 60 }] },
  }

  const reopened = await openBoard()
  release()
  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(2)
  await expect.poll(() => idsOnCanvas(), { timeout: 3000 }).toContain("queue")

  await selectAll()
  await userEvent.keyboard("{ArrowRight}")
  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(3)
  expect(saves[2]?.scene.elements.map((element) => element.id)).toContain("queue")
  reopened.unmount()
})

test("merges an agent's write that beat the save and saves again on its revision", async () => {
  await openBoard()
  agentWrites = {
    version: 2,
    revision: 5,
    scene: { elements: [...AGENT_SCENE, { id: "queue", type: "rectangle", x: 0, y: 300, width: 120, height: 60 }] },
  }
  await selectAll()
  await userEvent.keyboard("{ArrowRight}")

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(2)
  expect(saves.map((save) => save.baseRevision)).toEqual([1, 5])
  const elements = saves[1]?.scene.elements ?? []
  expect(elements.find((element) => element.id === "api")).toMatchObject({ x: 1 })
  expect(elements.find((element) => element.id === "queue")).toMatchObject({ y: 300 })
  await expect.element(page.getByText("Saved")).toBeInTheDocument()
})

test("adds an agent's patch next to the developer's unsaved edit", async () => {
  await openBoard()
  await selectAll()
  await userEvent.keyboard("{ArrowDown}")

  stored = {
    version: 2,
    revision: 2,
    scene: { elements: [...AGENT_SCENE, { id: "cache", type: "rectangle", x: 0, y: 200, width: 120, height: 60 }] },
  }
  push({ type: "artifact.updated", artifact: boardAt(2) })

  await expect.poll(() => idsOnCanvas()).toContain("cache")
  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  expect(saves[0]?.baseRevision).toBe(2)
  const elements = saves[0]?.scene.elements ?? []
  expect(elements.find((element) => element.id === "api")).toMatchObject({ y: 1 })
  expect(elements.find((element) => element.id === "cache")).toMatchObject({ y: 200 })
})

test("keeps a deleted element deleted when an agent's older scene arrives", async () => {
  await openBoard()
  await selectAll()
  await userEvent.keyboard("{Delete}")

  stored = { version: 2, revision: 2, scene: { elements: AGENT_SCENE.map((element) => ({ ...element, version: 1 })) } }
  push({ type: "artifact.updated", artifact: boardAt(2) })

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  expect(idsOnCanvas()).toEqual([])
  expect(saves[0]?.scene.elements).toEqual([])
})

test("asks about the selected shapes by their container ids with an image of them", async () => {
  await openBoard()
  await selectAll()

  await page.getByRole("button", { name: "Ask" }).click()
  await userEvent.keyboard("Should the cache sit here?{Enter}")

  await expect.poll(() => comments.length, { timeout: 5000 }).toBe(1)
  const [comment] = comments
  expect(comment?.body).toBe("Should the cache sit here?")
  expect(comment?.anchor).toEqual({ kind: "elements", ids: ["api", "db", "api-db"] })
  expect(comment?.attachments).toEqual([expect.objectContaining({ path: "/tmp/selection.png" })])
  expect(staged[0]?.source.dataUrl).toMatch(/^data:image\/png;base64,/)
  expect(calls.indexOf("attachments.stage")).toBeLessThan(calls.indexOf("artifacts.comment"))
  await expect.element(page.getByRole("textbox", { name: "Ask about the selection" })).not.toBeInTheDocument()
})

const commentOnDb = (): ArtifactFeedback => {
  const at = "2026-11-08T09:00:00.000Z"
  return {
    comments: [
      {
        id: "c_1",
        anchor: { kind: "elements", ids: ["db"] },
        resolved: false,
        messages: [{ id: "m_1", author: { kind: "developer" }, body: "Is this the primary?", createdAt: at }],
        createdAt: at,
        updatedAt: at,
      },
    ],
  }
}

test("selects the elements a comment is about when the developer shows them", async () => {
  feedback = commentOnDb()
  await openBoard()

  await page.getByRole("button", { name: "Comments 1" }).click()
  await page.getByTitle("Show on whiteboard").click()

  await expect.poll(() => selectedIds()).toEqual(["db"])
})

test("opens an empty board and saves the first drawing", async () => {
  stored = { version: 1, revision: 1, scene: { elements: [] } }
  await render(
    <div style={{ width: 800, height: 600, display: "flex", flexDirection: "column" }}>
      <ArtifactsView thread={thread} />
    </div>,
  )
  await expect.poll(hasCanvas, { timeout: 15_000 }).toBe(true)

  await page.getByRole("button", { name: "Rectangle" }).click()
  await expect.poll(() => document.querySelector('[aria-label="Rectangle"]')?.getAttribute("aria-pressed")).toBe("true")
  await drag({ x: 100, y: 100 }, { x: 260, y: 200 })

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  const [element] = saves[0]?.scene.elements ?? []
  expect(element).toMatchObject({ type: "rectangle" })
  expect(element?.width).toBeGreaterThan(0)
})
