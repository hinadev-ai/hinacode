import { useEffect, useRef, useState } from "react"
import { RiAnticlockwise2Line } from "react-icons/ri"
import { m } from "../../paraglide/messages.js"
import { SettingsSection } from "../settings/SettingsSection.tsx"
import { Button } from "../ui/button.tsx"
import { DeviceFrame } from "./DeviceFrame.tsx"
import type { DeviceModel, Orientation, Size } from "./geometry.ts"

interface Sample {
  readonly name: string
  readonly model: DeviceModel
  readonly screen: Size
}

const samples: ReadonlyArray<Sample> = [
  { name: "iPhone 17 Pro", model: "iphone", screen: { width: 402, height: 874 } },
  { name: "Pixel 10", model: "pixel", screen: { width: 412, height: 915 } },
  { name: "iPad Air", model: "iphone", screen: { width: 820, height: 1180 } },
  { name: "Pixel Fold", model: "pixel", screen: { width: 673, height: 841 } },
  { name: "Odd emulator skin", model: "pixel", screen: { width: 360, height: 640 } },
  { name: "iPhone in landscape points", model: "iphone", screen: { width: 874, height: 402 } },
]

/** Dev-only page that renders both frames around a placeholder screen at several sizes. */
export function DeviceFrameHarness() {
  const [orientation, setOrientation] = useState<Orientation>("portrait")
  const rotate = () => setOrientation((current) => (current === "portrait" ? "landscape" : "portrait"))
  return (
    <SettingsSection
      title={m.settings_device_frames()}
      description={m.settings_device_frames_hint()}
      action={
        <Button variant="outline" size="sm" action={rotate}>
          <RiAnticlockwise2Line aria-hidden />
          {m.device_frames_rotate()}
        </Button>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        {samples.map((sample) => (
          <figure key={sample.name} className="flex flex-col gap-2">
            <div className="h-104 rounded-xl bg-muted dark:bg-muted/50">
              <DeviceFrame model={sample.model} screen={sample.screen} orientation={orientation}>
                <PlaceholderScreen />
              </DeviceFrame>
            </div>
            <figcaption className="text-sm text-muted-foreground tabular-nums">
              {sample.name}, {sample.screen.width} × {sample.screen.height}
            </figcaption>
          </figure>
        ))}
      </div>
      <div
        data-testid="device-frame-resizable"
        className="h-96 w-80 min-w-40 min-h-40 max-w-full resize overflow-hidden rounded-xl bg-muted dark:bg-muted/50"
      >
        <DeviceFrame model="iphone" screen={samples[0]!.screen} orientation={orientation}>
          <PlaceholderScreen />
        </DeviceFrame>
      </div>
    </SettingsSection>
  )
}

/** Stands in for the stream: drawn at device pixels, with 1px lines that blur if the rect is off the pixel grid. */
function PlaceholderScreen() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const context = canvas.getContext("2d")
      if (!context) return
      const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height)
      gradient.addColorStop(0, "#5b6cff")
      gradient.addColorStop(1, "#ff7ab6")
      context.fillStyle = gradient
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = "rgb(255 255 255 / 0.35)"
      for (let x = 0; x < canvas.width; x += 8 * dpr) context.fillRect(Math.round(x), 0, 1, canvas.height)
      context.fillStyle = "#fff"
      context.font = `600 ${14 * dpr}px system-ui`
      context.fillText(`${Math.round(width)} × ${Math.round(height)}`, 16 * dpr, canvas.height - 16 * dpr)
    }
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])
  return <canvas ref={ref} aria-hidden className="block size-full" />
}
