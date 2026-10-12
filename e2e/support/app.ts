import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test"
import electronBinary from "electron"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { rpc } from "./rpc.ts"

export const projectRoot = resolve(import.meta.dirname, "..", "..")

// The package's types describe the Electron API, but its main export at runtime is the binary path.
const executablePath = electronBinary as unknown as string

export interface KkcodeApp {
  readonly userData: string
  readonly dbPath: string
  /** The current window. Replaced by `restart`, so read it when needed rather than caching it. */
  readonly page: Page
  /** Quits and starts the app again on the same user data, as a user relaunching it would. */
  readonly restart: () => Promise<void>
  /** Reloads the renderer, which re-reads projects, threads and settings from main. */
  readonly reload: () => Promise<void>
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

const launch = async (userData: string): Promise<{ app: ElectronApplication; page: Page }> => {
  const app = await electron.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-gpu", join(projectRoot, "out/main/index.js")],
    cwd: projectRoot,
    env: { ...process.env, KKCODE_USER_DATA: userData },
  })
  const page = await app.firstWindow()
  await waitForRenderer(page)
  return { app, page }
}

export const spawnApp = async (): Promise<KkcodeApp> => {
  const userData = mkdtempSync(join(tmpdir(), "kk-e2e-"))
  let current = await launch(userData)
  // A fresh profile listens for automation webhooks on a fixed port that other instances may hold.
  await rpc(current.page, "settings.set", { automations: { bindHost: "127.0.0.1", port: await freePort() } })
  return {
    userData,
    dbPath: join(userData, "kkcode.sqlite"),
    get page() {
      return current.page
    },
    restart: async () => {
      await current.app.close()
      current = await launch(userData)
    },
    reload: async () => {
      await current.page.reload()
      await waitForRenderer(current.page)
    },
    close: async () => {
      await current.app.close()
      rmSync(userData, { recursive: true, force: true })
    },
  }
}
