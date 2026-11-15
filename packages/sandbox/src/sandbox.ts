import { setImmediate as yieldToEventLoop } from "node:timers/promises"
import variant from "@jitl/quickjs-singlefile-mjs-release-sync"
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten-core"

export type HostFunction = (args: ReadonlyArray<unknown>, signal: AbortSignal) => unknown

export interface Globals {
  readonly [name: string]: HostFunction | Globals
}

export interface Limits {
  readonly memoryBytes: number
  readonly sliceMs: number
  readonly outputChars: number
}

export interface RunScriptOptions {
  readonly code: string
  readonly globals?: Globals
  readonly signal?: AbortSignal
  readonly limits?: Partial<Limits>
}

export type ScriptOutcome =
  | { readonly _tag: "Completed"; readonly output: string }
  | { readonly _tag: "Failed"; readonly output: string; readonly error: string }

export const DEFAULT_LIMITS: Limits = { memoryBytes: 512 * 1024 * 1024, sliceMs: 500, outputChars: 40_000 }

export const OUT_OF_MEMORY = "The script ran out of memory in the sandbox."

const WASM_PAGE_BYTES = 64 * 1024
const HEAP_SLACK_BYTES = 1024 * 1024

interface Binding {
  readonly path: ReadonlyArray<string>
  readonly run: HostFunction
}

const flatten = (globals: Globals, parent: ReadonlyArray<string> = []): ReadonlyArray<Binding> =>
  Object.entries(globals).flatMap(([name, value]) =>
    typeof value === "function" ? [{ path: [...parent, name], run: value }] : flatten(value, [...parent, name]),
  )

const PRELUDE = `
const call = __call, print = __print, paths = JSON.parse(__paths)
delete globalThis.__call
delete globalThis.__print
delete globalThis.__paths
const describe = (value) => typeof value === "string" ? value : value instanceof Error ? String(value) : JSON.stringify(value, null, 2) ?? String(value)
globalThis.console = Object.freeze(Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) =>
  [level, (...values) => print(values.map(describe).join(" "))])))
const tree = Object.create(null)
paths.forEach((path, id) => {
  let node = tree
  for (const key of path.slice(0, -1)) node = Object.hasOwn(node, key) ? node[key] : (node[key] = Object.create(null))
  node[path[path.length - 1]] = (...args) =>
    call(id, JSON.stringify(args)).then(JSON.parse, (message) => { throw new Error(message) })
})
const freeze = (node) => typeof node === "function" ? node : Object.freeze(Object.fromEntries(Object.entries(node).map(([key, value]) => [key, freeze(value)])))
for (const [name, node] of Object.entries(tree))
  Object.defineProperty(globalThis, name, { value: freeze(node), enumerable: true, configurable: true })
Object.defineProperty(globalThis, "__describe", { value: describe })
`

const wrap = (code: string) =>
  `(async () => {${code}\n})().then((value) => value === undefined ? "" : __describe(value), (error) => {
  throw error instanceof Error ? [String(error), error.stack ?? ""].join("\\n").trim() : __describe(error)
})`

