import { expect, test } from "@effect/vitest"
import { agentInstructions } from "./instructions.ts"

const experimental = { tinyVm: false, tinyVmTemplate: "default", tinyVmProfile: false, tinyVmPasskeys: false }
const environment = { branch: "feat/x", cwd: "/wt", rootPath: "/repo", remote: "git@github.com:o/r.git" }

test("names the thread's branch, paths and remote", () => {
  expect(agentInstructions(experimental, environment)).toContain(`<environment>
  git branch: \`feat/x\`
  current project path: \`/wt\`
  root project path: \`/repo\`
  remote: \`git@github.com:o/r.git\`
</environment>`)
})

test("keeps a token in an https remote out of the prompt", () => {
  const instructions = agentInstructions(experimental, {
    ...environment,
    remote: "https://x-access-token:ghp_secret@github.com/o/r.git",
  })
  expect(instructions).not.toContain("ghp_secret")
  expect(instructions).toContain("remote: `https://github.com/o/r.git`")
})

test("says none for a detached HEAD and a repository without an origin", () => {
  const instructions = agentInstructions(experimental, { ...environment, branch: null, remote: null })
  expect(instructions).toContain("git branch: `(none)`")
  expect(instructions).toContain("remote: `(none)`")
})
