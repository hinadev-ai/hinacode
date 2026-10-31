import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import electronBinary, { type BrowserWindow as ElectronWindow } from "electron"
import { Schema } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ProviderId } from "../../src/shared/agent.ts"
import type { PushEvent } from "../../src/shared/contract.ts"
import { rpc } from "./rpc.ts"

export const projectRoot = resolve(import.meta.dirname, "..", "..")

// FIXME: electron's types describe the Electron API, but its runtime main export is the binary path
const executablePath = electronBinary as unknown as string

const AppearanceSnapshot = Schema.Struct({
  scheme: Schema.Literals(["light", "dark"]),
  rendered: Schema.Boolean,
  background: Schema.String,
})
type AppearanceSnapshot = typeof AppearanceSnapshot.Type
const StartupAppearance = Schema.Struct({ firstVisible: AppearanceSnapshot, firstPaint: AppearanceSnapshot })
type StartupAppearance = typeof StartupAppearance.Type

declare global {
  var hinacodeStartupAppearance: Promise<unknown>
}

export interface HinacodeApp {
  readonly userData: string
  readonly dbPath: string
  readonly page: Page
  readonly firstVisible: AppearanceSnapshot
  readonly firstPaint: AppearanceSnapshot
  readonly restart: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly minimize: () => Promise<void>
  readonly windowState: () => Promise<{ readonly minimized: boolean; readonly focused: boolean }>
  readonly setWindow: (size: { width: number; height: number; zoom: number }) => Promise<void>
  readonly clipboardText: () => Promise<string>
  readonly pushEvents: (events: ReadonlyArray<PushEvent>, intervalMs?: number) => Promise<void>
  readonly launchAgain: (timeoutMs: number) => Promise<number | null>
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

const waitForRenderer = (page: Page) =>
  page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)

interface SpawnAppOptions {
  readonly mockClaude?: "usage-limit" | "org-spend-limit" | "todos" | "activity"
  readonly mockResetMs?: number
}

const appArgs = [
  "--no-sandbox",
  "--disable-gpu",
  "--mute-audio",
  "-r",
  join(import.meta.dirname, "startup-observer.cjs"),
  join(projectRoot, "out/main/index.js"),
]

const appEnv = (userData: string, options: SpawnAppOptions) => {
  const env = { ...process.env }
  // FIXME: Electron-based agent hosts export ELECTRON_RUN_AS_NODE, which stops the GUI from launching
  delete env.ELECTRON_RUN_AS_NODE
  return {
    ...env,
    HINACODE_USER_DATA: userData,
    HINACODE_SKIP_AGENT_UPDATES: "1",
    ...(options.mockClaude === undefined ? {} : { HINACODE_MOCK_CLAUDE: options.mockClaude }),
    ...(options.mockResetMs === undefined ? {} : { HINACODE_MOCK_RESET_MS: String(options.mockResetMs) }),
  }
}

const launch = async (
  userData: string,
  options: SpawnAppOptions,
): Promise<{ app: ElectronApplication; page: Page } & StartupAppearance> => {
  const app = await electron.launch({ executablePath, args: appArgs, cwd: projectRoot, env: appEnv(userData, options) })
  await app.evaluate(
    ({ app: electronApp, BrowserWindow }) =>
      new Promise<void>((done) => {
        const waitForShow = (nativeWindow: ElectronWindow) => {
          if (nativeWindow.isVisible()) done()
          else nativeWindow.once("show", () => done())
        }
        const existingWindow = BrowserWindow.getAllWindows()[0]
        if (existingWindow) waitForShow(existingWindow)
        else electronApp.once("browser-window-created", (_, createdWindow) => waitForShow(createdWindow))
      }),
  )
  const startup = Schema.decodeUnknownSync(StartupAppearance)(
    await app.evaluate(() => globalThis.hinacodeStartupAppearance),
  )
  const page = await app.firstWindow()
  await waitForRenderer(page)
  return { app, page, ...startup }
}

export const spawnApp = async (options: SpawnAppOptions = {}): Promise<HinacodeApp> => {
  const userData = mkdtempSync(join(tmpdir(), "kk-e2e-"))
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ enabledProviders: ProviderId.literals }))
  let current = await launch(userData, options)
  await rpc(current.page, "settings.set", { automations: { bindHost: "127.0.0.1", port: await freePort() } })
  return {
    userData,
    dbPath: join(userData, "hinacode.sqlite"),
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
    minimize: async () => {
      await current.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
    },
    windowState: async () =>
      current.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error("hinacode window is missing")
        return { minimized: window.isMinimized(), focused: window.isFocused() }
      }),
    setWindow: async (size) => {
      await current.app.evaluate(({ BrowserWindow }, { width, height, zoom }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window) throw new Error("hinacode window is missing")
        window.setSize(width, height)
        window.webContents.setZoomFactor(zoom)
      }, size)
    },
    clipboardText: () => current.app.evaluate(({ clipboard }) => clipboard.readText()),
    pushEvents: async (events, intervalMs = 0) => {
      await current.app.evaluate(
        async ({ BrowserWindow }, input) => {
          const window = BrowserWindow.getAllWindows()[0]
          if (!window) throw new Error("no app window for push events")
          for (const event of input.events) {
            // oxlint-disable-next-line hinacode/no-wall-clock-in-test -- pacing is input to the streaming workload, not a wait for an assertion.
            if (input.intervalMs > 0) await new Promise<void>((done) => setTimeout(done, input.intervalMs))
            window.webContents.send("event", event)
          }
        },
        { events, intervalMs },
      )
    },
    launchAgain: (timeoutMs) =>
      new Promise((done, fail) => {
        const second = spawn(executablePath, appArgs, {
          cwd: projectRoot,
          env: appEnv(userData, options),
          stdio: "ignore",
        })
        // oxlint-disable-next-line hinacode/no-wall-clock-in-test -- a second instance that stays up has no event to wait on.
        const timer = setTimeout(() => {
          second.kill("SIGKILL")
          done(null)
        }, timeoutMs)
        second.once("error", fail)
        second.once("exit", (code) => {
          clearTimeout(timer)
          done(code)
        })
      }),
    close: async () => {
      await current.app.close()
      rmSync(userData, { recursive: true, force: true })
    },
  }
}
