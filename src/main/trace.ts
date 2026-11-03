import { createWriteStream } from "node:fs"
import { type Exit, Layer, Option, Tracer } from "effect"

const QUERY_TEXT = "db.query.text"
const PREVIEW_CHARS = 200

const preview = (value: unknown) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS) : undefined

const nanosToMs = (nanos: bigint) => Number(nanos) / 1e6

export interface SlowSpan {
  readonly name: string
  readonly detail: string | undefined
  readonly ms: number
}

const slowSpan = (span: Tracer.Span, ms: number): SlowSpan => ({
  name: span.name,
  detail: preview(span.attributes.get(QUERY_TEXT)) ?? preview(span.attributes.get("command")),
  ms,
})

export class SpanLedger {
  readonly #open = new Set<Tracer.NativeSpan>()
  #endedSinceDrain: Array<SlowSpan> = []
  readonly slowMs: number

  constructor(slowMs: number) {
    this.slowMs = slowMs
  }

  started(span: Tracer.NativeSpan) {
    this.#open.add(span)
  }

  ended(span: Tracer.NativeSpan, endTime: bigint) {
    this.#open.delete(span)
    const ms = nanosToMs(endTime - span.startTime)
    if (ms >= this.slowMs) this.#endedSinceDrain.push(slowSpan(span, ms))
  }

  drainSlow(now: bigint): ReadonlyArray<SlowSpan> {
    const open = [...this.#open]
      .map((span) => slowSpan(span, nanosToMs(now - span.startTime)))
      .filter((span) => span.ms >= this.slowMs)
    const slow = [...this.#endedSinceDrain, ...open]
    this.#endedSinceDrain = []
    return slow
  }
}

export const traceLayer = (file: string | undefined, ledger: SpanLedger) => {
  const out = file ? createWriteStream(file, { flags: "a" }) : undefined

  class RecordedSpan extends Tracer.NativeSpan {
    constructor(options: ConstructorParameters<typeof Tracer.NativeSpan>[0]) {
      super(options)
      ledger.started(this)
    }

    override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
      super.end(endTime, exit)
      ledger.ended(this, endTime)
      if (!out) return
      const record = {
        id: this.spanId,
        parent: Option.getOrUndefined(this.parent)?.spanId,
        name: this.name,
        startMs: Number(this.startTime / 1000n) / 1000,
        ms: nanosToMs(endTime - this.startTime),
        query: preview(this.attributes.get(QUERY_TEXT)),
        command: preview(this.attributes.get("command")),
      }
      out.write(`${JSON.stringify(record)}\n`)
    }
  }

  return Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new RecordedSpan(options) }))
}
