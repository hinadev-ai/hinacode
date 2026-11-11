import { describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { useViewedFiles } from "./viewedFiles.ts"

const storage = vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  return values
})

const KEY = "hinacode.viewedPullRequestFiles"
const stored = () => JSON.parse(storage.get(KEY) ?? "{}") as Record<string, { head: string; paths: Array<string> }>
const pr = (n: number) => `https://github.com/acme/app/pull/${n}`

describe("viewed file marks", () => {
  test("marking a file keeps the marks another window saved after this one opened", () => {
    storage.set(KEY, JSON.stringify({ ...stored(), [pr(2)]: { head: "b", paths: ["other.ts"] } }))

    useViewedFiles.getState().setViewed(pr(1), "a", "mine.ts", true)

    expect(stored()[pr(2)]).toEqual({ head: "b", paths: ["other.ts"] })
    expect(stored()[pr(1)]).toEqual({ head: "a", paths: ["mine.ts"] })
  })

  test("keeps only the most recently reviewed pull requests", () => {
    useViewedFiles.getState().setViewed(pr(0), "a", "file.ts", true)
    for (let n = 1; n < 1000; n++) {
      useViewedFiles.getState().setViewed(pr(n), "a", "file.ts", true)
      if (n % 100 === 0) useViewedFiles.getState().setViewed(pr(0), "a", "again.ts", true)
    }

    expect(Object.keys(stored()).length).toBeLessThan(1000)
    expect(stored()[pr(0)]?.paths).toEqual(["file.ts", "again.ts"])
    expect(stored()[pr(1)]).toBeUndefined()
    expect(stored()[pr(999)]).toBeDefined()
  })
})
