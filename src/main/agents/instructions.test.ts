import { expect, test } from "@effect/vitest"
import { agentInstructions } from "./instructions.ts"

const settings = {
  experimental: { tinyVm: false, tinyVmTemplate: "default", tinyVmProfile: false, tinyVmPasskeys: false },
  agentsMd: { all: "", claude: "", codex: "", muse: "" },
}
const environment = {
  gitRepository: true,
  branch: "feat/x",
  cwd: "/wt",
  rootPath: "/repo",
  remote: "git@github.com:o/r.git",
  platform: "darwin",
} as const

test("names the thread's repository, branch, paths, remote and platform", () => {
  expect(agentInstructions(settings, "claude", environment)).toContain(`<environment>
  is a git repository: true
  git branch: \`feat/x\`
  current project path: \`/wt\`
  root project path: \`/repo\`
  remote: \`git@github.com:o/r.git\`
  platform: darwin
</environment>`)
})

test("keeps a token in an https remote out of the prompt", () => {
  const instructions = agentInstructions(settings, "claude", {
    ...environment,
    remote: "https://x-access-token:ghp_secret@github.com/o/r.git",
  })
  expect(instructions).not.toContain("ghp_secret")
  expect(instructions).toContain("remote: `https://github.com/o/r.git`")
})

test("says none for a detached HEAD and a repository without an origin", () => {
  const instructions = agentInstructions(settings, "claude", { ...environment, branch: null, remote: null })
  expect(instructions).toContain("git branch: `(none)`")
  expect(instructions).toContain("remote: `(none)`")
})

test("adds the shared rules, then the agent's own, to that agent only", () => {
  const agentsMd = { all: "Answer in English.", claude: "Use TodoWrite.", codex: "Use update_plan.", muse: "" }
  const claude = agentInstructions({ ...settings, agentsMd }, "claude", environment)
  expect(claude).toContain("Answer in English.\n\nUse TodoWrite.\n</user-instructions>")
  expect(claude).not.toContain("update_plan")
  expect(agentInstructions({ ...settings, agentsMd }, "muse", environment)).toContain(
    "Answer in English.\n</user-instructions>",
  )
})

test("adds no user block when every part is blank", () => {
  const agentsMd = { all: "  \n", claude: "", codex: "", muse: "" }
  expect(agentInstructions({ ...settings, agentsMd }, "claude", environment)).not.toContain("<user-instructions>")
})
