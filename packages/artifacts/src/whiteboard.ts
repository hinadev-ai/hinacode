import { z } from "zod"

export const WhiteboardElementSchema = z.looseObject({ id: z.string().min(1) })

export const WhiteboardSceneSchema = z.object({
  elements: z.array(WhiteboardElementSchema),
  files: z.record(z.string(), z.unknown()).optional(),
})

export type WhiteboardElement = z.infer<typeof WhiteboardElementSchema>
export type WhiteboardScene = z.infer<typeof WhiteboardSceneSchema>
export type WhiteboardPatch = { upsert: WhiteboardElement[]; remove?: string[] }

export const EMPTY_SCENE: WhiteboardScene = { elements: [] }

export const sceneFile = (scene: WhiteboardScene) =>
  `${JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "hinacode",
    elements: scene.elements,
    appState: {},
    files: scene.files ?? {},
  })}\n`

export const parseScene = (text: string): WhiteboardScene | null => {
  try {
    const parsed = WhiteboardSceneSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const duplicateId = (ids: ReadonlyArray<string>) => ids.find((id, index) => ids.indexOf(id) !== index)

export const mergeScene = (scene: WhiteboardScene, patch: WhiteboardPatch): WhiteboardScene => {
  const removed = new Set(patch.remove ?? [])
  const upserts = new Map(patch.upsert.map((element) => [element.id, element]))
  const replaced = new Set([...removed, ...upserts.keys()])
  const isStaleLabel = (element: WhiteboardElement) => {
    const container = element["containerId"]
    return typeof container === "string" && replaced.has(container) && !upserts.has(element.id)
  }
  const kept = scene.elements
    .filter((element) => !removed.has(element.id) && !isStaleLabel(element))
    .map((element) => upserts.get(element.id) ?? element)
  const present = new Set(kept.map((element) => element.id))
  return {
    ...scene,
    elements: withoutMissingChildren([...kept, ...patch.upsert.filter((element) => !present.has(element.id))]),
  }
}

const withoutMissingChildren = <E extends WhiteboardElement>(elements: ReadonlyArray<E>): E[] => {
  const ids = new Set(elements.map((element) => element.id))
  return elements.map((element) => {
    const children = element["children"]
    if (!Array.isArray(children)) return element
    const present = children.filter((child) => typeof child === "string" && ids.has(child))
    return present.length === children.length ? element : { ...element, children: present }
  })
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined

const text = (value: unknown, key: string) => {
  const found = field(value, key)
  return typeof found === "string" ? found : undefined
}

const rounded = (value: unknown, key: string) => {
  const found = field(value, key)
  return typeof found === "number" && Number.isFinite(found) ? Math.round(found) : undefined
}

const quoted = (value: string | undefined) => (value === undefined || value === "" ? "" : ` ${JSON.stringify(value)}`)

const bounds = (element: WhiteboardElement) => {
  const [x, y, width, height] = ["x", "y", "width", "height"].map((key) => rounded(element, key))
  const at = x === undefined || y === undefined ? "" : ` at ${x},${y}`
  const size = width === undefined || height === undefined ? "" : ` ${width}x${height}`
  return `${at}${size}`
}

export const describeScene = (elements: ReadonlyArray<WhiteboardElement>) => {
  const live = elements.filter((element) => field(element, "isDeleted") !== true)
  const ids = new Set(live.map((element) => element.id))
  const boundText = new Map<string, string>()
  for (const element of live) {
    const container = text(element, "containerId")
    const value = text(element, "text")
    if (container !== undefined && ids.has(container) && value !== undefined) boundText.set(container, value)
  }
  const lines = live.flatMap((element) => {
    const container = text(element, "containerId")
    if (container !== undefined && ids.has(container)) return []
    const type = text(element, "type") ?? "element"
    const label =
      (type === "text" ? text(element, "text") : undefined) ??
      text(field(element, "label"), "text") ??
      boundText.get(element.id)
    const start = text(field(element, "start"), "id") ?? text(field(element, "startBinding"), "elementId")
    const end = text(field(element, "end"), "id") ?? text(field(element, "endBinding"), "elementId")
    if (start !== undefined || end !== undefined) {
      return [`${element.id} ${type}: ${start ?? "?"} -> ${end ?? "?"}${quoted(label)}`]
    }
    return [`${element.id} ${type}${quoted(label)}${bounds(element)}`]
  })
  return lines.length === 0 ? "The whiteboard is empty." : lines.join("\n")
}
