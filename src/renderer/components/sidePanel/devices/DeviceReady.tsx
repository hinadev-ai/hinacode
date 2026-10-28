import { cn } from "cn"
import { Schema } from "effect"
import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import {
  RiArrowGoBackLine,
  RiCursorLine,
  RiErrorWarningLine,
  RiHome5Line,
  RiLinkM,
  RiLockLine,
  RiMoonLine,
  RiMore2Line,
  RiStackLine,
  RiSunLine,
  RiVolumeDownLine,
  RiVolumeUpLine,
  RiAnticlockwise2Line,
} from "react-icons/ri"
import {
  DeviceCommand,
  type DeviceButton,
  type DeviceElement,
  type DeviceScreen as Screen,
  type ThreadDevice,
} from "../../../../shared/device.ts"
import { deviceElementLabel } from "../../../lib/elementPicker.ts"
import { callPromise } from "../../../lib/rpc.ts"
import { m } from "../../../paraglide/messages.js"
import { useDrafts } from "../../../stores/drafts.ts"
import { useUi } from "../../../stores/ui.ts"
import { Button } from "../../ui/button.tsx"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu.tsx"
import { Input } from "../../ui/input.tsx"
import { Popover, PopoverContent, PopoverDescription, PopoverTrigger } from "../../ui/popover.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx"
import { IconAction, useVmAction } from "../TinyVmView.tsx"
import { DeleteDeviceDialog } from "./DeleteDeviceDialog.tsx"
import { DeviceSession, type FrameShape } from "./deviceSession.ts"
import { DeviceScreen } from "./DeviceScreen.tsx"

type ReadyDevice = Extract<ThreadDevice, { phase: "ready" }>
type Appearance = "light" | "dark"

const appearanceKey = (deviceId: string) => `hinacode.deviceAppearance.${deviceId}`

const isCommand = Schema.is(DeviceCommand)

const PICK_PADDING = 4

/**
 * Crops `element` from the canvas, or returns the whole screen. Element frames are in points of the screen as it
 * shows, so a landscape frame maps its x onto the long side.
 */
function cropScreen(canvas: HTMLCanvasElement, screen: Screen, shape: FrameShape, element: DeviceElement | null) {
  const long = Math.max(screen.width, screen.height)
  const short = Math.min(screen.width, screen.height)
  const landscape = shape.orientation === "landscape"
  const scaleX = canvas.width / (landscape ? long : short)
  const scaleY = canvas.height / (landscape ? short : long)
  let rect = { x: 0, y: 0, width: canvas.width, height: canvas.height }
  if (element) {
    const { frame } = element
    const left = Math.max(0, Math.floor(frame.x * scaleX - PICK_PADDING))
    const top = Math.max(0, Math.floor(frame.y * scaleY - PICK_PADDING))
    const right = Math.min(canvas.width, Math.ceil((frame.x + frame.width) * scaleX + PICK_PADDING))
    const bottom = Math.min(canvas.height, Math.ceil((frame.y + frame.height) * scaleY + PICK_PADDING))
    if (right - left >= 1 && bottom - top >= 1) rect = { x: left, y: top, width: right - left, height: bottom - top }
  }
  const crop = document.createElement("canvas")
  crop.width = rect.width
  crop.height = rect.height
  crop.getContext("2d")?.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  return crop.toDataURL("image/png")
}

/** The live device: its toolbar, its screen, and who has control. */
interface DeviceReadyProps {
  readonly threadId: string
  readonly device: ReadyDevice
  /** Called once the user detached or deleted the device, to show another tab. */
  readonly onDetach: () => void
}

