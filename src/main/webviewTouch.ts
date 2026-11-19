import { webContents } from "electron"
import type { BrowserTouch } from "../shared/browser.ts"

const MAX_TOUCH_POINTS = 5

const guestOf = (host: Electron.WebContents, guestId: number) => {
  const guest = webContents.fromId(guestId)
  return guest?.hostWebContents === host ? guest : null
}

const devtoolsOf = (guest: Electron.WebContents) => {
  if (!guest.debugger.isAttached()) guest.debugger.attach("1.3")
  return guest.debugger
}

export const emulateTouch = async (host: Electron.WebContents, guestId: number, enabled: boolean) => {
  const guest = guestOf(host, guestId)
  if (guest === null || (!enabled && !guest.debugger.isAttached())) return
  await devtoolsOf(guest).sendCommand("Emulation.setTouchEmulationEnabled", {
    enabled,
    maxTouchPoints: MAX_TOUCH_POINTS,
  })
}

export const dispatchTouch = async (host: Electron.WebContents, guestId: number, { type, x, y }: BrowserTouch) => {
  const guest = guestOf(host, guestId)
  if (guest === null) return
  const lifted = type === "touchEnd" || type === "touchCancel"
  await devtoolsOf(guest).sendCommand("Input.dispatchTouchEvent", { type, touchPoints: lifted ? [] : [{ x, y }] })
}
