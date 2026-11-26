import RFB from "@novnc/novnc"
import { mountScreen, type ScreenCommand, type ScreenMessage } from "./controller"

declare global {
  interface Window {
    readonly ReactNativeWebView?: { postMessage: (message: string) => void }
    kkScreen: (command: ScreenCommand) => void
  }
}

const native = window.ReactNativeWebView
const post = (message: ScreenMessage) =>
  native === undefined ? window.parent.postMessage({ kkScreen: message }, "*") : native.postMessage(JSON.stringify(message))
const screen = mountScreen(RFB, document.getElementById("screen")!, post)
window.kkScreen = screen.run
if (native === undefined) {
  window.addEventListener("message", (event: MessageEvent<{ kkScreen?: ScreenCommand }>) => {
    if (event.source === window.parent && event.data.kkScreen !== undefined) screen.run(event.data.kkScreen)
  })
}
post({ type: "ready" })
