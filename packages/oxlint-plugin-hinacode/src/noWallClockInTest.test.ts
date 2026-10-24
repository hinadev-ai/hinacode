import { noWallClockInTest } from "./noWallClockInTest.ts"
import { ruleTester } from "./ruleTester.ts"

ruleTester.run("no-wall-clock-in-test", noWallClockInTest, {
  valid: [
    `const at = new Date("2026-01-01T00:00:00Z")`,
    `const epoch = new Date(0)`,
    `const parsed = Date.parse("2026-01-01")`,
    `Effect.gen(function* () { yield* TestClock.adjust("1 second") })`,
    `Effect.gen(function* () { yield* Effect.sleep("1 second") })`,
    `const setTimeout = (f) => f(); setTimeout(() => {})`,
    `import { describe } from "vitest"`,
    `clock.setTimeout(done)`,
    `const timers = { setTimeout: fake, Date: FakeDate }`,
    `function wait(performance) { return performance.now() }`,
  ],
  invalid: [
    { code: `setTimeout(done, 10)`, errors: [{ messageId: "wallClock", data: { call: "setTimeout" } }] },
    { code: `setInterval(tick, 10)`, errors: 1 },
    { code: `setImmediate(tick)`, errors: 1 },
    { code: `globalThis.setTimeout(done, 10)`, errors: 1 },
    { code: `import { setTimeout } from "node:timers/promises"`, errors: 1 },
    { code: `import timers from "timers"`, errors: 1 },
    { code: `await page.waitForTimeout(100)`, errors: 1 },
    { code: `const now = Date.now()`, errors: [{ messageId: "wallClock", data: { call: "Date.now" } }] },
    {
      code: `const now = new Date().toISOString()`,
      errors: [{ messageId: "wallClock", data: { call: "new Date()" } }],
    },
    { code: `const started = performance.now()`, errors: 1 },
    { code: `const started = process.hrtime.bigint()`, errors: 1 },
    { code: `const started = process.hrtime()`, errors: 1 },
    {
      code: `import { it } from "vitest"; it("seeds", () => { const now = new Date().toISOString() })`,
      errors: 1,
    },
  ],
})
