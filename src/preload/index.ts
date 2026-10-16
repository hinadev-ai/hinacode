import { contextBridge, ipcRenderer, type IpcRendererEvent, webUtils } from "electron"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import type { HinacodeBridge } from "../shared/contract.ts"

const bridge: HinacodeBridge = {
  rpc: (method, payload, environment) => ipcRenderer.invoke(RPC_CHANNEL, { method, payload, environment }),
  onEvent: (listener) => {
    const handler = (_: IpcRendererEvent, event: Parameters<typeof listener>[0]) => listener(event)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.off(EVENT_CHANNEL, handler)
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld("hinacode", bridge)
