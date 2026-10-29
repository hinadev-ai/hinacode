import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { RiAddLine, RiArrowDownSLine, RiDeleteBinLine, RiRefreshLine } from "react-icons/ri"
import {
  type Device,
  type DeviceHost,
  type DevicePlatform,
  type PlatformSupport,
  type SimulatorModel,
  threadDeviceId,
} from "../../../../shared/device.ts"
import type { Thread } from "../../../../shared/domain.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { callPromise, deviceHostAtom, threadDevicesAtom } from "../../../lib/rpc.ts"
import { m } from "../../../paraglide/messages.js"
import { getLocale } from "../../../paraglide/runtime.js"
import { useDeviceTabs } from "../../../stores/deviceTabs.ts"
import { CopyButton } from "../../CopyButton.tsx"
import { Badge } from "../../ui/badge.tsx"
import { Button } from "../../ui/button.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu.tsx"
import { SkeletonList } from "../../ui/skeleton.tsx"
import { IconAction, useVmAction } from "../TinyVmView.tsx"
import { DeleteDeviceDialog } from "./DeleteDeviceDialog.tsx"

const SIMSLIM_INSTALL = "brew install mobai-app/tap/simslim"

const stateOrder: Record<Device["state"], number> = { booted: 0, booting: 1, shutdown: 2 }

const byState = (a: Device, b: Device) => stateOrder[a.state] - stateOrder[b.state] || a.name.localeCompare(b.name)

const formatMemory = (bytes: number) =>
  new Intl.NumberFormat(getLocale(), { style: "unit", unit: "gigabyte", maximumFractionDigits: 1 }).format(
    bytes / 1024 ** 3,
  )

/** The thread machine's simulators and emulators, and the button that makes one for this thread. */
export function DeviceList({ thread }: { thread: Thread }) {
  const host = useAtomValue(deviceHostAtom(thread.id))
  const refresh = useAtomRefresh(deviceHostAtom(thread.id))
  const { pending, error, run } = useVmAction()
  const loaded = AsyncResult.isSuccess(host) ? host.value : null
  const iosReady = loaded?.ios.kind === "ready"
  const threadDevices = useAtomValue(threadDevicesAtom(thread.id))
  const attached = new Set(
    AsyncResult.isSuccess(threadDevices) ? threadDevices.value.map(threadDeviceId).filter((id) => id !== null) : [],
  )
  const select = (tab: string) => useDeviceTabs.getState().select(thread.id, tab)
  const attach = (device: Device) => {
    select(device.id)
    if (!attached.has(device.id)) run(() => callPromise("device.attach", { threadId: thread.id, deviceId: device.id }))
  }
  const [deleting, setDeleting] = useState<Device | null>(null)
  const remove = (device: Device) =>
    run(async () => {
      await callPromise("device.delete", { threadId: thread.id, deviceId: device.id })
      refresh()
    })
  const create = (model: SimulatorModel) => {
    select("new")
    run(async () => {
      const created = await callPromise("device.create", {
        threadId: thread.id,
        model: { deviceType: model.deviceType, runtime: model.runtime },
      })
      const deviceId = threadDeviceId(created)
      if (deviceId && useDeviceTabs.getState().selected[thread.id] === "new") select(deviceId)
    })
  }

  return (
    <div className="flex min-h-0 flex-1 animate-fade-in flex-col overflow-y-auto motion-reduce:animate-none">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {iosReady && loaded.models.length > 0 && (
          <NewSimulatorMenu models={loaded.models} disabled={pending} onCreate={create} />
        )}
        <div className="flex-1" />
        <IconAction icon={RiRefreshLine} label={m.devices_refresh()} onClick={refresh} disabled={host.waiting} />
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
      {loaded && iosReady && !loaded.simslim && <SimslimNote />}
      {AsyncResult.builder(host)
        .onInitial(() => <SkeletonList label={m.devices_loading()} rows={3} rowClassName="h-10" className="p-3" />)
        .onSuccess((value) => (
          <>
            <PlatformSection
              platform="ios"
              host={value}
              threadId={thread.id}
              attached={attached}
              pending={pending}
              onAttach={attach}
              onDelete={setDeleting}
            />
            <PlatformSection
              platform="android"
              host={value}
              threadId={thread.id}
              attached={attached}
              pending={pending}
              onAttach={attach}
              onDelete={setDeleting}
            />
          </>
        ))
        .onError((cause) => (
          <div role="alert" className="flex flex-col items-start gap-2 p-3">
            <p className="text-xs text-destructive">{m.devices_list_failed({ message: errorMessage(cause) })}</p>
            <Button variant="outline" size="xs" disabled={host.waiting} onClick={refresh}>
              {m.common_retry()}
            </Button>
          </div>
        ))
        .orElse(() => null)}
      <DeleteDeviceDialog
        device={
          deleting && { name: deleting.name, platform: deleting.platform, owned: deleting.ownerThreadId === thread.id }
        }
        onCancel={() => setDeleting(null)}
        onDelete={() => {
          if (deleting) remove(deleting)
          setDeleting(null)
        }}
      />
    </div>
  )
}

