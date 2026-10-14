import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { lazy, type ReactNode, Suspense, useState, useTransition } from "react"
import type { IconType } from "react-icons"
import {
  RiComputerLine,
  RiErrorWarningLine,
  RiFullscreenLine,
  RiLoader4Line,
  RiPictureInPicture2Line,
  RiPictureInPictureExitLine,
} from "react-icons/ri"
import type { Thread, ThreadVm, VmControl } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, threadVmAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useUi } from "../../stores/ui.ts"
import { ChordKeys } from "../ChordKeys.tsx"
import { Button } from "../ui/button.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx"

export const TinyVmScreen = lazy(() => import("./TinyVmScreen.tsx"))

/** Hands control back from inside the screen, where noVNC takes every other key. */
export const HAND_BACK_CHORD = "Mod+Escape"

/** A thread shows its screen in one place at a time, so the id is unique in the document. */
export const vmScreenId = (threadId: string) => `tiny-vm-screen-${threadId}`

export const showVmFullscreen = (threadId: string) =>
  void document.getElementById(vmScreenId(threadId))?.requestFullscreen()

export type RunningVm = Extract<ThreadVm, { status: "running" }>

/** The thread's tiny VM: its live screen, who controls it, and starting or stopping it. */
export function TinyVmView({ thread }: { thread: Thread }) {
  const vm = useAtomValue(threadVmAtom(thread.id))
  const refresh = useAtomRefresh(threadVmAtom(thread.id))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {AsyncResult.builder(vm)
        .onInitial(() => null)
        .onSuccess((state) => <VmState threadId={thread.id} vm={state} />)
        .onError((cause) => <Failure message={errorMessage(cause)} retry={m.sidebar_retry()} onRetry={refresh} />)
        .orElse(() => null)}
    </div>
  )
}

/** Runs one rpc at a time and keeps its error for display. */
export function useVmAction() {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) =>
    startTransition(async () => {
      setError(null)
      try {
        await action()
      } catch (cause) {
        setError(errorMessage(cause))
      }
    })
  return { pending, error, run }
}

function VmState({ threadId, vm }: { threadId: string; vm: ThreadVm }) {
  const { pending, error, run } = useVmAction()
  const start = () => run(() => callPromise("vm.start", { threadId }))

  switch (vm.status) {
    case "none":
      return (
        <Centered>
          <RiComputerLine aria-hidden className="size-6 text-muted-foreground" />
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">{m.vm_empty_title()}</h3>
            <p className="max-w-64 text-xs text-pretty text-muted-foreground">{m.vm_empty_body()}</p>
          </div>
          <Button variant="outline" size="sm" disabled={pending} onClick={start}>
            {m.vm_start()}
          </Button>
          <ActionError error={error} />
        </Centered>
      )
    case "starting":
      return <Spinner label={m.vm_starting()} />
    case "failed":
      return (
        <Failure
          title={m.vm_failed_title()}
          message={error ?? vm.message}
          retry={m.vm_retry()}
          pending={pending}
          onRetry={start}
        />
      )
    case "running":
      return <Running threadId={threadId} vm={vm} />
  }
}

function Running({ threadId, vm }: { threadId: string; vm: RunningVm }) {
  const { pending, error, run } = useVmAction()
  const floating = useUi((state) => state.vmPlacements[threadId] === "floating")
  const setPlacement = useUi((state) => state.setVmPlacement)
  const [attempt, setAttempt] = useState(0)
  const control = <ControlButton threadId={threadId} vm={vm} pending={pending} run={run} />

  return (
    <>
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <ControlStatus vm={vm} />
        {control}
        {!floating && (
          <>
            <IconAction
              icon={RiPictureInPicture2Line}
              label={m.vm_float()}
              onClick={() => setPlacement(threadId, "floating")}
            />
            <IconAction icon={RiFullscreenLine} label={m.vm_fullscreen()} onClick={() => showVmFullscreen(threadId)} />
          </>
        )}
        <StopButton disabled={pending} onStop={() => run(() => callPromise("vm.stop", { threadId }))} />
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
      {floating ? (
        <Centered>
          <RiPictureInPicture2Line aria-hidden className="size-6 text-muted-foreground" />
          <p className="max-w-64 text-sm text-pretty">{m.vm_floating_body()}</p>
          <Button variant="outline" size="sm" onClick={() => setPlacement(threadId, "panel")}>
            <RiPictureInPictureExitLine aria-hidden />
            {m.vm_dock()}
          </Button>
        </Centered>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <Suspense fallback={<ScreenFallback />}>
            <TinyVmScreen
              key={`${vm.sandboxId}:${attempt}`}
              threadId={threadId}
              control={vm.control}
              fullscreenControls={control}
              onHandBack={() => run(() => callPromise("vm.control", { threadId, control: "agent" }))}
              onReconnect={() => setAttempt((count) => count + 1)}
            />
          </Suspense>
        </div>
      )}
    </>
  )
}

