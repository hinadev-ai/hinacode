import { Result, Schema } from "effect"
import { CAPABILITIES } from "./protocol.ts"

export const NativeDocumentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), capabilities: Schema.Array(Schema.Literals(CAPABILITIES)) }),
  Schema.Struct({ type: Schema.Literal("contentSize"), height: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("linkPress"), href: Schema.String }),
  Schema.Struct({ type: Schema.Literal("taskToggle"), block: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("imageRequest"), src: Schema.String }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
])
export type NativeDocumentEvent = typeof NativeDocumentEvent.Type

const decode = Schema.decodeUnknownResult(NativeDocumentEvent)

export const decodeNativeEvent = (value: unknown): NativeDocumentEvent | null => {
  const decoded = decode(value)
  return Result.isSuccess(decoded) ? decoded.success : null
}
