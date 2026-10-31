import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { RiAndroidLine, RiAppleLine } from "react-icons/ri"
import {
  devicePlatformOf,
  type ThreadDevice,
  type ThreadDevices,
  threadDeviceId,
  threadDeviceName,
  threadDeviceOwned,
} from "../../../../shared/device.ts"
import type { Thread } from "../../../../shared/domain.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
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
import { CloseIcon } from "../../icons/CloseIcon.tsx"
import { PlusIcon } from "../../icons/PlusIcon.tsx"
import { SpinnerIcon } from "../../icons/SpinnerIcon.tsx"
import { WarningIcon } from "../../icons/WarningIcon.tsx"

const NO_DEVICES: ThreadDevices = []

const platformOf = (entry: ThreadDevice) => {
  const id = threadDeviceId(entry)
  return id === null ? "ios" : devicePlatformOf(id)
}

export const deviceTabId = (threadId: string, tab: string) => `device-tab-${threadId}-${tab}`
export const devicePanelId = (threadId: string, tab: string) => `device-panel-${threadId}-${tab}`

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
    const name = threadDeviceName(entry)
    callPromise("device.detach", { threadId, deviceId: threadDeviceId(entry) })
      .then(() => {
        if (deviceTabKey(entry) === shown) selectAfterClosing(threadId, devices, shown)
      })
      .catch((cause: unknown) => toast.error(m.devices_detach_failed({ name, message: errorMessage(cause) })))
  }
  const close = (entry: ThreadDevice) => {
    if (threadDeviceOwned(entry)) setDeleting(entry)
    else {
      keyboardMove.current = true
      detach(entry)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = devices.findIndex((entry) => deviceTabKey(entry) === shown)
    const entry = devices[index]
    if (event.key === "Delete" && entry) {
      event.preventDefault()
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
          {devices.map((entry, index) => (
            <DeviceTab
              key={deviceTabKey(entry)}
              threadId={threadId}
              entry={entry}
              selected={deviceTabKey(entry) === shown}
              focusable={deviceTabKey(entry) === shown || (shown === DEVICE_LIST_TAB && index === 0)}
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
        <PlusIcon aria-hidden />
      </Button>
      <DeleteDeviceDialog
        device={deleting && { name: threadDeviceName(deleting), platform: platformOf(deleting), owned: true }}
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
  readonly focusable: boolean
  readonly onSelect: () => void
  readonly onClose: () => void
}

function DeviceTab({ threadId, entry, selected, focusable, onSelect, onClose }: DeviceTabProps) {
  const tab = deviceTabKey(entry)
  const name = threadDeviceName(entry)
  const id = threadDeviceId(entry)
  const PlatformIcon = id !== null && devicePlatformOf(id) === "android" ? RiAndroidLine : RiAppleLine
  const label = threadDeviceOwned(entry) ? m.devices_delete_tab({ name }) : m.devices_close_tab({ name })
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
        tabIndex={focusable ? 0 : -1}
        title={name}
        onClick={onSelect}
        onAuxClick={(event) => {
          if (event.button === 1) onClose()
        }}
        className="pressable flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-7 pl-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {entry.phase === "preparing" ? (
          <SpinnerIcon aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : entry.phase === "failed" ? (
          <WarningIcon aria-hidden className="size-4 shrink-0 text-destructive" />
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
        <CloseIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}
