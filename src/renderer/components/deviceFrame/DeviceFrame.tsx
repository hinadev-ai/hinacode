import { type ReactNode, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { cn } from "cn"
import {
  type ColorScheme,
  type Cutout,
  type DeviceModel,
  type DeviceSpec,
  deviceSpec,
  type FrameLayout,
  frameLayout,
  type Orientation,
  type Size,
} from "./geometry.ts"

export interface DeviceFrameProps {
  readonly model: DeviceModel
  /** The device screen in points, in either orientation. */
  readonly screen: Size
  readonly orientation: Orientation
  /** Laid exactly over the screen opening. It fills its box and gets clipped to the screen's corners. */
  readonly children: ReactNode
  readonly className?: string
}

/** A phone around `children`, scaled to fit its own box. Give it a sized parent. */
export function DeviceFrame({ model, screen, orientation, children, className }: DeviceFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const container = useElementSize(containerRef)
  const dpr = useSyncExternalStore(subscribeDevicePixelRatio, () => window.devicePixelRatio)
  const scheme = useSyncExternalStore(subscribeColorScheme, colorScheme)

  const spec = deviceSpec(model, screen)
  const layout = frameLayout(spec, orientation, container, dpr)
  const measured = container.width > 0 && container.height > 0

  return (
    <div ref={containerRef} className={cn("relative size-full overflow-hidden", className)}>
      {measured && (
        <>
          <Body spec={spec} layout={layout} scheme={scheme} />
          <div
            className="absolute overflow-hidden bg-black"
            style={{
              left: layout.screen.x,
              top: layout.screen.y,
              width: layout.screen.width,
              height: layout.screen.height,
              borderRadius: layout.screenRadius,
            }}
          >
            {children}
            {spec.cutout && <CutoutMark cutout={spec.cutout} layout={layout} />}
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

/**
 * The body in portrait, centered on the screen and turned with it, so its side buttons follow. Landscape turns the
 * top to the left, as the device reports it.
 */
function Body({ spec, layout, scheme }: { spec: DeviceSpec; layout: FrameLayout; scheme: ColorScheme }) {
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
      <div
        className="absolute inset-0 shadow-[0_12px_24px_rgb(0_0_0/0.22)] dark:shadow-[0_12px_28px_rgb(0_0_0/0.5)]"
        style={{
          borderRadius: spec.bodyRadius * scale,
          background: shade,
          padding: Math.max(1.5, spec.edge * scale * 0.5),
        }}
      >
        <div className="size-full bg-black" style={{ borderRadius: spec.bodyRadius * scale }} />
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
