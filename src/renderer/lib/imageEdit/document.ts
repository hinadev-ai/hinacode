export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const PALETTE = ["#ff375f", "#ff9f0a", "#ffd60a", "#30d158", "#0a84ff", "#bf5af2", "#000000", "#ffffff"] as const

export type Color = (typeof PALETTE)[number]

export type Shape =
  | { readonly id: string; readonly kind: "arrow"; readonly from: Point; readonly to: Point; readonly color: Color }
  | { readonly id: string; readonly kind: "rect" | "ellipse"; readonly rect: Rect; readonly color: Color }
  | { readonly id: string; readonly kind: "pen"; readonly points: ReadonlyArray<Point>; readonly color: Color }
  | { readonly id: string; readonly kind: "text"; readonly at: Point; readonly text: string; readonly color: Color }
  | { readonly id: string; readonly kind: "marker"; readonly at: Point; readonly color: Color }
  | { readonly id: string; readonly kind: "redact"; readonly rect: Rect }

export type ShapeKind = Shape["kind"]

export type Command =
  | { readonly type: "add"; readonly shape: Shape }
  | { readonly type: "update"; readonly shape: Shape }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "crop"; readonly rect: Rect | null }

export interface EditLog {
  readonly commands: ReadonlyArray<Command>
  readonly cursor: number
}

export interface EditDocument {
  readonly shapes: ReadonlyArray<Shape>
  readonly crop: Rect | null
}

export const emptyLog: EditLog = { commands: [], cursor: 0 }

const emptyDocument: EditDocument = { shapes: [], crop: null }

export const push = (log: EditLog, command: Command): EditLog => ({
  commands: [...log.commands.slice(0, log.cursor), command],
  cursor: log.cursor + 1,
})

export const canUndo = (log: EditLog) => log.cursor > 0

export const canRedo = (log: EditLog) => log.cursor < log.commands.length

export const undo = (log: EditLog): EditLog => (canUndo(log) ? { ...log, cursor: log.cursor - 1 } : log)

export const redo = (log: EditLog): EditLog => (canRedo(log) ? { ...log, cursor: log.cursor + 1 } : log)

const apply = (document: EditDocument, command: Command): EditDocument => {
  switch (command.type) {
    case "add":
      return { ...document, shapes: [...document.shapes, command.shape] }
    case "update":
      return {
        ...document,
        shapes: document.shapes.map((shape) => (shape.id === command.shape.id ? command.shape : shape)),
      }
    case "remove":
      return { ...document, shapes: document.shapes.filter((shape) => shape.id !== command.id) }
    case "crop":
      return { ...document, crop: command.rect }
  }
}

export const replay = (log: EditLog): EditDocument => log.commands.slice(0, log.cursor).reduce(apply, emptyDocument)

export const markerNumber = (shapes: ReadonlyArray<Shape>, id: string) =>
  shapes.filter((shape) => shape.kind === "marker").findIndex((shape) => shape.id === id) + 1

export const imageBounds = (width: number, height: number): Rect => ({ x: 0, y: 0, width, height })

export const visibleRect = (document: EditDocument, width: number, height: number): Rect =>
  document.crop ?? imageBounds(width, height)
