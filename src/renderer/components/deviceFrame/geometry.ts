export type DeviceModel = "iphone" | "pixel"
export type Orientation = "portrait" | "landscape"
export type ColorScheme = "light" | "dark"

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Rect extends Size {
  readonly x: number
  readonly y: number
}

/** A camera cut into the display, drawn over the stream because simulator framebuffers leave it out. */
export type Cutout =
  | { readonly kind: "island"; readonly width: number; readonly height: number; readonly top: number }
  | { readonly kind: "hole"; readonly diameter: number; readonly top: number }

/** A side button. `offset` runs from the body's top edge along `side`, top runs from the left. */
export interface SideButton {
  readonly side: "left" | "right" | "top"
  readonly offset: number
  readonly length: number
}

/** Every dimension of one device in screen points, in portrait. */
export interface DeviceSpec {
  readonly model: DeviceModel
  readonly screen: Size
  readonly body: Size
  readonly bezel: number
  readonly screenRadius: number
  readonly bodyRadius: number
  /** Radius of the rounded edge where the frame meets the glass. */
  readonly edge: number
  readonly cutout: Cutout | null
  /** A front camera in the bezel, for tablets whose display has no cutout. */
  readonly bezelCamera: number | null
  readonly buttons: ReadonlyArray<SideButton>
  /** The frame's metal, as a CSS color. */
  readonly finish: Record<ColorScheme, string>
}

// Phones are taller than 2:1, iPads and foldables are 1.1:1 to 1.5:1.
const TABLET_ASPECT = 1.75

/** Proportions measured on an iPhone 17 Pro (402 pt wide) and a Pixel 10 (412 dp wide), scaled by the short side. */
export function deviceSpec(model: DeviceModel, screen: Size): DeviceSpec {
  const portrait = { width: Math.min(screen.width, screen.height), height: Math.max(screen.width, screen.height) }
  const tablet = portrait.height / portrait.width < TABLET_ASPECT
  const shape = (tablet ? tabletShape : model === "iphone" ? iphoneShape : pixelShape)(portrait.width)
  const body = { width: portrait.width + shape.bezel * 2, height: portrait.height + shape.bezel * 2 }
  return {
    model,
    screen: portrait,
    body,
    ...shape,
    bodyRadius: shape.screenRadius + shape.bezel,
    buttons: (tablet ? tabletButtons : model === "iphone" ? iphoneButtons : pixelButtons)(body),
    finish: finishes[model],
  }
}

type Shape = Pick<DeviceSpec, "bezel" | "screenRadius" | "edge" | "cutout" | "bezelCamera">

const iphoneShape = (w: number): Shape => {
  const u = w / 402
  return {
    bezel: 11 * u,
    screenRadius: 56 * u,
    edge: 5 * u,
    cutout: { kind: "island", width: 125 * u, height: 37 * u, top: 11 * u },
    bezelCamera: null,
  }
}

const pixelShape = (w: number): Shape => {
  const u = w / 412
  return {
    bezel: 13 * u,
    screenRadius: 44 * u,
    edge: 7 * u,
    cutout: { kind: "hole", diameter: 13 * u, top: 15 * u },
    bezelCamera: null,
  }
}

const tabletShape = (w: number): Shape => {
  const u = w / 820
  return { bezel: 22 * u, screenRadius: 18 * u, edge: 6 * u, cutout: null, bezelCamera: 6 * u }
}

const iphoneButtons = ({ height }: Size): ReadonlyArray<SideButton> => [
  { side: "left", offset: height * 0.17, length: height * 0.035 },
  { side: "left", offset: height * 0.25, length: height * 0.07 },
  { side: "left", offset: height * 0.34, length: height * 0.07 },
  { side: "right", offset: height * 0.27, length: height * 0.11 },
]

const pixelButtons = ({ height }: Size): ReadonlyArray<SideButton> => [
  { side: "right", offset: height * 0.2, length: height * 0.07 },
  { side: "right", offset: height * 0.32, length: height * 0.14 },
]

const tabletButtons = ({ width, height }: Size): ReadonlyArray<SideButton> => [
  { side: "top", offset: width * 0.82, length: width * 0.06 },
  { side: "right", offset: height * 0.06, length: height * 0.045 },
  { side: "right", offset: height * 0.115, length: height * 0.045 },
]

const finishes: Record<DeviceModel, Record<ColorScheme, string>> = {
  iphone: { light: "#c2bdb3", dark: "#6b675f" },
  pixel: { light: "#e4e0d8", dark: "#555a61" },
}

/** Room around the body for the side buttons and the shadow, in CSS pixels. */
const PADDING = 16

export interface FrameLayout {
  /** CSS pixels per screen point. */
  readonly scale: number
  /** In-plane rotation of the device in radians. Landscape turns the top to the left. */
  readonly angle: number
  /** The oriented screen opening in CSS pixels, relative to the container. */
  readonly screen: Rect
  readonly screenRadius: number
}

/** CSS pixels per point that fit the body into `container` when turned by `angle`, so a turn never clips. */
export function fitScale({ body }: DeviceSpec, container: Size, angle: number) {
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const width = body.width * cos + body.height * sin
  const height = body.width * sin + body.height * cos
  return Math.max(Math.min((container.width - PADDING * 2) / width, (container.height - PADDING * 2) / height), 0)
}

/** Fits the oriented device into `container` and snaps the screen opening to device pixels. */
export function frameLayout(spec: DeviceSpec, orientation: Orientation, container: Size, dpr: number): FrameLayout {
  const landscape = orientation === "landscape"
  const angle = landscape ? Math.PI / 2 : 0
  const fit = fitScale(spec, container, angle)
  const snap = (value: number) => Math.round(value * dpr) / dpr
  const width = snap((landscape ? spec.screen.height : spec.screen.width) * fit)
  const height = snap((landscape ? spec.screen.width : spec.screen.height) * fit)
  // A snapped size can differ from the unsnapped one, so the scale follows the snapped screen.
  const scale = landscape ? width / spec.screen.height : width / spec.screen.width
  return {
    scale: Math.max(scale, 0),
    angle,
    screen: {
      x: snap((container.width - width) / 2),
      y: snap((container.height - height) / 2),
      width: Math.max(width, 0),
      height: Math.max(height, 0),
    },
    screenRadius: spec.screenRadius * Math.max(scale, 0),
  }
}
