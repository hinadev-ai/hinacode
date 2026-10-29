import { create } from "zustand"
import { type ThreadDevices, threadDeviceId, threadDeviceOwned } from "../../shared/device.ts"

/** A device's tab: its id, or `new` for the simulator still being created. */
export const deviceTabKey = (entry: ThreadDevices[number]) => threadDeviceId(entry) ?? "new"

/** The tab that lists the machine's devices to attach one. */
export const DEVICE_LIST_TAB = "list"

interface DeviceTabsState {
  /** The tab each thread last chose. Kept in memory only. */
  readonly selected: Readonly<Record<string, string>>
  readonly select: (threadId: string, tab: string) => void
}

export const useDeviceTabs = create<DeviceTabsState>()((set) => ({
  selected: {},
  select: (threadId, tab) => set((state) => ({ selected: { ...state.selected, [threadId]: tab } })),
}))

/**
 * The chosen tab, or the first device before the thread chose one. A chosen device that is not in the list yet,
 * because it is still being attached, keeps the list showing until it arrives. A new simulator keeps its tab once
 * it gets an id, as the newest device the thread owns.
 */
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

/** Shows the right neighbor of a tab being closed, or its left one at the end of the row, as browsers do. */
export const selectAfterClosing = (threadId: string, devices: ThreadDevices, closing: string) => {
  const index = devices.findIndex((entry) => deviceTabKey(entry) === closing)
  const rest = devices.filter((entry) => deviceTabKey(entry) !== closing)
  const next = rest[index] ?? rest[index - 1]
  useDeviceTabs.getState().select(threadId, next ? deviceTabKey(next) : DEVICE_LIST_TAB)
}
