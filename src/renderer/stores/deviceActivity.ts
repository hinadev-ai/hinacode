import { create } from "zustand"
import { m } from "../paraglide/messages.js"

interface DeviceActivityState {
  readonly unseen: Readonly<Record<string, true>>
  readonly markUnseen: (threadId: string) => void
  readonly markSeen: (threadId: string) => void
}

export const useDeviceActivity = create<DeviceActivityState>()((set) => ({
  unseen: {},
  markUnseen: (threadId) =>
    set((state) => (state.unseen[threadId] ? state : { unseen: { ...state.unseen, [threadId]: true } })),
  markSeen: (threadId) =>
    set((state) => {
      if (!state.unseen[threadId]) return state
      const { [threadId]: _seen, ...unseen } = state.unseen
      return { unseen }
    }),
}))

export const useUnseenDeviceActivityLabel = (threadId: string) =>
  useDeviceActivity((state) => state.unseen[threadId]) ? m.devices_agent_used() : null
