import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { RiAddLine, RiAndroidLine, RiAppleLine, RiCloseLine, RiErrorWarningLine, RiLoader4Line } from "react-icons/ri"
import {
  devicePlatformOf,
  type ThreadDevice,
  type ThreadDevices,
  threadDeviceId,
  threadDeviceName,
} from "../../../../shared/device.ts"
import type { Thread } from "../../../../shared/domain.ts"
import { callPromise, threadDevicesAtom } from "../../../lib/rpc.ts"
import { m } from "../../../paraglide/messages.js"
import {
  DEVICE_LIST_TAB,
  deviceTabKey,
  selectAfterClosing,
  useDeviceTabs,
  useShownDeviceTab,
} from "../../../stores/deviceTabs.ts"
import { Button } from "../../ui/button.tsx"
import { DeleteDeviceDialog } from "./DeleteDeviceDialog.tsx"

const NO_DEVICES: ThreadDevices = []

export const deviceTabId = (threadId: string, tab: string) => `device-tab-${threadId}-${tab}`
export const devicePanelId = (threadId: string, tab: string) => `device-panel-${threadId}-${tab}`

/** Whether closing the tab deletes the simulator, because HinaCode created it for this thread. */
const deletes = (entry: ThreadDevice, threadId: string) =>
  entry.phase === "ready" ? entry.device.ownerThreadId === threadId : threadDeviceId(entry) === null

/**
 * The Devices view's header: a tab per device the thread drives, and a button that lists the machine's devices to
 * add one. Arrow keys switch tabs and Delete closes the focused one, as in the Browser view.
 */
export function DeviceTabStrip({ thread }: { thread: Thread }) {
  const threadId = thread.id
  const result = useAtomValue(threadDevicesAtom(threadId))
  const devices = AsyncResult.isSuccess(result) ? result.value : NO_DEVICES
  const shown = useShownDeviceTab(threadId, devices)
  const [deleting, setDeleting] = useState<ThreadDevice | null>(null)
  const keyboardMove = useRef(false)

  useEffect(() => {
    if (!keyboardMove.current) return
    keyboardMove.current = false
    document.getElementById(deviceTabId(threadId, shown))?.focus()
  }, [threadId, shown])

  const select = (tab: string) => useDeviceTabs.getState().select(threadId, tab)
  const detach = (entry: ThreadDevice) => {
    if (deviceTabKey(entry) === shown) selectAfterClosing(threadId, devices, shown)
    void callPromise("device.detach", { threadId, deviceId: threadDeviceId(entry) }).catch(() => {})
  }
  const close = (entry: ThreadDevice) => {
    if (deletes(entry, threadId) && entry.phase === "ready") setDeleting(entry)
    else detach(entry)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = devices.findIndex((entry) => deviceTabKey(entry) === shown)
    const entry = devices[index]
    if (event.key === "Delete" && entry) {
      event.preventDefault()
      keyboardMove.current = true
      close(entry)
      return
    }
    const target = {
      ArrowRight: devices[(index + 1) % devices.length],
      ArrowLeft: devices.at(index - 1),
      Home: devices[0],
      End: devices.at(-1),
    }[event.key]
    if (!target) return
    event.preventDefault()
    keyboardMove.current = true
    select(deviceTabKey(target))
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {devices.length === 0 ? (
        <span className="truncate px-1 text-sm font-medium">{m.panel_tab_devices()}</span>
      ) : (
        // oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- in the WAI-ARIA tabs pattern the tabs take focus, not the list.
        <div
          role="tablist"
          aria-label={m.devices_tabs()}
          onKeyDown={onKeyDown}
          className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {devices.map((entry) => (
            <DeviceTab
              key={deviceTabKey(entry)}
              threadId={threadId}
              entry={entry}
              selected={deviceTabKey(entry) === shown}
              onSelect={() => select(deviceTabKey(entry))}
              onClose={() => close(entry)}
            />
          ))}
        </div>
      )}
      <Button
        variant={shown === DEVICE_LIST_TAB ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label={m.devices_add()}
        aria-pressed={shown === DEVICE_LIST_TAB}
        title={m.devices_add()}
        onClick={() => select(DEVICE_LIST_TAB)}
      >
        <RiAddLine aria-hidden />
      </Button>
      <DeleteDeviceDialog
        name={deleting && threadDeviceName(deleting)}
        onCancel={() => setDeleting(null)}
        onDelete={() => {
          if (deleting) detach(deleting)
          setDeleting(null)
        }}
      />
    </div>
  )
}

interface DeviceTabProps {
  readonly threadId: string
  readonly entry: ThreadDevice
  readonly selected: boolean
  readonly onSelect: () => void
  readonly onClose: () => void
}

function DeviceTab({ threadId, entry, selected, onSelect, onClose }: DeviceTabProps) {
  const tab = deviceTabKey(entry)
  const name = threadDeviceName(entry)
  const id = threadDeviceId(entry)
  const PlatformIcon = id !== null && devicePlatformOf(id) === "android" ? RiAndroidLine : RiAppleLine
  const label = deletes(entry, threadId) ? m.devices_delete_tab({ name }) : m.devices_close_tab({ name })
  return (
    <div
      className={cn(
        "group relative flex h-8 max-w-52 min-w-24 shrink items-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        selected && "bg-muted text-foreground hover:bg-muted",
      )}
    >
      <button
        type="button"
        role="tab"
        id={deviceTabId(threadId, tab)}
        aria-selected={selected}
        aria-controls={devicePanelId(threadId, tab)}
        tabIndex={selected ? 0 : -1}
        title={name}
        onClick={onSelect}
        onAuxClick={(event) => {
          if (event.button === 1) onClose()
        }}
        className="pressable flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-7 pl-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {entry.phase === "preparing" ? (
          <RiLoader4Line aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : entry.phase === "failed" ? (
          <RiErrorWarningLine aria-hidden className="size-4 shrink-0 text-destructive" />
        ) : (
          <PlatformIcon aria-hidden className="size-4 shrink-0" />
        )}
        <span className="truncate">{name}</span>
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        title={label}
        onClick={onClose}
        className={cn(
          "absolute right-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground",
          !selected && "invisible group-hover:visible",
        )}
      >
        <RiCloseLine aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
