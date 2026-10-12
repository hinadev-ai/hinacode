import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import electronBinary, { type BrowserWindow as ElectronWindow } from "electron"
import { Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { PushEvent } from "../../src/shared/contract.ts"
import { rpc } from "./rpc.ts"

export const projectRoot = resolve(import.meta.dirname, "..", "..")

// The package's types describe the Electron API, but its main export at runtime is the binary path.
const executablePath = electronBinary as unknown as string

const AppearanceSnapshot = Schema.Struct({
  scheme: Schema.Literals(["light", "dark"]),
  rendered: Schema.Boolean,
  background: Schema.String,
})
type AppearanceSnapshot = typeof AppearanceSnapshot.Type
const StartupAppearance = Schema.Struct({ firstVisible: AppearanceSnapshot, firstPaint: AppearanceSnapshot })
type StartupAppearance = typeof StartupAppearance.Type

export interface KkcodeApp {
  readonly userData: string
  readonly dbPath: string
  /** The current window. Replaced by `restart`, so read it when needed rather than caching it. */
  readonly page: Page
  readonly firstVisible: AppearanceSnapshot
  readonly firstPaint: AppearanceSnapshot
  /** Quits and starts the app again on the same user data, as a user relaunching it would. */
  readonly restart: () => Promise<void>
  /** Reloads the renderer, which re-reads projects, threads and settings from main. */
  readonly reload: () => Promise<void>
  readonly setWindow: (size: { width: number; height: number; zoom: number }) => Promise<void>
  readonly pushEvents: (events: ReadonlyArray<PushEvent>, intervalMs?: number) => Promise<void>
  readonly close: () => Promise<void>
}

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address ? done(address.port) : fail(new Error("no port"))))
    })
    server.on("error", fail)
  })

/** `main.tsx` mounts only after its first rpc calls answer, so a rendered root means main is ready. */
const waitForRenderer = (page: Page) =>
  page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)

interface SpawnAppOptions {
  readonly mockClaude?: "usage-limit" | "org-spend-limit"
  readonly mockResetMs?: number
}

const launch = async (
  userData: string,
  options: SpawnAppOptions,
): Promise<{ app: ElectronApplication; page: Page } & StartupAppearance> => {
  const env = { ...process.env }
  // Electron-based agent hosts may export this; the test instance must launch its GUI.
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", join(projectRoot, "out/main/index.js")],
    cwd: projectRoot,
    env: {
      ...env,
      KKCODE_USER_DATA: userData,
      ...(options.mockClaude === undefined ? {} : { KKCODE_MOCK_CLAUDE: options.mockClaude }),
      ...(options.mockResetMs === undefined ? {} : { KKCODE_MOCK_RESET_MS: String(options.mockResetMs) }),
    },
  })
  const startup = Schema.decodeUnknownSync(StartupAppearance)(
    await app.evaluate(
      ({ app: electronApp, BrowserWindow }) =>
        new Promise<unknown>((done, fail) => {
          const observe = (nativeWindow: ElectronWindow) => {
            if (nativeWindow.isVisible()) {
              fail(new Error("The window became visible before startup observation"))
              return
            }
            nativeWindow.once("show", () => {
              void nativeWindow.webContents
                .executeJavaScript(`(() => {
                  const snapshot = () => ({
                    scheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
                    rendered: (document.getElementById("root")?.childElementCount ?? 0) > 0,
                    background: getComputedStyle(document.body).backgroundColor
                  })
                  const firstVisible = snapshot()
                  return new Promise(done => {
                    const observer = new PerformanceObserver(list => {
                      if (list.getEntries().some(entry => entry.name === "first-contentful-paint")) {
                        observer.disconnect()
                        done({ firstVisible, firstPaint: snapshot() })
                      }
                    })
                    observer.observe({ type: "paint", buffered: true })
                  })
                })()`)
                .then(done, fail)
            })
          }
          const existingWindow = BrowserWindow.getAllWindows()[0]
          if (existingWindow) observe(existingWindow)
          else electronApp.once("browser-window-created", (_, createdWindow) => observe(createdWindow))
        }),
    ),
  )
  const page = await app.firstWindow()
  await waitForRenderer(page)
  return { app, page, ...startup }
}

export const spawnApp = async (options: SpawnAppOptions = {}): Promise<KkcodeApp> => {
  const userData = mkdtempSync(join(tmpdir(), "kk-e2e-"))
  let current = await launch(userData, options)
  // A fresh profile listens for automation webhooks on a fixed port that other instances may hold.
  await rpc(current.page, "settings.set", { automations: { bindHost: "127.0.0.1", port: await freePort() } })
  return {
    userData,
    dbPath: join(userData, "kkcode.sqlite"),
    get page() {
      return current.page
    },
    get firstVisible() {
      return current.firstVisible
    },
    get firstPaint() {
      return current.firstPaint
    },
    restart: async () => {
      await current.app.close()
      current = await launch(userData, options)
    },
    reload: async () => {
      await current.page.reload()
      await waitForRenderer(current.page)
    },
    setWindow: async (size) => {
      await current.app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error("kkcode window is missing")
        window.setSize(width, height)
        window.webContents.setZoomFactor(zoom)
      }, size)
    },
    pushEvents: async (events, intervalMs = 0) => {
      await current.app.evaluate(
        async ({ BrowserWindow }, input) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) throw new Error("no app window for push events")
          for (const event of input.events) {
            // Pacing is input to the streaming workload; it does not wait for an assertion.
            if (input.intervalMs > 0) await new Promise<void>((done) => setTimeout(done, input.intervalMs))
            window.webContents.send("event", event)
          }
        },
        { events, intervalMs },
      )
    },
    close: async () => {
      await current.app.close()
      rmSync(userData, { recursive: true, force: true })
    },
  }
}
