import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Db from "../db/client.ts"
import * as ClientSettings from "./ClientSettings.ts"
import { Events } from "./Events.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import { groupContext } from "./groupContext.ts"
import * as Projects from "./Projects.ts"

const noEvents = Layer.succeed(Events, { publish: () => Effect.void })

const dirs: Array<string> = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hinacode-group-context-")))
  dirs.push(dir)
  return dir
}

const servicesAt = (dataDir: string) =>
  Layer.mergeAll(
    Projects.layer.pipe(
      Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer.pipe(Layer.provide(noEvents)), Db.layer(":memory:"))),
      Layer.provide(noEvents),
    ),
    ClientSettings.layer(dataDir),
  ).pipe(Layer.provideMerge(NodeServices.layer))

describe("groupContext", () => {
  it.live("reads the group of a member project and nothing for a project outside it", () => {
    const dataDir = tempDir()
    return Effect.gen(function* () {
      const projects = yield* Projects.Projects
      const settings = yield* ClientSettings.ClientSettings
      const member = yield* projects.create({ name: "api", rootPath: join(tempDir(), "api"), setupScript: null })
      const outsider = yield* projects.create({ name: "cli", rootPath: join(tempDir(), "cli"), setupScript: null })
      const groupsDir = join(dataDir, "groups")
      yield* projects.ensureGroups([{ id: "g1", name: "Shop" }], groupsDir)
      mkdirSync(join(groupsDir, "g1", "skills", "release"))
      writeFileSync(join(groupsDir, "g1", "AGENTS.md"), "Use pnpm.")
      writeFileSync(join(groupsDir, "g1", "skills", "release", "SKILL.md"), "---\nname: release\n---\n")
      yield* settings.set({
        sidebarGroups: { groups: [{ id: "g1", name: "Shop", collapsed: false }], groupOf: { [member.id]: "g1" } },
      })

      expect(yield* groupContext(member.id)).toMatchObject({
        name: "Shop",
        instructions: "Use pnpm.",
        skills: [{ name: "release" }],
      })
      expect(yield* groupContext("g1")).toMatchObject({ name: "Shop" })
      expect(yield* groupContext(outsider.id)).toBeNull()
    }).pipe(Effect.provide(servicesAt(dataDir)))
  })
})
