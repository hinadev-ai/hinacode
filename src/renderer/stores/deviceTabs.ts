import { create } from "zustand"
import { type ThreadDevices, threadDeviceId, threadDeviceOwned } from "../../shared/device.ts"

export const deviceTabKey = (entry: ThreadDevices[number]) => threadDeviceId(entry) ?? "new"

export const DEVICE_LIST_TAB = "list"

interface DeviceTabsState {
  readonly selected: Readonly<Record<string, string>>
  readonly select: (threadId: string, tab: string) => void
}

export const useDeviceTabs = create<DeviceTabsState>()((set) => ({
  selected: {},
  select: (threadId, tab) => set((state) => ({ selected: { ...state.selected, [threadId]: tab } })),
}))

export const shownDeviceTab = (devices: ThreadDevices, chosen: string | undefined) => {
  if (chosen !== undefined && (chosen === DEVICE_LIST_TAB || devices.some((entry) => deviceTabKey(entry) === chosen)))
    return chosen
  const created = chosen === "new" ? devices.findLast(threadDeviceOwned) : undefined
  if (created) return deviceTabKey(created)
  const [first] = devices
  return chosen === undefined && first ? deviceTabKey(first) : DEVICE_LIST_TAB
}

export const useShownDeviceTab = (threadId: string, devices: ThreadDevices) =>
  shownDeviceTab(
    devices,
    useDeviceTabs((state) => state.selected[threadId]),
  )

export const selectAfterClosing = (threadId: string, devices: ThreadDevices, closing: string) => {
  const index = devices.findIndex((entry) => deviceTabKey(entry) === closing)
  const rest = devices.filter((entry) => deviceTabKey(entry) !== closing)
  const next = rest[index] ?? rest[index - 1]
  useDeviceTabs.getState().select(threadId, next ? deviceTabKey(next) : DEVICE_LIST_TAB)
}
