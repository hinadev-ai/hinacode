import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
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
import type { DeviceScene, ScreenOffset } from "./scene.ts"

export interface DeviceFrameProps {
  readonly model: DeviceModel
  /** The device screen in points, in either orientation. */
  readonly screen: Size
  readonly orientation: Orientation
  /** Laid exactly over the screen opening. It fills its box and gets clipped to the screen's corners. */
  readonly children: ReactNode
  readonly className?: string
}

/** A 3D phone around `children`, scaled to fit its own box. Give it a sized parent. */
export function DeviceFrame({ model, screen, orientation, children, className }: DeviceFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const container = useElementSize(containerRef)
  const dpr = useSyncExternalStore(subscribeDevicePixelRatio, () => window.devicePixelRatio)
  const scheme = useSyncExternalStore(subscribeColorScheme, colorScheme)
  const [scene, setScene] = useState<DeviceScene | null>(null)
  const [flat, setFlat] = useState(false)

  const spec = deviceSpec(model, screen)
  const layout = frameLayout(spec, orientation, container, dpr)
  const measured = container.width > 0 && container.height > 0
  const status = flat ? "flat" : scene ? "3d" : "loading"

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let created: DeviceScene | null = null
    let cancelled = false
    const fallBack = () => setFlat(true)
    import("./scene.ts").then(({ createDeviceScene }) => {
      if (cancelled) return
      created = createDeviceScene(canvas, (offset) => followGlass(screenRef.current, offset), fallBack)
      if (created) setScene(created)
      else fallBack()
    }, fallBack)
    return () => {
      cancelled = true
      created?.dispose()
    }
  }, [])

  // Before paint, so the first frame already hides the screen for the settle animation.
  useLayoutEffect(() => {
    if (!scene || !measured || flat) return
    scene.update({ spec, layout, scheme, viewport: { ...container, dpr } })
  }, [scene, measured, flat, spec, layout, scheme, container, dpr])

  return (
    <div ref={containerRef} className={cn("relative size-full overflow-hidden", className)}>
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "absolute inset-0 size-full drop-shadow-[0_12px_24px_rgb(0_0_0/0.22)] dark:drop-shadow-[0_12px_28px_rgb(0_0_0/0.5)]",
          status !== "3d" && "invisible",
        )}
      />
      {status === "flat" && measured && <FlatBody spec={spec} layout={layout} scheme={scheme} />}
      {measured && (
        <div
          ref={screenRef}
          className={cn("absolute origin-center overflow-hidden bg-black", status === "loading" && "opacity-0")}
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
      )}
    </div>
  )
}

/** Moves the DOM screen with the glass while the device turns or settles. Writes style directly, once per drawn frame. */
function followGlass(element: HTMLDivElement | null, { rotate, scale, lift, reveal }: ScreenOffset) {
  if (!element) return
  const moving = rotate !== 0 || scale !== 1 || lift !== 0
  element.style.transform = moving ? `translateY(${lift}px) rotate(${rotate}rad) scale(${scale})` : ""
  element.style.opacity = reveal === 1 ? "" : String(reveal)
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

/** The frame without WebGL: the same silhouette in CSS, with the finish as a flat gradient. */
function FlatBody({ spec, layout, scheme }: { spec: DeviceSpec; layout: FrameLayout; scheme: ColorScheme }) {
  const { scale, screen, angle } = layout
  const landscape = angle !== 0
  const width = (landscape ? spec.body.height : spec.body.width) * scale
  const height = (landscape ? spec.body.width : spec.body.height) * scale
  const metal = `#${spec.finish[scheme].color.toString(16).padStart(6, "0")}`
  return (
    <div
      aria-hidden
      className="absolute shadow-lg"
      style={{
        left: screen.x + screen.width / 2 - width / 2,
        top: screen.y + screen.height / 2 - height / 2,
        width,
        height,
        borderRadius: spec.bodyRadius * scale,
        background: `linear-gradient(135deg, ${metal}, color-mix(in oklab, ${metal} 70%, black))`,
        padding: Math.max(1.5, spec.edge * scale * 0.5),
      }}
    >
      <div className="size-full bg-black" style={{ borderRadius: spec.bodyRadius * scale }} />
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
