import { beforeEach, describe, expect, test, vi } from "vitest"
import { dispatchTouch, emulateTouch } from "./webviewTouch.ts"

const electron = vi.hoisted(() => ({ guests: new Map<number, unknown>() }))

vi.mock("electron", () => ({ webContents: { fromId: (id: number) => electron.guests.get(id) } }))

const host = {} as Electron.WebContents

const guestOf = (owner: Electron.WebContents) => {
  const sent: Array<[string, unknown]> = []
  let attached = false
  const guest = {
    hostWebContents: owner,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      sendCommand: async (method: string, params: unknown) => {
        sent.push([method, params])
      },
    },
  }
  electron.guests.set(electron.guests.size + 1, guest)
  return { id: electron.guests.size, sent, attached: () => attached }
}

beforeEach(() => electron.guests.clear())

describe("webview touch", () => {
  test("refuses a page that another window embeds", async () => {
    const guest = guestOf({} as Electron.WebContents)
    await emulateTouch(host, guest.id, true)
    await dispatchTouch(host, guest.id, { type: "touchStart", x: 10, y: 20 })
    expect(guest.attached()).toBe(false)
    expect(guest.sent).toStrictEqual([])
  })

  test("leaves a page without a debugger when touch was never on", async () => {
    const guest = guestOf(host)
    await emulateTouch(host, guest.id, false)
    expect(guest.attached()).toBe(false)
  })

  test("sends touch points while the finger is down and none once it lifts", async () => {
    const guest = guestOf(host)
    await emulateTouch(host, guest.id, true)
    await dispatchTouch(host, guest.id, { type: "touchStart", x: 10, y: 20 })
    await dispatchTouch(host, guest.id, { type: "touchMove", x: 10, y: 40 })
    await dispatchTouch(host, guest.id, { type: "touchEnd", x: 10, y: 40 })
    expect(guest.sent).toStrictEqual([
      ["Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }],
      ["Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 10, y: 20 }] }],
      ["Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 10, y: 40 }] }],
      ["Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }],
    ])
  })
})
