import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { completeDirectory } from "./directoryCompletion.ts"

let home = ""

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "kk-complete-dir-"))
  for (const dir of ["code/app", "code/Api", "code/blog", "code/.config", "Code Notes", "Downloads", "target"])
    mkdirSync(join(home, dir), { recursive: true })
  mkdirSync(join(home, "code/app/.git"))
  writeFileSync(join(home, "code/blog/.git"), "gitdir: elsewhere\n")
  writeFileSync(join(home, "code/archive.txt"), "")
  symlinkSync(join(home, "target"), join(home, "code/alias"))
  symlinkSync(join(home, "code/archive.txt"), join(home, "code/also-a-file"))
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

const complete = (input: string) => Effect.runPromise(completeDirectory(input, home))
const names = async (input: string) => (await complete(input)).map((suggestion) => suggestion.name)

describe("completeDirectory", () => {
  it("lists the children of a directory typed with a trailing separator", async () => {
    expect(await names(`${home}/code/`)).toEqual(["alias", "Api", "app", "blog"])
  })

  it("matches the typed basename as a case-insensitive prefix", async () => {
    expect(await names(`${home}/code/A`)).toEqual(["alias", "Api", "app"])
    expect(await names(`${home}/co`)).toEqual(["code", "Code Notes"])
  })

  it("returns paths without a trailing separator", async () => {
    expect((await complete(`${home}/code/ap`)).map((suggestion) => suggestion.path)).toEqual([
      `${home}/code/Api`,
      `${home}/code/app`,
    ])
  })

  it("shows dot-directories only when the basename starts with a dot", async () => {
    expect(await names(`${home}/code/.`)).toEqual([".config"])
  })

  it("flags directories that contain .git as a file or a folder", async () => {
    const suggestions = await complete(`${home}/code/`)
    expect(suggestions.filter((suggestion) => suggestion.repository).map((suggestion) => suggestion.name)).toEqual([
      "app",
      "blog",
    ])
  })

  it("keeps the ~ form the user typed", async () => {
    expect(await complete("~/code/b")).toEqual([{ path: "~/code/blog", name: "blog", repository: true }])
    expect(await names("~")).toEqual(["code", "Code Notes", "Downloads", "target"])
  })

  it("ignores input that is not a path", async () => {
    expect(await complete("")).toEqual([])
    expect(await complete("owner/repo")).toEqual([])
    expect(await complete("~someone/code")).toEqual([])
  })

  it("returns nothing for a directory that does not exist", async () => {
    expect(await complete(`${home}/missing/`)).toEqual([])
    expect(await complete(`${home}/code/archive.txt/`)).toEqual([])
  })
})
