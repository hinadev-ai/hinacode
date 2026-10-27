import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useState } from "react"
import { RiCheckLine, RiCircleLine, RiErrorWarningLine, RiLoader4Line } from "react-icons/ri"
import type { PrepareStep, ThreadDevice } from "../../../../shared/device.ts"
import type { Thread } from "../../../../shared/domain.ts"
import { errorMessage } from "../../../lib/errorMessage.ts"
import { callPromise, threadDeviceAtom } from "../../../lib/rpc.ts"
import { m } from "../../../paraglide/messages.js"
import { Button } from "../../ui/button.tsx"
import { useVmAction } from "../TinyVmView.tsx"
import { DeviceList } from "./DeviceList.tsx"
import { DeviceReady } from "./DeviceReady.tsx"

/** The device the thread drives: the list to pick one from, its preparation, its live screen, or why it failed. */
export function DevicesView({ thread }: { thread: Thread }) {
  const device = useAtomValue(threadDeviceAtom(thread.id))
  const refresh = useAtomRefresh(threadDeviceAtom(thread.id))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {AsyncResult.builder(device)
        .onInitial(() => null)
        .onSuccess((state) => <DeviceState thread={thread} device={state} />)
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

function DeviceState({ thread, device }: { thread: Thread; device: ThreadDevice }) {
  switch (device.phase) {
    case "none":
      return <DeviceList thread={thread} />
    case "preparing":
      return <Preparing step={device.step} />
    case "ready":
      return <DeviceReady key={device.device.id} threadId={thread.id} device={device} />
    case "failed":
      return <Failed threadId={thread.id} device={device} />
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
  done: <RiCheckLine aria-hidden className="size-4 shrink-0 text-success" />,
  running: <RiLoader4Line aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />,
  pending: <RiCircleLine aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
}

/** Booting and connecting happen on every run. Creating and slimming only show once the run has reached them. */
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

function Failed({ threadId, device }: { threadId: string; device: Extract<ThreadDevice, { phase: "failed" }> }) {
  const { pending, error, run } = useVmAction()
  const { deviceId } = device
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
          onClick={() => run(() => callPromise("device.detach", { threadId }))}
        >
          {m.devices_back_to_list()}
        </Button>
      </div>
    </Failure>
  )
}

function Failure({ title, message, children }: { title?: string; message: string; children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <RiErrorWarningLine aria-hidden className="size-6 text-destructive" />
      <div role="alert" className="flex flex-col gap-1">
        {title && <h3 className="text-sm font-medium">{title}</h3>}
        <p className="max-w-80 font-mono text-xs break-words text-muted-foreground">{message}</p>
      </div>
      {children}
    </div>
  )
}
