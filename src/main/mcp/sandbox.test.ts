import { describe, expect, it } from "vitest"
import { MAX_OUTPUT_CHARS, runScript, type ScriptHost } from "./sandbox.ts"

const host = (handlers: Record<string, (args: unknown) => Promise<unknown>>): ScriptHost => ({
  tools: Object.keys(handlers),
  call: (name, args) => handlers[name]!(args),
})

const run = (code: string, scriptHost: ScriptHost = host({})) =>
  runScript(code, scriptHost, new AbortController().signal)

describe("runScript", () => {
  it("returns console output and the returned value", async () => {
    expect(await run(`console.log("a", 1, { b: 2 }); return { done: true }`)).toEqual({
      _tag: "Completed",
      output: 'a 1 {\n  "b": 2\n}\n{\n  "done": true\n}',
    })
  })

  it("calls tools in parallel and passes their arguments and results through", async () => {
    const seen: Array<unknown> = []
    const echo = host({
      echo: async (args) => {
        seen.push(args)
        return { echoed: args }
      },
    })
    const outcome = await run(
      `const [a, b] = await Promise.all([tools.echo({ n: 1 }), tools.echo({ n: 2 })]); return [a.echoed.n, b.echoed.n]`,
      echo,
    )
    expect(outcome).toEqual({ _tag: "Completed", output: "[\n  1,\n  2\n]" })
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("rejects a failed tool call with its message, which the script can catch", async () => {
    const failing = host({ fail: () => Promise.reject(new Error("nope")) })
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

  it("refuses a tool the host did not offer", async () => {
    expect(await run(`return await __call("secret_tool", "{}")`)).toMatchObject({
      _tag: "Failed",
      error: expect.stringMatching(/No tool secret_tool/),
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
      error: expect.stringMatching(/ran for more than/),
    })
  })

  it("stops a script that runs out of memory", async () => {
    expect(await run(`const buffers = []; for (;;) buffers.push(new ArrayBuffer(1 << 24))`)).toMatchObject({
      _tag: "Failed",
      error: expect.stringMatching(/out of memory/),
    })
  })

  it("reports a syntax error", async () => {
    expect(await run(`return (`)).toMatchObject({ _tag: "Failed", error: expect.stringMatching(/SyntaxError/) })
  })

  it("cancels in flight calls when the caller aborts", async () => {
    const controller = new AbortController()
    let callSignal: AbortSignal | undefined
    const outcome = runScript(
      `await tools.wait()`,
      {
        tools: ["wait"],
        call: (_name, _args, signal) => {
          callSignal = signal
          controller.abort()
          return new Promise(() => {})
        },
      },
      controller.signal,
    )
    expect(await outcome).toMatchObject({ _tag: "Failed", error: "The script was cancelled." })
    expect(callSignal?.aborted).toBe(true)
  })

  it("keeps the start and end of long output", async () => {
    const outcome = await run(`return "a".repeat(${MAX_OUTPUT_CHARS}) + "end"`)
    expect(outcome._tag).toBe("Completed")
    expect(outcome.output).toMatch(/^a+\n… 3 characters omitted …\na+end$/)
  })
})
