import type { PagePick } from "../../shared/browser.ts"
import type { DeviceElement } from "../../shared/device.ts"
import { elementLabel } from "../../shared/browserPicker.ts"
import { useDrafts } from "../stores/drafts.ts"
import { callPromise } from "./rpc.ts"

export { PagePick } from "../../shared/browser.ts"
export { CANCEL_PICK_SCRIPT, elementLabel, PICK_ELEMENT_SCRIPT } from "../../shared/browserPicker.ts"

export const deviceElementLabel = (element: DeviceElement) => element.label || element.identifier || element.role

export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  executeJavaScript(code: string): Promise<unknown>
  capturePage(rect?: PagePick["rect"]): Promise<{ toDataURL(): string }>
  getZoomFactor(): number
}

export const attachPick = async (threadId: string, view: WebviewElement, pick: PagePick, signal: AbortSignal) => {
  // FIXME: capturePage takes device-independent pixels, but the rect is in zoomed CSS pixels
  const zoom = view.getZoomFactor()
  const { x, y, width, height } = pick.rect
  const rect =
    width >= 1 && height >= 1
      ? {
          x: Math.floor(x * zoom),
          y: Math.floor(y * zoom),
          width: Math.ceil(width * zoom),
          height: Math.ceil(height * zoom),
        }
      : undefined
  signal.throwIfAborted()
  const image = await view.capturePage(rect)
  signal.throwIfAborted()
  const staged = await callPromise("attachments.stage", {
    threadId,
    source: { dataUrl: image.toDataURL(), name: `${elementLabel(pick.element)}.png` },
  })
  signal.throwIfAborted()
  const attachment = { ...staged, element: pick.element }
  useDrafts.getState().addAttachments(threadId, [attachment])
  return attachment
}

export const isInDeviceKeyboard = (target: EventTarget | null) =>
  target instanceof Element && target.closest("[data-device-keyboard]") !== null
