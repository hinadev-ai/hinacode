import variant from "@jitl/quickjs-singlefile-mjs-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten-core"

export interface ScriptHost {
  readonly tools: ReadonlyArray<string>
  readonly call: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>
}

export type ScriptOutcome =
  | { readonly _tag: "Completed"; readonly output: string }
  | { readonly _tag: "Failed"; readonly output: string; readonly error: string }

export const SLICE_MS = 500
export const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024
export const MAX_OUTPUT_CHARS = 40_000

const WASM_PAGE_BYTES = 64 * 1024

const loadQuickJs = () =>
  newQuickJSWASMModuleFromVariant(
    newVariant(variant, {
      wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: MEMORY_LIMIT_BYTES / WASM_PAGE_BYTES }),
    }),
  )

const PRELUDE = `
const describe = (value) => typeof value === "string" ? value : value instanceof Error ? String(value) : JSON.stringify(value, null, 2) ?? String(value)
globalThis.tools = Object.freeze(Object.fromEntries(JSON.parse(__toolNames).map((name) => [name, (args = {}) =>
  __call(name, JSON.stringify(args)).then(JSON.parse, (message) => { throw new Error(message) })])))
globalThis.console = Object.freeze(Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) =>
  [level, (...values) => __print(values.map(describe).join(" "))])))
globalThis.__describe = describe
`

const wrap = (code: string) =>
  `(async () => {${code}\n})().then((value) => value === undefined ? "" : __describe(value), (error) => {
  throw error instanceof Error ? [String(error), error.stack ?? ""].join("\\n").trim() : __describe(error)
})`

const truncate = (text: string) => {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const half = MAX_OUTPUT_CHARS / 2
  return `${text.slice(0, half)}\n… ${text.length - MAX_OUTPUT_CHARS} characters omitted …\n${text.slice(-half)}`
}

const errorText = (context: QuickJSContext, handle: QuickJSHandle) => {
  const dumped: unknown = context.dump(handle)
  if (typeof dumped === "string") return dumped
  if (typeof dumped === "object" && dumped !== null && "message" in dumped) {
    const { name, message } = dumped as { name?: unknown; message?: unknown }
    return `${String(name ?? "Error")}: ${String(message)}`
  }
  return JSON.stringify(dumped)
}

export const runScript = async (code: string, host: ScriptHost, signal: AbortSignal): Promise<ScriptOutcome> => {
  const runtime = (await loadQuickJs()).newRuntime()
  const context = runtime.newContext()
  const calls = new AbortController()
  const pending = new Set<Promise<void>>()
  const deferreds = new Set<QuickJSDeferredPromise>()
  const lines: Array<string> = []
  let sliceDeadline = 0
  let overran = false
  let finished = false

  runtime.setMaxStackSize(1024 * 1024)
  runtime.setInterruptHandler(() => {
    overran ||= performance.now() > sliceDeadline
    return overran
  })

  const startSlice = () => {
    sliceDeadline = performance.now() + SLICE_MS
  }

  const output = () => truncate(lines.join("\n"))
  const failed = (error: string): ScriptOutcome => ({
    _tag: "Failed",
    output: output(),
    error: overran
      ? `The script ran for more than ${SLICE_MS} ms without waiting on a tool, so it was stopped.`
      : error.startsWith("InternalError: out of memory")
        ? "The script ran out of memory in the sandbox."
        : error,
  })

  const settle = (deferred: QuickJSDeferredPromise, outcome: { ok: string } | { error: string }) => {
    deferreds.delete(deferred)
    if (finished) return deferred.dispose()
    const value = context.newString("ok" in outcome ? outcome.ok : outcome.error)
    if ("ok" in outcome) deferred.resolve(value)
    else deferred.reject(value)
    value.dispose()
    deferred.dispose()
  }

  const call = context.newFunction("__call", (nameHandle, argsHandle) => {
    const name = context.getString(nameHandle)
    const args: unknown = JSON.parse(context.getString(argsHandle))
    const deferred = context.newPromise()
    deferreds.add(deferred)
    const task = Promise.resolve()
      .then(() =>
        host.tools.includes(name) ? host.call(name, args, calls.signal) : Promise.reject(new Error(`No tool ${name}.`)),
      )
      .then(
        (value) => settle(deferred, { ok: JSON.stringify(value) ?? "null" }),
        (error: unknown) => settle(deferred, { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => pending.delete(task))
    pending.add(task)
    return deferred.handle
  })
  const print = context.newFunction("__print", (line) => {
    lines.push(context.getString(line))
  })
  const toolNames = context.newString(JSON.stringify(host.tools))
  context.setProp(context.global, "__call", call)
  context.setProp(context.global, "__print", print)
  context.setProp(context.global, "__toolNames", toolNames)
  call.dispose()
  print.dispose()
  toolNames.dispose()

  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted")
    signal.addEventListener("abort", () => resolve("aborted"), { once: true })
  })

  let script: QuickJSHandle | undefined
  try {
    startSlice()
    context.unwrapResult(context.evalCode(PRELUDE, "prelude.js")).dispose()
    startSlice()
    const evaluated = context.evalCode(wrap(code), "script.js")
    if (evaluated.error !== undefined) {
      const error = errorText(context, evaluated.error)
      evaluated.error.dispose()
      return failed(error)
    }
    script = evaluated.value
    for (;;) {
      startSlice()
      const jobs = runtime.executePendingJobs()
      if (jobs.error !== undefined) {
        const error = errorText(context, jobs.error)
        jobs.error.dispose()
        return failed(error)
      }
      const state = context.getPromiseState(script)
      if (state.type === "fulfilled") {
        const value = context.getString(state.value)
        state.value.dispose()
        return { _tag: "Completed", output: truncate([...lines, value].filter((line) => line !== "").join("\n")) }
      }
      if (state.type === "rejected") {
        const error = errorText(context, state.error)
        state.error.dispose()
        return failed(error)
      }
      if (pending.size === 0) return failed("The script awaits a promise that can never settle.")
      if ((await Promise.race([aborted, Promise.race(pending)])) === "aborted")
        return failed("The script was cancelled.")
    }
  } finally {
    finished = true
    calls.abort()
    for (const deferred of deferreds) deferred.dispose()
    script?.dispose()
    context.dispose()
    runtime.dispose()
  }
}
