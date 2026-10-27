import type { PagePick } from "../../shared/browser.ts"
import { elementLabel } from "../../shared/browserPicker.ts"
import { useDrafts } from "../stores/drafts.ts"
import { callPromise } from "./rpc.ts"

export { PagePick } from "../../shared/browser.ts"
export { CANCEL_PICK_SCRIPT, elementLabel, PICK_ELEMENT_SCRIPT } from "../../shared/browserPicker.ts"

/** The part of a `<webview>` the browser view uses. */
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

/**
 * Screenshots the picked element and adds it to the thread's draft as an image that carries the element. Aborting
 * `signal`, as a navigation does, stops it before it captures the next page or touches the draft.
 */
export const attachPick = async (threadId: string, view: WebviewElement, pick: PagePick, signal: AbortSignal) => {
  // The rect is in CSS pixels and capturePage takes device-independent ones, which differ once the page is zoomed.
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