const boundedText = (maxChars: number) => {
  const half = maxChars / 2
  let head = ""
  let tail = ""
  let total = 0
  return {
    append: (line: string) => {
      const text = total === 0 ? line : `\n${line}`
      total += text.length
      const room = half - head.length
      head += text.slice(0, Math.max(room, 0))
      tail = (tail + text.slice(Math.max(room, 0))).slice(-half)
    },
    text: () => {
      const omitted = total - head.length - tail.length
      return omitted === 0 ? head + tail : `${head}\n… ${omitted} characters omitted …\n${tail}`
    },
  }
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

export const runScript = async ({
  code,
  globals = {},
  signal = new AbortController().signal,
  limits: overrides,
}: RunScriptOptions): Promise<ScriptOutcome> => {
  const limits = { ...DEFAULT_LIMITS, ...overrides }
  const bindings = flatten(globals)
  const memory = new WebAssembly.Memory({ initial: 256, maximum: Math.ceil(limits.memoryBytes / WASM_PAGE_BYTES) })
  const quickJs = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmMemory: memory }))
  const runtime = quickJs.newRuntime()
  const context = runtime.newContext()
  const calls = new AbortController()
  const pending = new Set<Promise<void>>()
  const deferreds = new Set<QuickJSDeferredPromise>()
  const output = boundedText(limits.outputChars)
  let sliceDeadline = 0
  let overran = false
  let outOfMemory = false
  let finished = false

  runtime.setMaxStackSize(1024 * 1024)
  runtime.setInterruptHandler(() => {
    overran ||= performance.now() > sliceDeadline
    return overran
  })

  const startSlice = () => {
    sliceDeadline = performance.now() + limits.sliceMs
  }

  const failed = (error: string): ScriptOutcome => ({
    _tag: "Failed",
    output: output.text(),
    error: overran
      ? `The script computed for more than ${limits.sliceMs} ms without awaiting anything, so it was stopped.`
      : outOfMemory || error.startsWith("InternalError: out of memory")
        ? OUT_OF_MEMORY
        : error,
  })

  const heapCanHold = (text: string) =>
    memory.buffer.byteLength + Buffer.byteLength(text) + HEAP_SLACK_BYTES <= limits.memoryBytes

  const settle = (deferred: QuickJSDeferredPromise, outcome: { ok: string } | { error: string }) => {
    if (finished) return
    deferreds.delete(deferred)
    const text = "ok" in outcome ? outcome.ok : outcome.error
    if (!heapCanHold(text)) {
      outOfMemory = true
      return deferred.dispose()
    }
    const value = context.newString(text)
    if ("ok" in outcome) deferred.resolve(value)
    else deferred.reject(value)
    value.dispose()
    deferred.dispose()
  }

  const call = context.newFunction("__call", (idHandle, argsHandle) => {
    const binding = bindings[context.getNumber(idHandle)]
    const args: unknown = JSON.parse(context.getString(argsHandle))
    const deferred = context.newPromise()
    deferreds.add(deferred)
    const task = Promise.resolve()
      .then(() => {
        if (binding === undefined || !Array.isArray(args)) throw new Error("No such host function.")
        return binding.run(args, calls.signal)
      })
      .then(
        (value) => settle(deferred, { ok: JSON.stringify(value) ?? "null" }),
        (error: unknown) => settle(deferred, { error: error instanceof Error ? error.message : String(error) }),
      )
      .catch(() => {
        outOfMemory = true
      })
      .finally(() => pending.delete(task))
    pending.add(task)
    return deferred.handle
  })
  const print = context.newFunction("__print", (line) => {
    output.append(context.getString(line))
  })
  const paths = context.newString(JSON.stringify(bindings.map(({ path }) => path)))
  context.setProp(context.global, "__call", call)
  context.setProp(context.global, "__print", print)
  context.setProp(context.global, "__paths", paths)
  call.dispose()
  print.dispose()
  paths.dispose()

  const aborted = new Promise<"aborted">((resolve) => {
    if (signal.aborted) resolve("aborted")
    signal.addEventListener("abort", () => resolve("aborted"), { once: true })
  })

  let script: QuickJSHandle | undefined
  const run = async (): Promise<ScriptOutcome> => {
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
        if (value !== "") output.append(value)
        state.value.dispose()
        return { _tag: "Completed", output: output.text() }
      }
      if (state.type === "rejected") {
        const error = errorText(context, state.error)
        state.error.dispose()
        return failed(error)
      }
      if (pending.size === 0) return failed("The script awaits a promise that can never settle.")
      if ((await Promise.race([aborted, Promise.race(pending)])) === "aborted")
        return failed("The script was cancelled.")
      await yieldToEventLoop()
      if (signal.aborted) return failed("The script was cancelled.")
      if (outOfMemory) return failed(OUT_OF_MEMORY)
    }
  }

  const outcome = await run().catch(() => failed(OUT_OF_MEMORY))
  finished = true
  calls.abort()
  try {
    for (const deferred of deferreds) deferred.dispose()
    script?.dispose()
    context.dispose()
    runtime.dispose()
    return outcome
  } catch {
    return failed(OUT_OF_MEMORY)
  }
}