/** Who drives the VM, in amber when the agent is waiting for the user to hand it back. */
export function ControlStatus({ vm }: { vm: RunningVm }) {
  const waiting = vm.control === "user" && vm.agentWaiting
  const label = waiting ? m.vm_agent_waiting() : vm.control === "user" ? m.vm_control_user() : m.vm_control_agent()
  return (
    <p
      aria-live="polite"
      title={label}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 text-xs",
        waiting ? "font-medium text-attention" : vm.control === "user" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {waiting && <RiErrorWarningLine aria-hidden className="size-3.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </p>
  )
}

interface ControlButtonProps {
  readonly threadId: string
  readonly vm: RunningVm
  readonly pending: boolean
  readonly run: (action: () => Promise<unknown>) => void
}

/** One element for both labels, so focus stays on it when control changes hands. */
export function ControlButton({ threadId, vm, pending, run }: ControlButtonProps) {
  const setControl = (control: VmControl) => run(() => callPromise("vm.control", { threadId, control }))
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={pending}
      onClick={() => setControl(vm.control === "agent" ? "user" : "agent")}
    >
      {vm.control === "agent" ? (
        m.vm_take_control()
      ) : (
        <>
          {m.vm_hand_back()}
          <ChordKeys chord={HAND_BACK_CHORD} />
        </>
      )}
    </Button>
  )
}

interface IconActionProps {
  readonly icon: IconType
  readonly label: string
  readonly onClick: () => void
}

export function IconAction({ icon: Icon, label, onClick }: IconActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} />}>
        <Icon aria-hidden />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ScreenFallback() {
  return (
    <div className="flex aspect-[16/10] w-full items-center justify-center rounded-md bg-muted">
      <Spinner label={m.vm_connecting()} />
    </div>
  )
}

/** Stopping destroys the sandbox, so it takes two clicks: the first arms the button. */
function StopButton({ disabled, onStop }: { disabled: boolean; onStop: () => void }) {
  const [armed, setArmed] = useState(false)
  return (
    <Button
      variant={armed ? "destructive" : "ghost"}
      size="xs"
      disabled={disabled}
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        onStop()
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? m.vm_stop_confirm() : m.vm_stop()}
    </Button>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">{children}</div>
}

export function Spinner({ label }: { label: string }) {
  return (
    <output className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      <RiLoader4Line aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
      {label}
    </output>
  )
}

interface FailureProps {
  readonly title?: string
  readonly message: string
  readonly retry: string
  readonly pending?: boolean
  readonly onRetry: () => void
}

function Failure({ title, message, retry, pending = false, onRetry }: FailureProps) {
  return (
    <Centered>
      <RiErrorWarningLine aria-hidden className="size-6 text-destructive" />
      <div role="alert" className="flex flex-col gap-1">
        {title && <h3 className="text-sm font-medium">{title}</h3>}
        <p className="max-w-80 font-mono text-xs break-words text-muted-foreground">{message}</p>
      </div>
      <Button variant="outline" size="sm" disabled={pending} onClick={onRetry}>
        {retry}
      </Button>
    </Centered>
  )
}

function ActionError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="max-w-80 text-xs text-destructive">
      {error}
    </p>
  )
}
