import { createWriteStream } from "node:fs"
import { type Exit, Layer, Option, Tracer } from "effect"

const QUERY_TEXT = "db.query.text"
const PREVIEW_CHARS = 200

const preview = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS) : undefined

export const traceLayer = (file: string | undefined) => {
  if (!file) return Layer.empty
  const out = createWriteStream(file, { flags: "a" })

  class RecordedSpan extends Tracer.NativeSpan {
    override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
      super.end(endTime, exit)
      const record = {
        id: this.spanId,
        parent: Option.getOrUndefined(this.parent)?.spanId,
        name: this.name,
        startMs: Number(this.startTime / 1000n) / 1000,
        ms: Number(endTime - this.startTime) / 1e6,
        query: preview(this.attributes.get(QUERY_TEXT)),
        command: preview(this.attributes.get("command")),
      }
      out.write(`${JSON.stringify(record)}\n`)
    }
  }

  return Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new RecordedSpan(options) }))
}
