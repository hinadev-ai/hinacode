import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useState } from "react"
import { devicePlatformOf, type PrepareStep, type ThreadDevice, type ThreadDevices } from "../../../../shared/device.ts"
import type { Thread } from "../../../../shared/domain.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { callPromise, threadDevicesAtom } from "../../../lib/rpc.ts"
import { m } from "../../../paraglide/messages.js"
import { DEVICE_LIST_TAB, deviceTabKey, selectAfterClosing, useShownDeviceTab } from "../../../stores/deviceTabs.ts"
import { Button } from "../../ui/button.tsx"
import { useVmAction } from "../TinyVmView.tsx"
import { DeleteDeviceDialog } from "./DeleteDeviceDialog.tsx"
import { DeviceList } from "./DeviceList.tsx"
import { DeviceReady } from "./DeviceReady.tsx"
import { devicePanelId, deviceTabId } from "./DeviceTabStrip.tsx"
import { CheckIcon } from "../../icons/CheckIcon.tsx"
import { CircleIcon } from "../../icons/CircleIcon.tsx"
import { SpinnerIcon } from "../../icons/SpinnerIcon.tsx"
import { WarningIcon } from "../../icons/WarningIcon.tsx"

export function DevicesView({ thread }: { thread: Thread }) {
  const devices = useAtomValue(threadDevicesAtom(thread.id))
  const refresh = useAtomRefresh(threadDevicesAtom(thread.id))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {AsyncResult.builder(devices)
        .onInitial(() => null)
        .onSuccess((entries) => <ShownTab thread={thread} devices={entries} />)
        .onError((cause) => (
          <Failure message={errorMessage(cause)}>
            <Button variant="outline" size="sm" onClick={refresh}>
              {m.common_retry()}
            </Button>
          </Failure>
        ))
        .orElse(() => null)}
    </div>
  )
}

function ShownTab({ thread, devices }: { thread: Thread; devices: ThreadDevices }) {
  const shown = useShownDeviceTab(thread.id, devices)
  const entry = devices.find((each) => deviceTabKey(each) === shown)
  if (shown === DEVICE_LIST_TAB || !entry) return <DeviceList thread={thread} />
  return (
    <div
      role="tabpanel"
      id={devicePanelId(thread.id, shown)}
      aria-labelledby={deviceTabId(thread.id, shown)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DeviceState
        key={shown}
        threadId={thread.id}
        device={entry}
        onDetach={() => selectAfterClosing(thread.id, devices, shown)}
      />
    </div>
  )
}

interface DeviceStateProps {
  readonly threadId: string
  readonly device: ThreadDevice
  readonly onDetach: () => void
}

function DeviceState({ threadId, device, onDetach }: DeviceStateProps) {
  switch (device.phase) {
    case "preparing":
      return <Preparing step={device.step} />
    case "ready":
      return <DeviceReady threadId={threadId} device={device} onDetach={onDetach} />
    case "failed":
      return <Failed threadId={threadId} device={device} onDetach={onDetach} />
  }
}

const stepOrder: ReadonlyArray<PrepareStep> = ["creating", "slimming", "booting", "connecting"]

const stepLabel: Record<PrepareStep, () => string> = {
  creating: m.devices_step_creating,
  slimming: m.devices_step_slimming,
  booting: m.devices_step_booting,
  connecting: m.devices_step_connecting,
}

type StepState = "done" | "running" | "pending"

const stepIcon: Record<StepState, ReactNode> = {
  done: <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />,
  running: <SpinnerIcon aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />,
  pending: <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
}

function Preparing({ step }: { step: PrepareStep }) {
  const [seen, setSeen] = useState<ReadonlyArray<PrepareStep>>([step])
  if (!seen.includes(step)) setSeen([...seen, step])
  const current = stepOrder.indexOf(step)
  const steps = stepOrder.filter((each) => each === "booting" || each === "connecting" || seen.includes(each))

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <ol aria-label={m.devices_preparing()} className="flex flex-col gap-3">
        {steps.map((each) => {
          const index = stepOrder.indexOf(each)
          const state: StepState = index < current ? "done" : index === current ? "running" : "pending"
          return (
            <li
              key={each}
              aria-current={state === "running" ? "step" : undefined}
              className="flex items-center gap-2.5"
            >
              {stepIcon[state]}
              <span className={state === "pending" ? "text-sm text-muted-foreground" : "text-sm"}>
                {stepLabel[each]()}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="max-w-64 text-center text-xs text-pretty text-muted-foreground">
        {step === "connecting" ? m.devices_compiling_hint() : m.devices_first_boot_hint()}
      </p>
    </div>
  )
}

interface FailedProps {
  readonly threadId: string
  readonly device: Extract<ThreadDevice, { phase: "failed" }>
  readonly onDetach: () => void
}

function Failed({ threadId, device, onDetach }: FailedProps) {
  const { pending, error, run } = useVmAction()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const { deviceId } = device
  const deletes = device.owned && deviceId !== null
  const detach = () =>
    run(async () => {
      await callPromise("device.detach", { threadId, deviceId })
      onDetach()
    })
  const retry = () =>
    run(() =>
      deviceId === null
        ? callPromise("device.create", { threadId })
        : callPromise("device.attach", { threadId, deviceId }),
    )
  return (
    <Failure title={m.devices_failed_title()} message={error ?? device.message}>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={pending} onClick={retry}>
          {m.common_retry()}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => (deletes ? setConfirmingDelete(true) : detach())}
        >
          {deletes ? m.devices_delete() : m.devices_remove()}
        </Button>
      </div>
      <DeleteDeviceDialog
        device={
          confirmingDelete && deviceId !== null
            ? { name: device.name, platform: devicePlatformOf(deviceId), owned: true }
            : null
        }
        onCancel={() => setConfirmingDelete(false)}
        onDelete={() => {
          setConfirmingDelete(false)
          detach()
        }}
      />
    </Failure>
  )
}

function Failure({ title, message, children }: { title?: string; message: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <WarningIcon aria-hidden className="size-6 text-destructive" />
      <div role="alert" className="flex flex-col gap-1">
        {title && <h3 className="text-sm font-medium">{title}</h3>}
        <p className="max-w-80 font-mono text-xs wrap-break-word text-muted-foreground">{message}</p>
      </div>
      {children}
    </div>
  )
}
