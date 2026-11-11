import { expect, test } from "@effect/vitest"
import { agentInstructions } from "./instructions.ts"
import { defaultSettings } from "../../shared/domain.ts"

const { experimental } = defaultSettings
const environment = {
  gitRepository: true,
  branch: "feat/x",
  cwd: "/wt",
  rootPath: "/repo",
  remote: "git@github.com:o/r.git",
  platform: "darwin",
  scratchDirectory: "/data/scratch/20261029-080509-fix-login-t1",
  tmpDirectory: "/tmp/hc-t1",
} as const

test("keeps a token in an https remote out of the prompt", () => {
  const instructions = agentInstructions(
    experimental,
    {
      ...environment,
      remote: "https://x-access-token:ghp_secret@github.com/o/r.git",
    },
    [],
  )
  expect(instructions).not.toContain("ghp_secret")
  expect(instructions).toContain("remote: `https://github.com/o/r.git`")
})

test("describes the boat desktop when boat is the tiny VM provider", () => {
  const instructions = agentInstructions(
    { ...experimental, tinyVm: true, tinyVmProvider: "boat", tinyVmBoatSize: "large" },
    environment,
    [],
  )
  expect(instructions).toContain("cloud Ubuntu desktop (1920×1080) on boat.dev, size `large`")
  expect(instructions).not.toContain("sbx host")
  expect(instructions).not.toContain("sbx-windows")
  expect(instructions).not.toContain("cua-driver")
})

test("teaches cua-driver on an sbx desktop", () => {
  const instructions = agentInstructions({ ...experimental, tinyVm: true, tinyVmProvider: "sbx" }, environment, [])
  expect(instructions).toContain("disposable Linux desktop")
  expect(instructions).toContain('"session":"vm"')
  expect(instructions).toContain('"delivery_mode":"foreground"')
})

test("says none for a detached HEAD and a repository without an origin", () => {
  const instructions = agentInstructions(experimental, { ...environment, branch: null, remote: null }, [])
  expect(instructions).toContain("git branch: `(none)`")
  expect(instructions).toContain("remote: `(none)`")
})

const group = {
  name: "Shop",
  instructions: "Use pnpm in every repository.",
  skills: [{ name: "release", description: "Ship a release", path: "/data/groups/g1/skills/release/SKILL.md" }],
  members: [],
}

test("adds the group's AGENTS.md and skills after the environment", () => {
  const instructions = agentInstructions(experimental, environment, [], group)
  expect(instructions).toContain('project group "Shop"')
  expect(instructions).toContain("Group AGENTS.md:\nUse pnpm in every repository.")
  expect(instructions).toContain("- `release`: Ship a release (`/data/groups/g1/skills/release/SKILL.md`)")
  expect(instructions.indexOf("<group>")).toBeGreaterThan(instructions.indexOf("</environment>"))
})

test("tells a member thread nothing about conducting", () => {
  expect(agentInstructions(experimental, environment, [], group)).not.toContain("conductor")
})

test("lists the member projects for a conductor thread", () => {
  const instructions = agentInstructions(experimental, environment, [], {
    ...group,
    members: [
      { id: "p1", name: "web", rootPath: "/code/web", repository: "acme/web" },
      { id: "p2", name: "notes", rootPath: "/code/notes", repository: null },
    ],
  })
  expect(instructions).toContain("You are this group's conductor.")
  expect(instructions).toContain("`create_thread`")
  expect(instructions).toContain("- `p1`: web (`/code/web`, acme/web)\n- `p2`: notes (`/code/notes`)")
})

test("leaves out an empty group AGENTS.md", () => {
  const instructions = agentInstructions(experimental, environment, [], { ...group, instructions: "" })
  expect(instructions).toContain("<group>")
  expect(instructions).not.toContain("Group AGENTS.md")
})

test("has no group block outside a group", () => {
  expect(agentInstructions(experimental, environment, [])).not.toContain("<group>")
})
