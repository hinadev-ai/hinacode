import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Project } from "../../shared/domain.ts"
import { groupMembers, projectGroup, readGroup } from "./groupContext.ts"

const dirs: Array<string> = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const groupFolder = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "hinacode-group-"))
  dirs.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const sidebarGroups = {
  groups: [{ id: "g1", name: "Shop", collapsed: false }],
  groupOf: { "o/web": "g1", p2: "g1", p3: "gone" },
}

describe("projectGroup", () => {
  it("finds a project's group by its repository", () => {
    expect(projectGroup({ id: "p1", kind: "folder", repository: "o/web" }, sidebarGroups)?.name).toBe("Shop")
  })

  it("finds a project's group by its id", () => {
    expect(projectGroup({ id: "p2", kind: "folder", repository: "o/api" }, sidebarGroups)?.name).toBe("Shop")
  })

  it("puts a group project in its own group", () => {
    expect(projectGroup({ id: "g1", kind: "group" }, sidebarGroups)?.name).toBe("Shop")
  })

  it("ignores a group that no longer exists and an ungrouped project", () => {
    expect(projectGroup({ id: "p3", kind: "folder" }, sidebarGroups)).toBeNull()
    expect(projectGroup({ id: "p4", kind: "folder", repository: "o/cli" }, sidebarGroups)).toBeNull()
  })
})

const project = (id: string, kind: Project["kind"], repository?: string): Project => ({
  id,
  name: id,
  rootPath: `/code/${id}`,
  setupScript: null,
  createdAt: "",
  updatedAt: "",
  linearReview: false,
  kind,
  actions: [],
  ...(repository === undefined ? {} : { repository }),
})

describe("groupMembers", () => {
  const projects = [
    project("g1", "group"),
    project("p1", "folder", "o/web"),
    project("p2", "folder"),
    project("p4", "folder", "o/cli"),
    project("chats", "chats"),
  ]

  it("lists the projects of a group project's group", () => {
    expect(groupMembers(project("g1", "group"), projects, sidebarGroups)).toStrictEqual([
      { id: "p1", name: "p1", rootPath: "/code/p1", repository: "o/web" },
      { id: "p2", name: "p2", rootPath: "/code/p2", repository: null },
    ])
  })

  it("keys a second clone of a repository by its id, as the sidebar does", () => {
    const clones = [
      project("g1", "group"),
      project("g2", "group"),
      project("p1", "folder", "o/web"),
      project("p5", "folder", "o/web"),
    ]
    const split = {
      groups: [
        { id: "g1", name: "Shop", collapsed: false },
        { id: "g2", name: "Lab", collapsed: false },
      ],
      groupOf: { "o/web": "g1", p5: "g2" },
    }
    expect(groupMembers(project("g1", "group"), clones, split).map(({ id }) => id)).toStrictEqual(["p1"])
    expect(groupMembers(project("g2", "group"), clones, split).map(({ id }) => id)).toStrictEqual(["p5"])
  })

  it("lists nothing for a member project", () => {
    expect(groupMembers(project("p1", "folder", "o/web"), projects, sidebarGroups)).toStrictEqual([])
  })
})

describe("readGroup", () => {
  it.effect("reads AGENTS.md and the skills that have a name", () =>
    Effect.gen(function* () {
      const root = groupFolder({
        "AGENTS.md": "Use pnpm.\n",
        "skills/release/SKILL.md": '---\nname: release\ndescription: "Ship a release"\n---\nSteps',
        "skills/draft/SKILL.md": "---\ndescription: No name\n---\n",
        "skills/notes.md": "not a skill",
      })
      expect(yield* readGroup("Shop", root)).toStrictEqual({
        name: "Shop",
        instructions: "Use pnpm.",
        skills: [{ name: "release", description: "Ship a release", path: join(root, "skills/release/SKILL.md") }],
        members: [],
      })
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect("reads a group folder without AGENTS.md or skills as empty", () =>
    Effect.gen(function* () {
      expect(yield* readGroup("Shop", groupFolder({}))).toStrictEqual({
        name: "Shop",
        instructions: "",
        skills: [],
        members: [],
      })
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
