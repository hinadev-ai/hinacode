const { contextBridge, ipcRenderer } = require("electron")
contextBridge.exposeInMainWorld("probe", {
  rpc: () => ipcRenderer.invoke("rpc"),
  done: (result) => ipcRenderer.invoke("done", result),
  onEvent: (listener) => ipcRenderer.on("event", (_, seq) => listener(seq)),
})
