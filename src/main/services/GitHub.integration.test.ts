import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, test } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { GitHub, layer } from "./GitHub.ts"

const dirs: Array<string> = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kk-github-"))
  dirs.push(dir)
  return dir
}

const repoWithOrigin = (origin: string | null) => {
  const dir = tempDir()
  execFileSync("git", ["init", "-q", dir])
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin])
  return dir
}

const repository = (cwd: string) =>
  Effect.runPromise(
    GitHub.use((github) => github.repository(cwd)).pipe(Effect.provide(layer.pipe(Layer.provide(NodeServices.layer)))),
  )

describe("GitHub.repository", () => {
  test("reads the GitHub repository from origin, over ssh or https", async () => {
    expect(await repository(repoWithOrigin("git@github.com:kjj6198/kkcode.git"))).toStrictEqual({
      owner: "kjj6198",
      name: "kkcode",
    })
    expect(await repository(repoWithOrigin("https://github.com/kjj6198/kkcode"))).toStrictEqual({
      owner: "kjj6198",
      name: "kkcode",
    })
  })

  test("is null without an origin, for another host, or outside a repository", async () => {
    expect(await repository(repoWithOrigin(null))).toBe(null)
    expect(await repository(repoWithOrigin("https://gitlab.com/a/b.git"))).toBe(null)
    expect(await repository(tempDir())).toBe(null)
  })
})
