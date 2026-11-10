import { Result, Schema } from "effect"
import { CAPABILITIES } from "./protocol.ts"

const TextPoint = Schema.Struct({
  block: Schema.Int,
  cell: Schema.NullOr(Schema.Tuple([Schema.Int, Schema.Int])),
  offset: Schema.Int,
})

export const NativeDocumentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), capabilities: Schema.Array(Schema.Literals(CAPABILITIES)) }),
  Schema.Struct({ type: Schema.Literal("contentSize"), height: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("linkPress"), href: Schema.String }),
  Schema.Struct({ type: Schema.Literal("taskToggle"), block: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("imageRequest"), src: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("edit"),
    eventCount: Schema.Int,
    block: Schema.Int,
    cell: Schema.NullOr(Schema.Tuple([Schema.Int, Schema.Int])),
    from: Schema.Int,
    to: Schema.Int,
    text: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("select"), anchor: TextPoint, head: TextPoint }),
  Schema.Struct({
    type: Schema.Literal("key"),
    eventCount: Schema.Int,
    key: Schema.Literals(["Enter", "Backspace", "Delete", "Tab"]),
    shift: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("focus") }),
  Schema.Struct({ type: Schema.Literal("blur") }),
])
export type NativeDocumentEvent = typeof NativeDocumentEvent.Type

const decode = Schema.decodeUnknownResult(NativeDocumentEvent)

export const decodeNativeEvent = (value: unknown): NativeDocumentEvent | null => {
  const decoded = decode(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}
