import { Schema } from "effect"
import { FONT_FAMILY } from "@excalidraw/excalidraw"
import { beforeEach, expect, test } from "vitest"
import { cdp, page, userEvent } from "vitest/browser"
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

type Scene = ReadonlyArray<{
  id: string
  type: string
  containerId?: string | null
  isDeleted?: boolean
  fontFamily?: number
}>

type ViewState = {
  selectedElementIds: Record<string, true>
  scrollX: number
  scrollY: number
  width: number
  height: number
  zoom: { value: number }
}
type Editor = { elements: Scene; state: ViewState; setState: (state: Partial<ViewState>) => void }

const editor = () => (window as unknown as { h?: Editor }).h

const sceneOnCanvas = () => (editor()?.elements ?? []).filter((element) => !element.isDeleted)

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
  await expect
    .poll(() => sceneOnCanvas().map((element) => element.id), { timeout: 15_000 })
    .toEqual(expect.arrayContaining(["api", "db"]))
  return view
}

const selectAll = async () => {
  const canvas = document.querySelector("canvas.interactive")!.getBoundingClientRect()
  await userEvent.click(page.elementLocator(document.querySelector("canvas.interactive")!), {
    position: { x: 30, y: canvas.height / 2 },
  })
  const mod = /Mac/.test(navigator.platform) ? 4 : 2
  await cdp().send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: mod })
  await cdp().send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: mod })
}

test("completes an agent's skeleton scene on the canvas without saving it", async () => {
  await openBoard()

  const labels = sceneOnCanvas().filter((element) => element.type === "text")
  expect(labels.map((label) => label.containerId).toSorted()).toEqual(["api", "db"])
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 800)))
  expect(saves).toEqual([])
  expect(page.getByText("Saved")).toBeInTheDocument()
})

test("draws text in the app font and keeps Excalidraw's fonts off the page", async () => {
  await openBoard()

  const labels = sceneOnCanvas().filter((element) => element.type === "text")
  expect(labels.map((label) => label.fontFamily)).toEqual([FONT_FAMILY.Helvetica, FONT_FAMILY.Helvetica])
  const context = document.createElement("canvas").getContext("2d")!
  context.font = "20px Helvetica, Xiaolai, Segoe UI Emoji"
  expect(context.font).toContain("DM Sans Variable")
  const families = [...document.fonts].map((face) => face.family.replaceAll('"', ""))
  expect(families).not.toContain("Excalifont")
  expect(families).not.toContain("Xiaolai")
})

test("saves full elements with the revision it loaded after the developer moves them", async () => {
  await openBoard()

  await selectAll()
  await userEvent.keyboard("{ArrowRight}")

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  const [save] = saves
  expect(save?.baseRevision).toBe(1)
  const api = save?.scene.elements.find((element) => element.id === "api")
  expect(api).toMatchObject({ x: 1, version: expect.any(Number), seed: expect.any(Number) })
  expect(save?.scene.elements.find((element) => element["containerId"] === "api")).toMatchObject({ text: "API" })
  await expect.element(page.getByText("Saved")).toBeInTheDocument()
})

test("closing the board saves the edit it was still waiting to save", async () => {
  const view = await openBoard()
  await selectAll()
  await userEvent.keyboard("{ArrowRight}")

  view.unmount()

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  const elements = saves[0]?.scene.elements ?? []
  expect(elements.map((element) => element.id)).toEqual(expect.arrayContaining(["api", "db", "api-db"]))
  expect(elements.find((element) => element.id === "api")).toMatchObject({ x: 1 })
})

