import { expect, test } from "vitest"
import { cdp, page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { HinacodeBridge } from "../../../shared/contract.ts"
import type { Attachment } from "../../../shared/domain.ts"
import "../../index.css"
import { blobFromDataUrl } from "../../lib/dataUrl.ts"
import { emptyLog } from "../../lib/imageEdit/document.ts"
import { useDrafts } from "../../stores/drafts.ts"
import { useImageEditor } from "../../stores/imageEditor.ts"
import { ImageEditorHost } from "./ImageEditorHost.tsx"

const staged: Array<{ name: string; dataUrl: string }> = []

const edited: Attachment = {
  id: "edited",
  name: "shot-edited.png",
  path: "/tmp/shot-edited.png",
  mime: "image/png",
  kind: "image",
  bytes: 1,
}

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "attachments.stage") {
      const { source } = payload as { source: { name: string; dataUrl: string } }
      staged.push(source)
      return { result: edited }
    }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const original: Attachment = { ...edited, id: "original", name: "shot.png", path: "/tmp/shot.png" }

const graySource = async () => {
  const canvas = new OffscreenCanvas(400, 300)
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#808080"
  ctx.fillRect(0, 0, 400, 300)
  const image = await createImageBitmap(canvas)
  return { image, width: 400, height: 300 }
}

const key = async (name: string, modifiers = 0) => {
  const code = name.length === 1 ? `Key${name.toUpperCase()}` : name
  const text = name.length === 1 && modifiers === 0 ? name : undefined
  const event = {
    key: name,
    code,
    text,
    modifiers,
    windowsVirtualKeyCode: name === "Enter" ? 13 : name.toUpperCase().charCodeAt(0),
  }
  await cdp().send("Input.dispatchKeyEvent", { type: "keyDown", ...event })
  await cdp().send("Input.dispatchKeyEvent", { type: "keyUp", ...event })
}
const ctrl = 2
const shift = 8

const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
  await cdp().send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1 })
  for (let step = 1; step <= 4; step++) {
    const x = from.x + ((to.x - from.x) * step) / 4
    const y = from.y + ((to.y - from.y) * step) / 4
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 })
  }
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", clickCount: 1 })
}

const reddishPixels = async (dataUrl: string) => {
  const bitmap = await createImageBitmap(blobFromDataUrl(dataUrl))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  let count = 0
  for (let index = 0; index < data.length; index += 4) if (data[index]! > 200 && data[index + 1]! < 100) count++
  return count
}

test("draws a rectangle, undoes and redoes it, and Done swaps the chip for the export", async () => {
  useDrafts.getState().addAttachments("t-1", [original])
  useImageEditor.setState({
    request: {
      threadId: "t-1",
      attachment: original,
      original,
      log: emptyLog,
      source: { status: "ready", source: await graySource() },
    },
  })
  await render(<ImageEditorHost />)
  const undo = page.getByRole("button", { name: "Undo", exact: true })
  await expect.element(undo).toBeDisabled()
  await expect.poll(() => document.querySelector("canvas")?.width ?? 0).toBeGreaterThan(300)

  const bounds = document.querySelector("canvas")!.getBoundingClientRect()
  const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
  await key("r")
  await expect
    .element(page.getByRole("button", { name: "Rectangle", exact: true }))
    .toHaveAttribute("aria-pressed", "true")
  await drag({ x: center.x - 80, y: center.y - 50 }, { x: center.x + 80, y: center.y + 50 })
  await expect.element(undo).toBeEnabled()

  await key("z", ctrl)
  await expect.element(undo).toBeDisabled()
  await key("z", ctrl | shift)
  await expect.element(undo).toBeEnabled()

  await key("Enter")
  await expect.poll(() => useImageEditor.getState().request).toBeNull()
  expect(staged.map((source) => source.name)).toEqual(["shot-edited.png"])
  expect(await reddishPixels(staged[0]!.dataUrl)).toBeGreaterThan(200)
  expect(useDrafts.getState().byThreadId["t-1"]?.attachments.map((attachment) => attachment.id)).toEqual(["edited"])
})