export function DeviceReady({ threadId, device: ready, onDetach }: DeviceReadyProps) {
  const { device, screen, control, agentWaiting } = ready
  const { pending, error, run } = useVmAction()
  const [commandError, setCommandError] = useState<string | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
  const [shape, setShape] = useState<FrameShape | null>(null)
  const [stalled, setStalled] = useState(false)
  const [picking, setPicking] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [appearance, setAppearance] = useState<Appearance>(() =>
    localStorage.getItem(appearanceKey(device.id)) === "dark" ? "dark" : "light",
  )
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sessionRef = useRef<DeviceSession | null>(null)
  const controlRef = useRef(control)
  const hintId = useId()
  const owned = device.ownerThreadId === threadId
  const deviceId = device.id

  useEffect(() => {
    const session = new DeviceSession(threadId, deviceId, {
      onShape: setShape,
      onStalled: setStalled,
      onCommandError: setCommandError,
      onFrameError: setFrameError,
    })
    session.setCanvas(canvasRef.current)
    sessionRef.current = session
    const update = () => session.setVisible(document.visibilityState === "visible")
    update()
    document.addEventListener("visibilitychange", update)
    return () => {
      document.removeEventListener("visibilitychange", update)
      session.dispose()
      sessionRef.current = null
    }
  }, [threadId, deviceId])

  useEffect(() => {
    controlRef.current = control
  }, [control])

  // Closing the view hands the device back, so the agent never waits on a screen nobody watches.
  useEffect(
    () => () => {
      if (controlRef.current === "user") {
        void callPromise("device.control", { threadId, deviceId, control: "agent" }).catch(() => {})
      }
    },
    [threadId, deviceId],
  )

  const onCanvas = (canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas
    sessionRef.current?.setCanvas(canvas)
  }

  const send = (command: DeviceCommand) => {
    setCommandError(null)
    sessionRef.current?.command(command)
  }
  const press = (button: DeviceButton) => send({ kind: "button", button })

  const toggleAppearance = () => {
    const next: Appearance = appearance === "dark" ? "light" : "dark"
    setAppearance(next)
    localStorage.setItem(appearanceKey(device.id), next)
    send({ kind: "appearance", mode: next })
  }

  const pick = (x: number, y: number) =>
    run(async () => {
      try {
        const picked = await callPromise("device.pick", { threadId, deviceId, x, y })
        const canvas = canvasRef.current
        if (!canvas || !shape) return
        const label = picked ? deviceElementLabel(picked.element) : m.devices_pick_screen({ device: device.name })
        const staged = await callPromise("attachments.stage", {
          threadId,
          source: { dataUrl: cropScreen(canvas, screen, shape, picked?.element ?? null), name: `${label}.png` },
        })
        useDrafts.getState().addAttachments(threadId, [picked ? { ...staged, deviceElement: picked } : staged])
        setAnnouncement(m.devices_pick_added({ element: label }))
        useUi.getState().requestComposerFocus()
      } finally {
        setPicking(false)
      }
    })

  const detach = () =>
    run(async () => {
      await callPromise("device.detach", { threadId, deviceId })
      onDetach()
    })
  const waiting = control === "user" && agentWaiting
  const status = waiting
    ? m.devices_agent_waiting()
    : control === "user"
      ? m.devices_control_user()
      : m.devices_control_agent()
  const shownError = error ?? commandError ?? frameError

  return (
    <div className="flex min-h-0 flex-1 animate-fade-in flex-col motion-reduce:animate-none">
      <div
        role="toolbar"
        aria-label={m.devices_toolbar({ name: device.name })}
        className="flex min-h-10 shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1.5"
      >
        <IconAction icon={RiHome5Line} label={m.devices_home()} onClick={() => press("home")} />
        <IconAction icon={RiLockLine} label={m.devices_lock()} onClick={() => press("lock")} />
        <IconAction icon={RiVolumeDownLine} label={m.devices_volume_down()} onClick={() => press("volumeDown")} />
        <IconAction icon={RiVolumeUpLine} label={m.devices_volume_up()} onClick={() => press("volumeUp")} />
        <IconAction icon={RiAnticlockwise2Line} label={m.devices_rotate()} onClick={() => send({ kind: "rotate" })} />
        {device.platform === "android" && (
          <>
            <IconAction icon={RiArrowGoBackLine} label={m.devices_back()} onClick={() => press("back")} />
            <IconAction icon={RiStackLine} label={m.devices_recents()} onClick={() => press("recents")} />
          </>
        )}
        <IconAction
          icon={appearance === "dark" ? RiSunLine : RiMoonLine}
          label={appearance === "dark" ? m.devices_appearance_light() : m.devices_appearance_dark()}
          onClick={toggleAppearance}
        />
        <OpenLink onOpen={(url) => send({ kind: "openUrl", url })} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant={picking ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={m.devices_pick()}
                aria-pressed={picking}
                disabled={shape === null || pending}
                onClick={() => setPicking(!picking)}
                className={cn(picking && "text-primary")}
              />
            }
          >
            <RiCursorLine aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{picking ? m.devices_pick_cancel() : m.devices_pick()}</TooltipContent>
        </Tooltip>
        <div className="flex-1" />
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon-xs" aria-label={m.devices_more()} disabled={pending} />}
                >
                  <RiMore2Line aria-hidden />
                </DropdownMenuTrigger>
              }
            />
            <TooltipContent>{m.devices_more()}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-44">
            {owned ? (
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
                {m.devices_delete()}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={detach}>{m.devices_detach()}</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {shownError && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {shownError}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col p-3">
        <DeviceScreen
          canvasRef={canvasRef}
          onCanvas={onCanvas}
          sessionRef={sessionRef}
          name={device.name}
          platform={device.platform}
          screen={screen}
          shape={shape}
          control={control}
          stalled={stalled}
          picking={picking}
          hintId={hintId}
          onPick={pick}
          onCancelPick={() => setPicking(false)}
        />
        {picking && (
          <output className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
            {m.devices_pick_hint()}
          </output>
        )}
      </div>
      <div className="flex min-h-10 shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
        <p
          aria-live="polite"
          title={status}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 text-xs",
            waiting ? "font-medium text-attention" : control === "user" ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {waiting && <RiErrorWarningLine aria-hidden className="size-3.5 shrink-0" />}
          <span className="truncate">{status}</span>
        </p>
        {control === "user" && (
          <Button
            variant="outline"
            size="xs"
            disabled={pending}
            onClick={() => run(() => callPromise("device.control", { threadId, deviceId, control: "agent" }))}
          >
            {m.devices_hand_back()}
          </Button>
        )}
      </div>
      <p id={hintId} className="shrink-0 px-3 pb-1.5 text-2xs text-muted-foreground">
        {m.devices_screen_hint()}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <DeleteDeviceDialog
        name={confirmingDelete ? device.name : null}
        onCancel={() => setConfirmingDelete(false)}
        onDelete={() => {
          setConfirmingDelete(false)
          detach()
        }}
      />
    </div>
  )
}

/** A deep link or web URL to open on the device, sent on Enter. */
function OpenLink({ onOpen }: { onOpen: (url: string) => void }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [invalid, setInvalid] = useState(false)
  const errorId = useId()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = url.trim()
    if (!isCommand({ kind: "openUrl", url: trimmed })) {
      setInvalid(true)
      return
    }
    onOpen(trimmed)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label={m.devices_open_link()} />}>
              <RiLinkM aria-hidden />
            </PopoverTrigger>
          }
        />
        <TooltipContent>{m.devices_open_link()}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80">
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <Input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              setInvalid(false)
            }}
            aria-label={m.devices_open_link()}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId : undefined}
            placeholder={m.devices_open_link_placeholder()}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-7 font-mono text-xs md:text-xs"
          />
          {invalid ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {m.devices_open_link_invalid()}
            </p>
          ) : (
            <PopoverDescription className="text-xs">{m.devices_open_link_hint()}</PopoverDescription>
          )}
        </form>
      </PopoverContent>
    </Popover>
  )
}
