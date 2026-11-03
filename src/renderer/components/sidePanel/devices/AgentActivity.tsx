import { cn } from "cn"
import type { CSSProperties } from "react"
import type { AgentAction, DeviceButton } from "../../../../shared/device.ts"
import { m } from "../../../paraglide/messages.js"

export interface ShownAgentAction {
  readonly id: number
  readonly action: AgentAction
}

const CAPTION_MS = 1800
const CAPTION_AFTER_SWIPE_MS = 800

const buttonLabel: Record<DeviceButton, () => string> = {
  home: m.devices_home,
  lock: m.devices_lock,
  volumeUp: m.devices_volume_up,
  volumeDown: m.devices_volume_down,
  back: m.devices_back,
  recents: m.devices_recents,
}

export const agentActionLabel = (action: AgentAction) => {
  switch (action.kind) {
    case "tap":
      return m.devices_action_tap()
    case "swipe":
      return m.devices_action_swipe()
    case "type":
      return m.devices_action_type({ count: action.characters })
    case "button":
      return buttonLabel[action.button]()
    case "launch":
      return m.devices_action_launch({ app: action.app })
    case "openUrl":
      return m.devices_action_open({ url: action.url })
  }
}

type SwipeAction = Extract<AgentAction, { kind: "swipe" }>

const percent = (fraction: number) => `${fraction * 100}%`
const at = (x: number, y: number) => ({ left: percent(x), top: percent(y) })

const MARK = "pointer-events-none absolute -translate-1/2 rounded-full"
const LIVE_MARK = "border-2 border-white bg-black/25 shadow-[0_0_0_1px_rgb(0_0_0/0.45),0_2px_8px_rgb(0_0_0/0.3)]"

interface AgentTouchesProps {
  readonly shown: ShownAgentAction | null
  readonly waiting: AgentAction | null
}

export function AgentTouches({ shown, waiting }: AgentTouchesProps) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {waiting && <PendingTouch action={waiting} />}
      {shown && <Touch key={shown.id} action={shown.action} />}
    </div>
  )
}

function Touch({ action }: { action: AgentAction }) {
  if (action.kind === "tap") {
    return (
      <span
        style={at(action.x, action.y)}
        className={cn(MARK, LIVE_MARK, "size-11 animate-touch motion-reduce:animate-fade-out")}
      />
    )
  }
  if (action.kind !== "swipe") return null
  const travel = {
    ...at(action.toX, action.toY),
    "--swipe-from-x": percent(action.x),
    "--swipe-from-y": percent(action.y),
    "--swipe-to-x": percent(action.toX),
    "--swipe-to-y": percent(action.toY),
    "--swipe-duration": `${action.durationMs}ms`,
  } as CSSProperties
  return (
    <>
      <svg className="absolute inset-0 size-full animate-fade-out" style={{ animationDelay: `${action.durationMs}ms` }}>
        <Trail action={action} stroke="rgb(0 0 0 / 0.3)" width={6} />
        <Trail action={action} stroke="rgb(255 255 255 / 0.8)" width={3} />
      </svg>
      <span style={travel} className={cn(MARK, LIVE_MARK, "size-7 animate-swipe motion-reduce:animate-fade-out")} />
    </>
  )
}

function Trail({ action, stroke, width }: { action: SwipeAction; stroke: string; width: number }) {
  return (
    <line
      x1={percent(action.x)}
      y1={percent(action.y)}
      x2={percent(action.toX)}
      y2={percent(action.toY)}
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap="round"
    />
  )
}

function PendingTouch({ action }: { action: AgentAction }) {
  if (action.kind !== "tap" && action.kind !== "swipe") return null
  return (
    <>
      {action.kind === "swipe" && (
        <svg className="absolute inset-0 size-full text-attention">
          <line
            x1={percent(action.x)}
            y1={percent(action.y)}
            x2={percent(action.toX)}
            y2={percent(action.toY)}
            stroke="currentColor"
            strokeWidth={2.4}
            strokeDasharray="6 6"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span
        style={at(action.x, action.y)}
        className={cn(
          MARK,
          // oxlint-disable-next-line tailwindcss/no-hardcoded-colors -- the halo sits on the device's screen, which the app theme does not color
          "size-11 border-[3px] border-dashed border-attention bg-attention/25 shadow-[0_0_0_2px_rgb(255_255_255),0_2px_8px_rgb(0_0_0/0.3)]",
        )}
      />
    </>
  )
}

interface AgentCaptionProps {
  readonly shown: ShownAgentAction | null
  readonly waiting: AgentAction | null
  readonly onDone: () => void
}

export function AgentCaption({ shown, waiting, onDone }: AgentCaptionProps) {
  if (waiting) {
    return (
      <Pill className="border-attention/40 text-attention">
        {m.devices_agent_next({ action: agentActionLabel(waiting) })}
      </Pill>
    )
  }
  if (!shown) return null
  const { action } = shown
  const duration =
    action.kind === "swipe" ? Math.max(CAPTION_MS, action.durationMs + CAPTION_AFTER_SWIPE_MS) : CAPTION_MS
  return (
    <Pill key={shown.id} silent className="animate-caption" duration={duration} onDone={onDone}>
      {agentActionLabel(action)}
    </Pill>
  )
}

interface PillProps {
  readonly children: string
  readonly className: string
  readonly silent?: boolean
  readonly duration?: number
  readonly onDone?: () => void
}

function Pill({ children, className, silent = false, duration, onDone }: PillProps) {
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-5 flex justify-center">
      <output
        aria-hidden={silent || undefined}
        title={children}
        style={duration === undefined ? undefined : { animationDuration: `${duration}ms` }}
        onAnimationEnd={onDone}
        className={cn(
          "max-w-full truncate rounded-full border border-border bg-popover px-3 py-1 text-xs font-medium text-popover-foreground shadow-md",
          className,
        )}
      >
        {children}
      </output>
    </div>
  )
}