test("an edit made after reopening the board saves once the closing save lands", async () => {
  let release = () => {}
  heldSaves = new Promise((resolve) => {
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
  expect(elements.find((element) => element.id === "queue")).toMatchObject({ y: 300, version: expect.any(Number) })
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

  await expect.poll(() => sceneOnCanvas().map((element) => element.id)).toContain("cache")
  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  expect(saves[0]?.baseRevision).toBe(2)
  const elements = saves[0]?.scene.elements ?? []
  expect(elements.find((element) => element.id === "api")).toMatchObject({ y: 1 })
  expect(elements.find((element) => element.id === "cache")).toMatchObject({ y: 200 })
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
  expect(staged).toEqual([
    {
      threadId: "t-1",
      source: { dataUrl: expect.stringMatching(/^data:image\/png;base64,/), name: "Checkout flow.png" },
    },
  ])
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

const dbOnScreen = () => {
  const state = editor()?.state
  if (state === undefined) return false
  const zoom = state.zoom.value
  const [left, top, right, bottom] = [320, 0, 480, 80]
  return (
    (left + state.scrollX) * zoom >= 0 &&
    (right + state.scrollX) * zoom <= state.width &&
    (top + state.scrollY) * zoom >= 0 &&
    (bottom + state.scrollY) * zoom <= state.height
  )
}

const viewOf = () => {
  const state = editor()?.state
  return JSON.stringify([state?.scrollX, state?.scrollY, state?.zoom.value])
}

const viewSettled = async () => {
  const before = viewOf()
  await new Promise((resolve) => setTimeout(resolve, 300))
  return viewOf() === before
}

test("selects the elements a comment is about when the developer shows them", async () => {
  feedback = commentOnDb()
  await openBoard()

  await page.getByRole("button", { name: "Comments 1" }).click()
  await page.getByTitle("Show on whiteboard").click()

  await expect.poll(() => Object.keys(editor()?.state.selectedElementIds ?? {})).toEqual(["db"])
})

test("scrolls a narrow board to a comment's elements after the comments make way for it", async () => {
  feedback = commentOnDb()
  await openBoard(480)
  editor()?.setState({ scrollX: 5000, scrollY: 5000 })
  await expect.poll(dbOnScreen).toBe(false)

  await page.getByRole("button", { name: "Comments 1" }).click()
  await expect.poll(() => editor()?.state.width).toBe(0)
  await page.getByTitle("Show on whiteboard").click()

  await expect.element(page.getByRole("region", { name: "Comments" })).not.toBeInTheDocument()
  await expect.poll(() => Object.keys(editor()?.state.selectedElementIds ?? {})).toEqual(["db"])
  await expect.poll(viewSettled, { timeout: 5000 }).toBe(true)
  expect(dbOnScreen()).toBe(true)
})

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const canvas = document.querySelector("canvas.interactive")!
  const box = canvas.getBoundingClientRect()
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
  canvas.dispatchEvent(new PointerEvent("pointerdown", at(from, 1)))
  await nextFrame()
  canvas.dispatchEvent(new PointerEvent("pointermove", at(to, 1)))
  await nextFrame()
  window.dispatchEvent(new PointerEvent("pointerup", at(to, 0)))
}

test("opens an empty board at full size and saves the first drawing without moving the view", async () => {
  stored = { version: 1, revision: 1, scene: { elements: [] } }
  await render(
    <div style={{ width: 800, height: 600, display: "flex", flexDirection: "column" }}>
      <ArtifactsView thread={thread} />
    </div>,
  )
  await expect.poll(() => editor()?.state.width ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect.poll(viewSettled).toBe(true)
  expect(editor()?.state.zoom.value).toBe(1)
  const before = viewOf()

  await userEvent.click(page.elementLocator(document.querySelector("canvas.interactive")!), {
    position: { x: 100, y: 100 },
  })
  await userEvent.keyboard("r")
  await drag({ x: 100, y: 100 }, { x: 260, y: 200 })

  await expect.poll(() => saves.length, { timeout: 3000 }).toBe(1)
  expect(saves[0]?.baseRevision).toBe(1)
  expect(saves[0]?.scene.elements).toEqual([expect.objectContaining({ type: "rectangle", width: 160, height: 100 })])
  expect(viewOf()).toBe(before)
})
