import { Schema } from "effect"
import { Attachment, PickedElement } from "./domain.ts"

const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2560 }))
const Coordinate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2560 }))
const Modifiers = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15 }))

export const BrowserViewport = Schema.Struct({ width: Dimension, height: Dimension })
export type BrowserViewport = typeof BrowserViewport.Type

export const BrowserUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value)
    return url !== null && (url.protocol === "http:" || url.protocol === "https:")
  }),
)

export const BrowserSession = Schema.Struct({ threadId: Schema.String, sessionId: Schema.String })

export const BrowserCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("navigate"), url: BrowserUrl }),
  Schema.Struct({ kind: Schema.Literals(["back", "forward", "reload", "stop"]) }),
  Schema.Struct({ kind: Schema.Literal("resize"), ...BrowserViewport.fields }),
  Schema.Struct({
    kind: Schema.Literal("pointer"),
    type: Schema.Literals(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]),
    x: Coordinate,
    y: Coordinate,
    button: Schema.Literals(["none", "left", "middle", "right"]),
    buttons: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
    clickCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
    modifiers: Modifiers,
    deltaX: Schema.Number.check(Schema.isBetween({ minimum: -10000, maximum: 10000 })),
    deltaY: Schema.Number.check(Schema.isBetween({ minimum: -10000, maximum: 10000 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    type: Schema.Literals(["keyDown", "keyUp"]),
    key: Schema.String.check(Schema.isMaxLength(100)),
    code: Schema.String.check(Schema.isMaxLength(100)),
    keyCode: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
    modifiers: Modifiers,
    text: Schema.String.check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String.check(Schema.isMaxLength(10000)) }),
  Schema.Struct({ kind: Schema.Literal("pick"), enabled: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("release") }),
])
export type BrowserCommand = typeof BrowserCommand.Type

export const BrowserPick = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["idle", "selecting"]) }),
  Schema.Struct({ kind: Schema.Literal("picked"), attachment: Attachment }),
  Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
])
export type BrowserPick = typeof BrowserPick.Type

export const BrowserState = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  back: Schema.Boolean,
  forward: Schema.Boolean,
  failure: Schema.NullOr(Schema.String),
  pick: BrowserPick,
})
export type BrowserState = typeof BrowserState.Type

export const BrowserFrame = Schema.Struct({
  sequence: Schema.Int,
  jpeg: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024)),
  ...BrowserViewport.fields,
})
export type BrowserFrame = typeof BrowserFrame.Type

export const BrowserSnapshot = Schema.Struct({ state: BrowserState, frame: Schema.NullOr(BrowserFrame) })
export type BrowserSnapshot = typeof BrowserSnapshot.Type

export const PagePick = Schema.Struct({
  element: PickedElement,
  rect: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
})
export type PagePick = typeof PagePick.Type
