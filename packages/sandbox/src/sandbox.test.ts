import { describe, expect, it } from "vitest"
import { DEFAULT_LIMITS, type Globals, OUT_OF_MEMORY, runScript } from "./sandbox.ts"

const MAX_OUTPUT_CHARS = DEFAULT_LIMITS.outputChars

const run = (code: string, globals: Globals = {}) => runScript({ code, globals })

describe("runScript", () => {
  it("returns console output and the returned value", async () => {
    expect(await run(`console.log("a", 1, { b: 2 }); return { done: true }`)).toEqual({
      _tag: "Completed",
      output: 'a 1 {\n  "b": 2\n}\n{\n  "done": true\n}',
    })
  })

  it("binds nested host functions at their paths and passes arguments and results as JSON", async () => {
    const seen: Array<unknown> = []
    const globals: Globals = {
      tools: {
        echo: async (args) => {
          seen.push(args)
          return { echoed: args[0] }
        },
      },
      threads: { messages: { count: ([id]) => (id === "t1" ? 3 : 0) } },
    }
    const outcome = await run(
      `const [a, b] = await Promise.all([tools.echo({ n: 1 }), tools.echo({ n: 2 }, "x")])
       return [a.echoed.n, b.echoed.n, await threads.messages.count("t1")]`,
      globals,
    )
    expect(outcome).toEqual({ _tag: "Completed", output: "[\n  1,\n  2,\n  3\n]" })
    expect(seen).toEqual([[{ n: 1 }], [{ n: 2 }, "x"]])
  })

  it("freezes the bound objects and hides the bridge", async () => {
    const globals: Globals = { files: { read: () => "text" } }
    expect(
      await run(
        `files.read = () => "forged"; files.write = () => null
         return [await files.read(), typeof files.write, typeof __call, typeof __print, Object.isFrozen(files)].join(",")`,
        globals,
      ),
    ).toEqual({ _tag: "Completed", output: "text,undefined,undefined,undefined,true" })
  })

  it("rejects a failed host call with its message, which the script can catch", async () => {
    const failing: Globals = { tools: { fail: () => Promise.reject(new Error("nope")) } }
    expect(await run(`try { await tools.fail() } catch (error) { return error.message }`, failing)).toEqual({
      _tag: "Completed",
      output: "nope",
    })
    expect(await run(`console.log("before"); await tools.fail()`, failing)).toMatchObject({
      _tag: "Failed",
      output: "before",
      error: expect.stringMatching(/^Error: nope/),
    })
  })

  it("has no timers, modules or host globals", async () => {
    expect(await run(`return [typeof setTimeout, typeof require, typeof process, typeof fetch].join(",")`)).toEqual({
      _tag: "Completed",
      output: "undefined,undefined,undefined,undefined",
    })
  })

  it("fails a promise that can never settle instead of hanging", async () => {
    expect(await run(`await new Promise(() => {})`)).toMatchObject({
      _tag: "Failed",
      error: "The script awaits a promise that can never settle.",
    })
  })

  it("stops a script that computes without yielding", async () => {
    expect(await run(`for (;;) {}`)).toMatchObject({
      _tag: "Failed",
      error: `The script computed for more than ${DEFAULT_LIMITS.sliceMs} ms without awaiting anything, so it was stopped.`,
    })
  })

  it.each([
    "const buffers = []; for (;;) buffers.push(new ArrayBuffer(1 << 26))",
    'const parts = []; for (;;) parts.push("x".repeat(1 << 24) + parts.length)',
    "return new ArrayBuffer(2 ** 30).byteLength",
  ])("stops a script that needs more memory than the sandbox has: %s", async (code) => {
    expect(await run(code)).toMatchObject({ _tag: "Failed", error: OUT_OF_MEMORY })
  })

  it("takes its limits from the caller", async () => {
    const limits = { memoryBytes: 64 * 1024 * 1024, outputChars: 10 }
    expect(await runScript({ code: `return new ArrayBuffer(1 << 27).byteLength`, limits })).toMatchObject({
      _tag: "Failed",
      error: OUT_OF_MEMORY,
    })
    expect(await runScript({ code: `return "abcdefghijklmnop"`, limits })).toEqual({
      _tag: "Completed",
      output: "abcde\n… 6 characters omitted …\nlmnop",
    })
  })

  it("fails cleanly when a host result cannot fit in a full sandbox heap", async () => {
    const big: Globals = { tools: { big: async () => "x".repeat(1 << 20) } }
    const code = `const kept = []; try { for (;;) kept.push(new ArrayBuffer(1 << 20)) } catch {}; return (await tools.big()).length`
    expect(await run(code, big)).toMatchObject({ _tag: "Failed", error: OUT_OF_MEMORY })
    expect(await run(`return (await tools.big()).length`, big)).toEqual({ _tag: "Completed", output: "1048576" })
  })

  it("lets the event loop run while a script awaits host calls that answer at once", async () => {
    const controller = new AbortController()
    const channel = new MessageChannel()
    channel.port1.addEventListener("message", () => controller.abort(), { once: true })
    channel.port1.start()
    let calls = 0
    const instant = () => {
      calls += 1
      if (calls === 100) channel.port2.postMessage(null)
      return null
    }
    const outcome = await runScript({
      code: `for (;;) await tools.instant()`,
      globals: { tools: { instant } },
      signal: controller.signal,
    })
    channel.port1.close()
    expect(outcome).toMatchObject({ _tag: "Failed", error: "The script was cancelled." })
    expect(calls).toBeLessThan(200)
  })

  it("keeps only the start and end of a script that logs far more than it returns", async () => {
    const outcome = await run(`const line = "x".repeat(1 << 20); for (let i = 0; i < 64; i++) console.log(line)`)
    const total = 64 * (1 << 20) + 63
    expect(outcome._tag).toBe("Completed")
    expect(outcome.output).toContain(`… ${total - MAX_OUTPUT_CHARS} characters omitted …`)
    expect(outcome.output.length).toBeLessThan(MAX_OUTPUT_CHARS + 100)
  })

  it("reports a syntax error", async () => {
    expect(await run(`return (`)).toMatchObject({ _tag: "Failed", error: expect.stringMatching(/SyntaxError/) })
  })

  it("cancels in flight calls when the caller aborts", async () => {
    const controller = new AbortController()
    let callSignal: AbortSignal | undefined
    const wait = (_args: ReadonlyArray<unknown>, signal: AbortSignal) => {
      callSignal = signal
      controller.abort()
      return new Promise(() => {})
    }
    const outcome = await runScript({
      code: `await tools.wait()`,
      globals: { tools: { wait } },
      signal: controller.signal,
    })
    expect(outcome).toMatchObject({ _tag: "Failed", error: "The script was cancelled." })
    expect(callSignal?.aborted).toBe(true)
  })

  it("keeps the start and end of long output", async () => {
    const outcome = await run(`return "a".repeat(${MAX_OUTPUT_CHARS}) + "end"`)
    expect(outcome._tag).toBe("Completed")
    expect(outcome.output).toMatch(/^a+\n… 3 characters omitted …\na+end$/)
  })
})
