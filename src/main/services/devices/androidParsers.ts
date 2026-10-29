import type { DeviceElement } from "../../../shared/device.ts"

/** An emulator process as its `avd/running/pid_<pid>.ini` discovery file describes it. */
export interface RunningEmulator {
  readonly pid: number
  readonly avdName: string
  /** `emulator-<serialPort>` is its adb serial. */
  readonly serialPort: number
  /** Null when the emulator was started without its gRPC endpoint. */
  readonly grpcPort: number | null
  readonly grpcToken: string | null
}

/** `ImageFormat.rotation` from the emulator's proto, which follows the device's rotation sensor. */
export type SkinRotation = "PORTRAIT" | "LANDSCAPE" | "REVERSE_PORTRAIT" | "REVERSE_LANDSCAPE"

export const parseIni = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text.split(/\r?\n/).flatMap((line) => {
      const separator = line.indexOf("=")
      return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const] : []
    }),
  )

export const parseDiscoveryFile = (fileName: string, text: string): RunningEmulator | null => {
  const pid = Number(/^pid_(\d+)\.ini$/.exec(fileName)?.[1])
  const ini = parseIni(text)
  // `avd.name` is the display name when the AVD has one, such as "Pixel 10 Pro (2)" for `Pixel_10_Pro_2`.
  const avdName = ini.get("avd.id") || ini.get("avd.name")
  const serialPort = Number(ini.get("port.serial"))
  if (!Number.isInteger(pid) || !avdName || !Number.isInteger(serialPort)) return null
  const grpcPort = Number(ini.get("grpc.port"))
  return {
    pid,
    avdName,
    serialPort,
    grpcPort: Number.isInteger(grpcPort) && grpcPort > 0 ? grpcPort : null,
    grpcToken: ini.get("grpc.token") || null,
  }
}

const RELEASES: Readonly<Record<number, string>> = {
  28: "9",
  29: "10",
  30: "11",
  31: "12",
  32: "12L",
  33: "13",
  34: "14",
  35: "15",
  36: "16",
}

/** The OS version from an AVD's `image.sysdir.1`, such as `system-images/android-36/google_apis/arm64-v8a/`. */
export const androidVersionOf = (systemImageDir: string | undefined): string => {
  const platform = /android-([^/]+)/.exec(systemImageDir ?? "")?.[1]
  if (!platform) return "Android"
  const release = RELEASES[Number(platform)]
  if (release) return `Android ${release}`
  return /^\d+$/.test(platform) ? `API ${platform}` : `Android ${platform}`
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

const decodeEntities = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(parseInt(name.slice(2), 16))
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)))
    return ENTITIES[name] ?? entity
  })

const attributesOf = (tag: string): ReadonlyMap<string, string> =>
  new Map([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name ?? "", decodeEntities(value ?? "")]))

const MAX_TEXT = 500
const clip = (value: string) => value.slice(0, MAX_TEXT)

/**
 * Flattens a `uiautomator dump` into elements in document order, keeping the ones an agent can name or act on.
 * Bounds are in display pixels of the current rotation; `scale` is the density over 160, so frames come out in points.
 */
export const parseUiHierarchy = (xml: string, scale: number): ReadonlyArray<DeviceElement> =>
  [...xml.matchAll(/<node\s[^>]*>/g)].flatMap(([tag]) => {
    const node = attributesOf(tag)
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(node.get("bounds") ?? "")
    if (!bounds) return []
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number) as [number, number, number, number]
    const text = node.get("text") ?? ""
    const label = text || (node.get("content-desc") ?? "")
    const identifier = node.get("resource-id") ?? ""
    const role = (node.get("class") ?? "").split(".").at(-1) ?? ""
    const editable = role.includes("EditText")
    const actionable = node.get("clickable") === "true" || node.get("scrollable") === "true" || editable
    if (!label && !identifier && !actionable) return []
    return [
      {
        role: clip(role),
        label: clip(label),
        identifier: clip(identifier),
        value: editable ? clip(text) : "",
        frame: { x: x1 / scale, y: y1 / scale, width: (x2 - x1) / scale, height: (y2 - y1) / scale },
      },
    ]
  })

/**
 * Maps a point given as fractions of the displayed (rotated) screen onto the touch panel, which keeps the
 * portrait axes of `panel` whatever the rotation.
 */
export const panelPoint = (
  rotation: SkinRotation,
  fraction: { readonly x: number; readonly y: number },
  panel: { readonly width: number; readonly height: number },
) => {
  const { width, height } = panel
  switch (rotation) {
    case "PORTRAIT":
      return { x: Math.round(fraction.x * width), y: Math.round(fraction.y * height) }
    case "REVERSE_PORTRAIT":
      return { x: Math.round((1 - fraction.x) * width), y: Math.round((1 - fraction.y) * height) }
    case "LANDSCAPE":
      return { x: Math.round((1 - fraction.y) * width), y: Math.round(fraction.x * height) }
    case "REVERSE_LANDSCAPE":
      return { x: Math.round(fraction.y * width), y: Math.round((1 - fraction.x) * height) }
  }
}

/** Quotes one argument for the device's shell, since `adb shell` joins its arguments into a remote command line. */
export const quoteForRemoteShell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
