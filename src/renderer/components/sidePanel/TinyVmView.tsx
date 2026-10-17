import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { lazy, type ReactNode, Suspense, useEffect, useState, useTransition } from "react"
import type { IconType } from "react-icons"
import {
  RiComputerLine,
  RiErrorWarningLine,
  RiFullscreenLine,
  RiLoader4Line,
  RiPictureInPicture2Line,
  RiPictureInPictureExitLine,
  RiSave3Line,
} from "react-icons/ri"
import type { Thread, ThreadVm, VmControl, VmTemplate } from "../../../shared/domain.ts"
import { useThreadEnvironment } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, threadVmAtom, vmHostAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { useUi } from "../../stores/ui.ts"
import { ChordKeys } from "../ChordKeys.tsx"
import { HoldToConfirmButton } from "../HoldToConfirmButton.tsx"
import { Button } from "../ui/button.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx"
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

  // A desktop needs the room an editor gets.
  useEffect(() => {
    useUi.getState().setSidePanelWide(true)
    return () => useUi.getState().setSidePanelWide(false)
  }, [])

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

/** Copies dropped host paths into the VM through the caller's action runner, so errors land in its strip. */
export function useVmDrop(threadId: string, run: (action: () => Promise<unknown>) => void) {
  const [dropping, setDropping] = useState(false)
  const onDropFiles = (paths: ReadonlyArray<string>) => {
    setDropping(true)
    run(async () => {
      try {
        if (paths.length === 0) throw new Error(m.vm_drop_unsupported())
        await callPromise("vm.files.drop", { threadId, paths: [...paths] })
      } finally {
        setDropping(false)
      }
    })
  }
  return { dropping, onDropFiles }
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

const templateLabel = (template: VmTemplate) =>
  `${template.name} · ${String(Math.round((template.memoryMiB / 1024) * 10) / 10)} GiB`

interface VmTemplateSelectProps {
  readonly id: string
  readonly templates: ReadonlyArray<VmTemplate>
  readonly value: string
  readonly onChange: (name: string) => void
}

/** Picks among the templates the sbx host lists, keeping a configured name the host no longer has selectable. */
export function VmTemplateSelect({ id, templates, value, onChange }: VmTemplateSelectProps) {
  const listed = templates.map((template) => ({ value: template.name, label: templateLabel(template) }))
  const items = listed.some((item) => item.value === value) ? listed : [{ value, label: value }, ...listed]
  return (
    <Select items={items} value={value} onValueChange={(next) => typeof next === "string" && onChange(next)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function VmState({ threadId, vm }: { threadId: string; vm: ThreadVm }) {
  const { pending, error, run } = useVmAction()
  const start = () => run(() => callPromise("vm.start", { threadId }))

  switch (vm.status) {
    case "none":
      return <NoVm threadId={threadId} />
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

/** The empty state: what the VM is, which template to restore, and the button that starts it. */
function NoVm({ threadId }: { threadId: string }) {
  const { pending, error, run } = useVmAction()
  const environment = useThreadEnvironment(threadId)
  const { experimental } = useSettings(environment)
  const host = useAtomValue(vmHostAtom(environment))
  const [picked, setPicked] = useState<string | null>(null)
  const templates = AsyncResult.isSuccess(host) && host.value.status === "connected" ? host.value.templates : []
  const template = picked ?? experimental.tinyVmTemplate
  const start = () => run(() => callPromise("vm.start", { threadId, template }))

  return (
    <Centered>
      <RiComputerLine aria-hidden className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{m.vm_empty_title()}</h3>
        <p className="max-w-64 text-xs text-pretty text-muted-foreground">{m.vm_empty_body()}</p>
      </div>
      {templates.length > 1 && (
        <div className="flex w-56 flex-col gap-1.5 text-left">
          <label htmlFor={`vm-template-${threadId}`} className="text-xs text-muted-foreground">
            {m.vm_template_label()}
          </label>
          <VmTemplateSelect
            id={`vm-template-${threadId}`}
            templates={templates}
            value={template}
            onChange={setPicked}
          />
        </div>
      )}
      <Button variant="outline" size="sm" disabled={pending} onClick={start}>
        {m.vm_start()}
      </Button>
      <ActionError error={error} />
    </Centered>
  )
}

function Running({ threadId, vm }: { threadId: string; vm: RunningVm }) {
  const { pending, error, run } = useVmAction()
  const { dropping, onDropFiles } = useVmDrop(threadId, run)
  const floating = useUi((state) => state.vmPlacements[threadId] === "floating")
  const setPlacement = useUi((state) => state.setVmPlacement)
  const [attempt, setAttempt] = useState(0)
  const control = <ControlButton threadId={threadId} vm={vm} pending={pending} run={run} />

  return (
    <>
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <ControlStatus vm={vm} />
        {vm.profile === "owner" && (
          <IconAction
            icon={RiSave3Line}
            label={m.vm_profile_save()}
            onClick={() => run(() => callPromise("vm.profile.save", { threadId }))}
          />
        )}
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
        <HoldToConfirmButton disabled={pending} onConfirm={() => run(() => callPromise("vm.stop", { threadId }))}>
          {m.vm_stop()}
        </HoldToConfirmButton>
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
      {vm.profile === "copy" && (
        <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{m.vm_profile_copy_note()}</p>
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
              onDropFiles={onDropFiles}
              dropping={dropping}
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
