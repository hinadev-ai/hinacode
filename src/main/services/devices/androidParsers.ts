import type { DeviceElement } from "../../../shared/device.ts"

export interface RunningEmulator {
  readonly pid: number
  readonly avdName: string
  readonly serialPort: number
  readonly grpcPort: number | null
  readonly grpcToken: string | null
}

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
  const avdName = ini.get("avd.name")
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

export const quoteForRemoteShell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
