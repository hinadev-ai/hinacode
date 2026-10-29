import { type ReactNode, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { cn } from "cn"
import {
  type ColorScheme,
  type Cutout,
  type DeviceModel,
  type DeviceSpec,
  deviceSpec,
  type Fold,
  type FrameLayout,
  frameLayout,
  type Orientation,
  type Size,
} from "./geometry.ts"

export interface DeviceFrameProps {
  readonly model: DeviceModel
  readonly screen: Size
  readonly orientation: Orientation
  readonly fold?: Fold
  readonly children: ReactNode
  readonly className?: string
}

export function DeviceFrame({ model, screen, orientation, fold, children, className }: DeviceFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const container = useElementSize(containerRef)
  const dpr = useSyncExternalStore(subscribeDevicePixelRatio, () => window.devicePixelRatio)
  const scheme = useSyncExternalStore(subscribeColorScheme, colorScheme)

  const spec = deviceSpec(model, screen)
  const unfolded = fold && { spec: deviceSpec(model, fold.unfolded), posture: fold.posture }
  const layout = frameLayout(spec, orientation, container, dpr, unfolded)
  const measured = container.width > 0 && container.height > 0
  const pinch = hingePinch(fold, spec, layout.scale)

  return (
    <div ref={containerRef} className={cn("relative size-full overflow-hidden", className)}>
      {measured && (
        <>
          <Body spec={spec} layout={layout} scheme={scheme} pinch={pinch?.body} />
          <div
            className="absolute overflow-hidden bg-black transition-[clip-path] duration-500 ease-out motion-reduce:transition-none"
            style={{
              left: layout.screen.x,
              top: layout.screen.y,
              width: layout.screen.width,
              height: layout.screen.height,
              borderRadius: layout.screenRadius,
              clipPath: pinch ? hingeClip(layout.screen.width > layout.screen.height, pinch.screen) : undefined,
            }}
          >
            {children}
            {spec.cutout && <CutoutMark cutout={spec.cutout} layout={layout} />}
            {fold?.posture === "halfOpen" && <Crease across={layout.screen.width > layout.screen.height} />}
          </div>
        </>
      )}
    </div>
  )
}

function CutoutMark({ cutout, layout }: { cutout: Cutout; layout: FrameLayout }) {
  const { scale, screen, angle } = layout
  const landscape = angle !== 0
  const across = (cutout.kind === "island" ? cutout.width : cutout.diameter) * scale
  const thick = (cutout.kind === "island" ? cutout.height : cutout.diameter) * scale
  const inset = cutout.top * scale
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute rounded-full bg-black"
      style={
        landscape
          ? { left: inset, top: (screen.height - across) / 2, width: thick, height: across }
          : { top: inset, left: (screen.width - across) / 2, width: across, height: thick }
      }
    />
  )
}

interface Pinch {
  readonly depth: number
  readonly reach: number
}

function hingePinch(fold: Fold | undefined, spec: DeviceSpec, scale: number) {
  if (!fold || fold.posture === "closed") return null
  const short = Math.min(spec.body.width, spec.body.height) * scale
  const none: Pinch = { depth: 0, reach: 1 }
  return fold.posture === "halfOpen"
    ? { body: { depth: short * 0.016, reach: 1 }, screen: { depth: short * 0.016, reach: 1 } }
    : { body: { depth: short * 0.006, reach: 0.04 }, screen: none }
}

function hingeClip(across: boolean, { depth, reach }: Pinch) {
  const from = `${50 - reach * 50}%`
  const to = `${50 + reach * 50}%`
  return across
    ? `polygon(0 0, ${from} 0, 50% ${depth}px, ${to} 0, 100% 0, 100% 100%, ${to} 100%, 50% calc(100% - ${depth}px), ${from} 100%, 0 100%)`
    : `polygon(0 0, 100% 0, 100% ${from}, calc(100% - ${depth}px) 50%, 100% ${to}, 100% 100%, 0 100%, 0 ${to}, ${depth}px 50%, 0 ${from})`
}

function Crease({ across }: { across: boolean }) {
  const direction = across ? "to right" : "to bottom"
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        background: `linear-gradient(${direction}, transparent 44%, rgb(0 0 0 / 0.14) 49.6%, rgb(255 255 255 / 0.08) 50.2%, transparent 56%)`,
      }}
    />
  )
}

function Body({
  spec,
  layout,
  scheme,
  pinch,
}: {
  spec: DeviceSpec
  layout: FrameLayout
  scheme: ColorScheme
  pinch: Pinch | undefined
}) {
  const { scale, screen, angle } = layout
  const width = spec.body.width * scale
  const height = spec.body.height * scale
  const metal = spec.finish[scheme]
  const shade = `linear-gradient(135deg, ${metal}, color-mix(in oklab, ${metal} 70%, black))`
  const button = Math.max(2, spec.bezel * scale * 0.3)
  return (
    <div
      aria-hidden
      className="absolute transition-transform duration-500 ease-out motion-reduce:transition-none"
      style={{
        left: screen.x + screen.width / 2 - width / 2,
        top: screen.y + screen.height / 2 - height / 2,
        width,
        height,
        transform: angle === 0 ? undefined : `rotate(${-angle}rad)`,
      }}
    >
      {spec.buttons.map(({ side, offset, length }) => (
        <div
          key={`${side}-${offset}`}
          className="absolute rounded-sm"
          style={{
            background: shade,
            ...(side === "top"
              ? { top: -button, left: offset * scale, width: length * scale, height: button * 2 }
              : { [side]: -button, top: offset * scale, width: button * 2, height: length * scale }),
          }}
        />
      ))}
      {/* FIXME: clip-path cuts off a box-shadow, so a drop-shadow on the wrapper follows the outline instead */}
      <div className="absolute inset-0 drop-shadow-[0_12px_12px_rgb(0_0_0/0.22)] dark:drop-shadow-[0_12px_14px_rgb(0_0_0/0.5)]">
        <div
          className="size-full transition-[clip-path] duration-500 ease-out motion-reduce:transition-none"
          style={{
            borderRadius: spec.bodyRadius * scale,
            background: shade,
            padding: Math.max(1.5, spec.edge * scale * 0.5),
            clipPath: pinch && hingeClip(spec.body.width > spec.body.height, pinch),
          }}
        >
          <div className="size-full bg-black" style={{ borderRadius: spec.bodyRadius * scale }} />
        </div>
      </div>
      {spec.bezelCamera !== null && (
        <div
          className="absolute left-1/2 -translate-x-1/2 rounded-full bg-neutral-800"
          style={{
            top: (spec.bezel * scale - spec.bezelCamera * scale) / 2,
            width: spec.bezelCamera * scale,
            height: spec.bezelCamera * scale,
          }}
        />
      )}
    </div>
  )
}

function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return size
}

function subscribeDevicePixelRatio(onChange: () => void) {
  let query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
  const handle = () => {
    query.removeEventListener("change", handle)
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener("change", handle)
    onChange()
  }
  query.addEventListener("change", handle)
  return () => query.removeEventListener("change", handle)
}

const colorScheme = (): ColorScheme => (document.documentElement.classList.contains("dark") ? "dark" : "light")

function subscribeColorScheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
}
