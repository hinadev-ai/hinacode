import { describe, expect, test } from "@effect/vitest"
import type { MessagePart } from "../../shared/domain.ts"
import {
  countToolKinds,
  describeCommand,
  describeToolCall,
  groupToolCalls,
  skillsUsed,
  toolOutputImages,
} from "./toolCall.ts"

const bash = (callId: string, input: object = { command: `echo ${callId}` }): MessagePart => ({
  type: "tool_call",
  callId,
  name: "Bash",
  input,
  status: "done",
})
const read = (callId: string): MessagePart => ({
  type: "tool_call",
  callId,
  name: "Read",
  input: { file_path: "a.ts" },
  status: "done",
})
const text = (value: string): MessagePart => ({ type: "text", text: value })
const thinking = (value: string): MessagePart => ({ type: "reasoning", text: value })

const agent = (callId: string): MessagePart => ({
  type: "tool_call",
  callId,
  name: "Agent",
  input: { description: "Explore" },
  status: "running",
})

describe("groupToolCalls", () => {
  test("folds back-to-back tool calls of any kind into one block that keeps the first part's index", () => {
    const parts = [text("look"), bash("a"), read("r"), bash("c"), text("done")]
    expect(groupToolCalls(parts)).toStrictEqual([
      { type: "part", part: parts[0], index: 0 },
      { type: "tools", parts: [parts[1], parts[2], parts[3]], index: 1 },
      { type: "part", part: parts[4], index: 4 },
    ])
  })

  test("leaves a lone call, calls split by other parts, and sub-agent calls as they are", () => {
    const parts = [bash("a"), text("x"), read("r"), agent("s"), bash("c")]
    expect(groupToolCalls(parts).map((block) => block.type)).toStrictEqual(["part", "part", "part", "part", "part"])
  })

  test("leaves a published artifact out of the fold, from Claude or Codex", () => {
    const claude = { ...bash("p"), name: "mcp__hinacode__publish_artifact", input: { title: "Report" } }
    const codex = { ...bash("q"), name: "publish_artifact", input: { type: "mcpToolCall", server: "hinacode" } }
    const parts = [bash("a"), claude, bash("b"), read("r"), codex, bash("c")]
    expect(groupToolCalls(parts).map((block) => block.type)).toStrictEqual(["part", "part", "tools", "part", "part"])
  })

  test("folds thinking between tool calls into the same block until the agent writes text", () => {
    const parts = [thinking("t1"), bash("a"), thinking("t2"), bash("b"), thinking("t3"), text("done")]
    expect(groupToolCalls(parts)).toStrictEqual([
      { type: "tools", parts: parts.slice(0, 5), index: 0 },
      { type: "part", part: parts[5], index: 5 },
    ])
  })

  test("leaves thinking without any tool call as it is", () => {
    const parts = [thinking("t1"), thinking("t2"), text("done")]
    expect(groupToolCalls(parts).map((block) => block.type)).toStrictEqual(["part", "part", "part"])
  })
})

describe("countToolKinds", () => {
  test("counts calls per kind in summary order and skips kinds that never ran", () => {
    const calls = [read("r1"), bash("a"), read("r2"), { ...read("w"), name: "WebFetch" }] as Array<
      Extract<MessagePart, { type: "tool_call" }>
    >
    expect(countToolKinds(calls)).toStrictEqual([
      { kind: "command", count: 1 },
      { kind: "read", count: 2 },
      { kind: "other", count: 1 },
    ])
  })
})

describe("describeCommand", () => {
  test("prefers the agent's description of the command, else the command itself", () => {
    const described = bash("a", { command: "ls -la", description: "List repo contents" })
    expect(describeCommand(described as Extract<MessagePart, { type: "tool_call" }>)).toBe("List repo contents")
    expect(describeCommand(bash("b", { command: "ls -la" }) as Extract<MessagePart, { type: "tool_call" }>)).toBe(
      "ls -la",
    )
  })
})

