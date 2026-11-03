import { BrowserWindow } from "electron"

const SETTLE_MS = 1000
const LOAD_TIMEOUT_MS = 15_000

export interface ArtifactPageOptions {
  readonly url: string
  readonly size?: { readonly width: number; readonly height: number }
  readonly onProblem?: (problem: unknown) => void
}

export const withArtifactPage = async <T>(
  { url, size, onProblem }: ArtifactPageOptions,
  use: (page: Electron.WebContents) => Promise<T>,
) => {
  const page = new BrowserWindow({
    show: false,
    ...(size === undefined ? {} : { width: size.width, height: size.height, useContentSize: true }),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  page.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  page.webContents.on("will-navigate", (event) => event.preventDefault())
  const settled = async () => {
    if (onProblem !== undefined) {
      await page.loadURL("about:blank")
      const { debugger: devtools } = page.webContents
      devtools.attach("1.3")
      devtools.on("message", (_event, method, params) => onProblem({ method, params }))
      await Promise.all([devtools.sendCommand("Runtime.enable"), devtools.sendCommand("Log.enable")])
    }
    await page.loadURL(url)
    await page.webContents.executeJavaScript(
      `document.fonts.ready.then(() => new Promise((settle) => setTimeout(settle, ${SETTLE_MS})))`,
    )
    return use(page.webContents)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The artifact did not settle within ${LOAD_TIMEOUT_MS / 1000} seconds.`)),
      LOAD_TIMEOUT_MS,
    )
  })
  const work = settled()
  work.catch(() => undefined)
  try {
    return await Promise.race([work, timedOut])
  } finally {
    clearTimeout(timer)
    page.destroy()
  }
}
