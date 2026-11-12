import { beforeEach, expect, it, vi } from "vitest"
import type { RememberedAnswers } from "./connection"

const writes: [file: string, title: unknown][] = []

vi.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: class {
    exists = false
    constructor(
      _directory: string,
      readonly name: string,
    ) {}
    write(content: string) {
      writes.push([this.name, JSON.parse(content)["threads.list"].result[0]])
    }
  },
}))
vi.mock("expo-secure-store", () => ({}))

const { saveAnswers } = await import("./storage")

const listing = (title: string): RememberedAnswers => ({ "threads.list": { payload: "null", result: [title] } })

beforeEach(() => {
  writes.length = 0
})

it("writes only the newest answers when saves queue up", async () => {
  const first = saveAnswers("a", listing("first"))
  const second = saveAnswers("a", listing("second"))
  const third = saveAnswers("a", listing("third"))
  await Promise.all([first, second, third])
  expect(writes).toEqual([["answers-a.json", "third"]])
})

it("writes each server's own newest answers when their saves interleave", async () => {
  await Promise.all([
    saveAnswers("a", listing("a-first")),
    saveAnswers("b", listing("b-first")),
    saveAnswers("a", listing("a-newest")),
    saveAnswers("b", listing("b-newest")),
  ])
  expect(writes).toHaveLength(2)
  expect(Object.fromEntries(writes)).toEqual({ "answers-a.json": "a-newest", "answers-b.json": "b-newest" })
})
