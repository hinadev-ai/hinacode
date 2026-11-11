import { toast } from "sonner"
import { beforeEach, expect, test, vi } from "vitest"
import { notify } from "./notify.ts"
import { type BrowserContext, makeBrowserAnswers } from "../../../apps/web/src/browser.ts"

vi.stubGlobal("hinacode", {
  rpc: async () => ({ result: undefined }),
  onEvent: () => () => {},
  pathForFile: () => "",
  runtime: { kind: "web" },
})

const shown: Array<string> = []

beforeEach(() => {
  shown.length = 0
  vi.spyOn(navigator.serviceWorker, "getRegistration").mockResolvedValue(undefined)
})

const stubNotification = (show: (title: string) => void) =>
  vi.stubGlobal(
    "Notification",
    class extends EventTarget {
      static permission = "granted"
      static requestPermission = async () => "granted"
      constructor(title: string) {
        super()
        show(title)
      }
    },
  )

const toastTitles = () => toast.getHistory().map((entry) => ("title" in entry ? String(entry.title) : ""))

const alert = (title: string) => ({ alert: "completed", title, body: "Finished", sound: false }) as const

test("an alert falls back to a toast when the browser cannot construct a notification", async () => {
  stubNotification(() => {
    throw new TypeError("Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.")
  })
  notify("desktop", alert("constructor throws"))
  await expect.poll(toastTitles).toContain("constructor throws")
})

test("an alert shown as a system notification does not also toast", async () => {
  stubNotification((title) => shown.push(title))
  notify("desktop", alert("notification shown"))
  await expect.poll(() => shown).toEqual(["notification shown"])
  expect(toastTitles()).not.toContain("notification shown")
})

test("asking for permission in the browser reports a test notification that fails to show", async () => {
  stubNotification(() => {
    throw new TypeError("Illegal constructor")
  })
  const answer = makeBrowserAnswers({} as BrowserContext)
  await expect(answer("notifications.askPermission", { title: "HinaCode", body: "Test" })).resolves.toEqual({
    error: { tag: "BrowserError", message: "Illegal constructor" },
  })
})
