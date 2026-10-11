import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import type { KkcodeBridge } from "../shared/contract.ts"

const bridge: KkcodeBridge = {
  rpc: (method, payload) => ipcRenderer.invoke(RPC_CHANNEL, { method, payload }),
  onEvent: (listener) => {
    const handler = (_: IpcRendererEvent, event: Parameters<typeof listener>[0]) => listener(event)
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.off(EVENT_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld("kkcode", bridge)
