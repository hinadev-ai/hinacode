import { expect, it, vi } from "vitest"
import type { RememberedAnswers } from "./connection"

const writes: string[] = []

vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    exists = false
    write(content: string) {
      writes.push(content)
    }
  },
}))
vi.mock("expo-secure-store", () => ({}))

const { saveAnswers } = await import("./storage")

const listing = (title: string): RememberedAnswers => ({ "threads.list": { payload: "null", result: [title] } })

it("writes only the newest answers when saves queue up", async () => {
  const first = saveAnswers("a", listing("first"))
  const second = saveAnswers("a", listing("second"))
  const third = saveAnswers("a", listing("third"))
  await Promise.all([first, second, third])
  expect(writes.map((content) => JSON.parse(content)["threads.list"].result)).toEqual([["third"]])
})