const call = (name: string, input: unknown) =>
  ({ type: "tool_call", callId: name, name, input, status: "done" }) as Extract<MessagePart, { type: "tool_call" }>
const codex = (command: string) => call("Bash", { command: `/usr/bin/zsh -lc '${command}'` })

describe("skillsUsed", () => {
  test("reads the skill from Claude's Skill tool and Muse's read_skill tool", () => {
    expect(skillsUsed(call("Skill", { skill: "create-pr" }))).toStrictEqual(["create-pr"])
    expect(skillsUsed(call("read_skill", { name: "verify-hinacode" }))).toStrictEqual(["verify-hinacode"])
  })

  test("treats a Codex command that only reads SKILL.md files as skill use", () => {
    expect(skillsUsed(codex("cat /home/me/.agents/skills/code-review/SKILL.md"))).toStrictEqual(["code-review"])
    expect(
      skillsUsed(codex("sed -n 1,200p .agents/skills/verify-hinacode/SKILL.md .agents/skills/unslop/SKILL.md")),
    ).toStrictEqual(["verify-hinacode", "unslop"])
  })

  test("leaves commands that do more than read skills, and other tools, alone", () => {
    expect(skillsUsed(call("Bash", { command: "cat README.md .agents/skills/verify-hinacode/SKILL.md" }))).toBeNull()
    expect(skillsUsed(call("Bash", { command: "cat .agents/skills/a/SKILL.md && pnpm test" }))).toBeNull()
    expect(skillsUsed(call("Read", { file_path: ".agents/skills/a/SKILL.md" }))).toBeNull()
    expect(skillsUsed(call("Skill", {}))).toBeNull()
  })

  test("counts each skill used as its own kind, even when one command reads several", () => {
    const calls = [
      call("Skill", { skill: "a" }),
      codex("cat skills/b/SKILL.md skills/c/SKILL.md"),
      call("Bash", { command: "ls" }),
    ]
    expect(countToolKinds(calls)).toStrictEqual([
      { kind: "command", count: 1 },
      { kind: "skill", count: 3 },
    ])
  })
})

test("labels every tool the HinaCode MCP server registers", () => {
  const sources = import.meta.glob(
    ["../../main/mcp/tools/*.ts", "!**/*.test.ts", "../../../packages/artifacts/src/tools.ts"],
    {
      query: "?raw",
      import: "default",
      eager: true,
    },
  )
  const names = Object.entries(sources).flatMap(([path, source]) =>
    [
      ...String(source).matchAll(
        path.endsWith("artifacts/src/tools.ts") ? /^ {2}([a-z_]+): tool\(/gm : /make\(\s*"([a-z_]+)"/g,
      ),
    ].map((match) => match[1]!),
  )
  expect(names.length).toBeGreaterThan(30)
  for (const name of names)
    expect(describeToolCall({ name: `mcp__hinacode__${name}`, input: {} }).name).not.toContain("_")
})

const savedImage = {
  id: "image-1",
  name: "image.png",
  path: "/data/attachments/t/image.png",
  mime: "image/png",
  kind: "image",
  bytes: 1,
}

test.each([
  ["a block list", [{ type: "image", mimeType: "image/png", attachment: savedImage }]],
  ["Codex's MCP wrapper", { content: [{ type: "image", mimeType: "image/png", attachment: savedImage }] }],
])("finds the image saved in %s", (_shape, output) => {
  expect(toolOutputImages(output)).toEqual([savedImage])
})

test.each([
  ["no output", undefined],
  ["text", "done"],
  ["an image saved before previews existed", [{ type: "image", mimeType: "image/png" }]],
  ["a malformed attachment", [{ type: "image", attachment: { path: "/etc/passwd" } }]],
])("finds no image in %s", (_shape, output) => {
  expect(toolOutputImages(output)).toEqual([])
})