/** Every model the machine can run, grouped by family as the runtime lists them, newest first. */
function NewSimulatorMenu({
  models,
  disabled,
  onCreate,
}: {
  models: ReadonlyArray<SimulatorModel>
  disabled: boolean
  onCreate: (model: SimulatorModel) => void
}) {
  const families = Map.groupBy(models, (model) => model.family)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="sm" disabled={disabled}>
            <RiAddLine aria-hidden />
            {m.devices_new_simulator()}
            <RiArrowDownSLine aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent className="w-72">
        {[...families].map(([family, members]) => (
          <DropdownMenuGroup key={family}>
            {family && <DropdownMenuLabel>{family}</DropdownMenuLabel>}
            {members.map((model) => (
              <DropdownMenuItem key={model.deviceType} onClick={() => onCreate(model)}>
                <span className="min-w-0 flex-1 truncate">{model.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {m.devices_model_os({ version: model.osVersion })}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SimslimNote() {
  return (
    <div className="flex flex-col gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
      <p>{m.devices_simslim_note()}</p>
      <div className="flex items-center gap-1">
        <code className="min-w-0 truncate font-mono text-foreground">{SIMSLIM_INSTALL}</code>
        <CopyButton value={SIMSLIM_INSTALL} label={m.devices_simslim_copy()} />
      </div>
    </div>
  )
}

const supportMessage = (support: PlatformSupport) => {
  switch (support.kind) {
    case "ready":
      return null
    case "unsupported":
      return m.devices_ios_not_mac()
    case "missing":
      return support.tool === "xcode" ? m.devices_missing_xcode() : m.devices_missing_android_sdk()
  }
}

interface PlatformSectionProps {
  readonly platform: DevicePlatform
  readonly host: DeviceHost
  readonly threadId: string
  /** The devices this thread already has a tab for. */
  readonly attached: ReadonlySet<string>
  readonly pending: boolean
  readonly onAttach: (device: Device) => void
  readonly onDelete: (device: Device) => void
}

function PlatformSection({ platform, host, threadId, attached, pending, onAttach, onDelete }: PlatformSectionProps) {
  const support = host[platform]
  const unavailable = supportMessage(support)
  const devices = host.devices.filter((device) => device.platform === platform).toSorted(byState)
  const running = devices.filter((device) => device.state !== "shutdown")
  const shutdown = devices.filter((device) => device.state === "shutdown")
  const [showShutdown, setShowShutdown] = useState(false)
  const shown = showShutdown || running.length === 0 ? devices : running
  const titleId = `devices-${platform}-${threadId}`

  return (
    <section aria-labelledby={titleId} className="flex flex-col border-b border-border py-2">
      <h3 id={titleId} className="px-3 py-1 text-xs font-medium text-muted-foreground">
        {platform === "ios" ? m.devices_ios() : m.devices_android()}
      </h3>
      {unavailable ? (
        <p className="px-3 py-1 text-xs text-pretty">{unavailable}</p>
      ) : devices.length === 0 ? (
        <p className="px-3 py-1 text-xs text-pretty text-muted-foreground">
          {platform === "ios" ? m.devices_ios_empty() : m.devices_android_empty()}
        </p>
      ) : (
        <>
          <ul className="flex flex-col">
            {shown.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                threadId={threadId}
                attached={attached.has(device.id)}
                pending={pending}
                onAttach={() => onAttach(device)}
                onDelete={() => onDelete(device)}
              />
            ))}
          </ul>
          {running.length > 0 && shutdown.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              className="mx-2 self-start text-muted-foreground"
              aria-expanded={showShutdown}
              onClick={() => setShowShutdown((open) => !open)}
            >
              {showShutdown ? m.devices_hide_shutdown() : m.devices_show_shutdown({ count: shutdown.length })}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

const stateLabel: Record<Device["state"], () => string> = {
  booted: m.devices_state_booted,
  booting: m.devices_state_booting,
  shutdown: m.devices_state_shutdown,
}

interface DeviceRowProps {
  readonly device: Device
  readonly threadId: string
  readonly attached: boolean
  readonly pending: boolean
  readonly onAttach: () => void
  readonly onDelete: () => void
}

function DeviceRow({ device, threadId, attached, pending, onAttach, onDelete }: DeviceRowProps) {
  const { slim } = device
  // Archiving the thread that created it deletes it, so another thread cannot lean on it.
  const anotherThreads = device.ownerThreadId !== null && device.ownerThreadId !== threadId
  const fullySlim = slim !== null && slim.total > 0 && slim.disabled === slim.total
  return (
    <li className="flex items-center gap-3 px-3 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm" title={device.name}>
            {device.name}
          </span>
          {fullySlim && (
            <Badge variant="secondary" title={m.devices_slim_tooltip({ count: slim.disabled })}>
              {m.devices_slim()}
            </Badge>
          )}
          {device.ownerThreadId !== null && (
            <Badge variant="outline">
              {device.ownerThreadId === threadId ? m.devices_this_thread() : m.devices_another_thread()}
            </Badge>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="truncate">{device.osVersion}</span>
          <span className="flex shrink-0 items-center gap-1">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                device.state === "booted" && "bg-success",
                device.state === "booting" && "border border-success",
                device.state === "shutdown" && "border border-muted-foreground",
              )}
            />
            {stateLabel[device.state]()}
          </span>
          {device.memoryBytes !== null && <span className="shrink-0">{formatMemory(device.memoryBytes)}</span>}
        </div>
      </div>
      <Button
        variant="outline"
        size="xs"
        disabled={pending || anotherThreads}
        title={anotherThreads ? m.devices_owned_elsewhere() : undefined}
        aria-label={
          attached ? m.devices_show_label({ name: device.name }) : m.devices_attach_label({ name: device.name })
        }
        onClick={onAttach}
      >
        {attached ? m.devices_show() : m.devices_attach()}
      </Button>
      <IconAction
        icon={RiDeleteBinLine}
        label={m.devices_delete_tab({ name: device.name })}
        onClick={onDelete}
        disabled={pending || anotherThreads}
      />
    </li>
  )
}
