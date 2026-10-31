import { cn } from "../../lib/utils.ts"
import { Icon, type IconProps } from "./Icon.tsx"

export type SendGlyphMode = "send" | "queue" | "steer" | "stop"

type Segment = readonly [x1: number, y1: number, x2: number, y2: number]

const point = (x: number, y: number): Segment => [x, y, x, y]

const segments: Record<SendGlyphMode, readonly [Segment, Segment, Segment, Segment, Segment]> = {
  send: [[12, 19, 12, 5], [6, 11, 12, 5], [18, 11, 12, 5], point(12, 5), point(12, 5)],
  queue: [
    [4, 12, 17, 12],
    [4, 6.5, 17, 6.5],
    [4, 17.5, 11, 17.5],
    [18, 14.5, 18, 20.5],
    [15, 17.5, 21, 17.5],
  ],
  steer: [[12, 19, 12, 14.8], [5.94, 8.5, 9.58, 10.6], [18.06, 8.5, 14.42, 10.6], point(12, 12), point(12, 12)],
  stop: [point(12, 12), point(12, 12), point(12, 12), point(12, 12), point(12, 12)],
}

const slots = [0, 1, 2, 3, 4] as const

const visible = ([x1, y1, x2, y2]: Segment) => x1 !== x2 || y1 !== y2

const morph = "duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"

export function SendGlyph({ mode, ...props }: IconProps & { mode: SendGlyphMode }) {
  const steer = mode === "steer"
  const stop = mode === "stop"
  return (
    <Icon {...props}>
      {slots.map((slot) => {
        const segment = segments[mode][slot]
        const [x1, y1, x2, y2] = segment
        return (
          <path
            key={slot}
            className={cn("transition-[d,opacity]", morph)}
            style={{ d: `path("M${x1} ${y1}L${x2} ${y2}")`, opacity: visible(segment) ? 1 : 0 }}
          />
        )
      })}
      <circle
        cx="12"
        cy="12"
        r="7"
        pathLength={1}
        strokeDasharray="1 1"
        className={cn("origin-center -rotate-90 transition-[stroke-dashoffset,opacity]", morph)}
        style={{ strokeDashoffset: steer ? 0 : 1, opacity: steer ? 1 : 0 }}
      />
      <circle
        cx="12"
        cy="12"
        r="2"
        fill="var(--sun, currentColor)"
        stroke="none"
        className={cn("origin-center transition-[scale,opacity]", morph)}
        style={{ scale: steer ? 1 : 0, opacity: steer ? 1 : 0 }}
      />
      <rect
        x="7.5"
        y="7.5"
        width="9"
        height="9"
        rx="2.25"
        fill="currentColor"
        stroke="none"
        className={cn("origin-center transition-[scale,opacity]", morph)}
        style={{ scale: stop ? 1 : 0.4, opacity: stop ? 1 : 0 }}
      />
    </Icon>
  )
}
