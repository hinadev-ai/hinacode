const { app, BrowserWindow, ipcMain } = require("electron")
const path = require("node:path")

const TRIALS = Number(process.env.TRIALS ?? 3000)
let seq = 0

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true },
  })
  const pump = () => {
    if (win.isDestroyed()) return
    for (let i = 0; i < 3; i++) win.webContents.send("event", ++seq)
    setImmediate(pump)
  }
  ipcMain.handle("rpc", async () => ({ seq }))
  ipcMain.handle("done", (_, result) => {
    console.log(JSON.stringify({ electron: process.versions.electron, trials: TRIALS, ...result }))
    app.quit()
  })
  win.loadFile(path.join(__dirname, "index.html"), { query: { trials: String(TRIALS) } })
  win.webContents.once("did-finish-load", pump)
})
