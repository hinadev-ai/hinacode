import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Db from "../db/client.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import { Projects, layer } from "./Projects.ts"

const dirs: Array<string> = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const repoWith = (files: Record<string, string | Buffer>) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kk-projects-test-")))
  dirs.push(dir)
  execFileSync("git", ["init", "-q", dir])
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const iconOf = (rootPath: string) =>
  Projects.use((projects) =>
    projects
      .create({ name: "repo", rootPath, setupScript: null })
      .pipe(Effect.flatMap((project) => projects.icon(project.id))),
  ).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer, Db.layer(":memory:"))),
        Layer.provide(NodeServices.layer),
      ),
    ),
  )

describe("Projects.icon", () => {
  it.live("reads the project's favicon as a data URL", () =>
    Effect.gen(function* () {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
      const icon = yield* iconOf(repoWith({ "public/favicon.svg": svg }))
      expect(icon).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    }),
  )

  it.live("prefers the root's own favicon over one deeper in the tree", () =>
    Effect.gen(function* () {
      const icon = yield* iconOf(repoWith({ "favicon.ico": "root", "app/icon.png": "app" }))
      expect(icon).toBe(`data:image/x-icon;base64,${Buffer.from("root").toString("base64")}`)
    }),
  )

  it.live("is null without a favicon, and skips one too large to be an icon", () =>
    Effect.gen(function* () {
      expect(yield* iconOf(repoWith({ "README.md": "hi" }))).toBeNull()
      expect(yield* iconOf(repoWith({ "favicon.png": Buffer.alloc(200 * 1024) }))).toBeNull()
    }),
  )
})
