import { describe, expect, test } from "@effect/vitest"
import { hideUserCommands, toCommand } from "./commands.ts"

describe("toCommand", () => {
  test("moves a user or project scope from the end of the description into scope", () => {
    expect(
      toCommand({ name: "kalan-mode", description: "Kalan's working mode. (user)", argumentHint: "" }),
    ).toStrictEqual({
      trigger: "/",
      name: "kalan-mode",
      description: "Kalan's working mode.",
      argumentHint: "",
      scope: "user",
    })
    expect(toCommand({ name: "verify", description: "Drive the app. (project)", argumentHint: "" }).scope).toBe(
      "project",
    )
  })

  test("keeps other sources in the description and marks Claude Code's own commands", () => {
    expect(toCommand({ name: "docs", description: "Edit docs. (claude.ai sync)", argumentHint: "" })).toStrictEqual({
      trigger: "/",
      name: "docs",
      description: "Edit docs. (claude.ai sync)",
      argumentHint: "",
    })
    expect(
      toCommand({ name: "compact", description: "Summarize the conversation", argumentHint: "", builtin: true }),
    ).toStrictEqual({
      trigger: "/",
      name: "compact",
      description: "Summarize the conversation",
      argumentHint: "",
      builtin: true,
    })
  })
})

describe("toCommand with a name that has spaces", () => {
  test("types the skill by its folder, the alias that /name runs, and keeps the name as its label", () => {
    expect(
      toCommand({
        name: "Create PR",
        aliases: ["create-pr"],
        description: "Open a pull request. (user)",
        argumentHint: "",
      }),
    ).toStrictEqual({
      trigger: "/",
      name: "create-pr",
      label: "Create PR",
      description: "Open a pull request.",
      argumentHint: "",
      scope: "user",
    })
  })
})

describe("hideUserCommands", () => {
  test("also disables a renamed user's skill through its directory alias", () => {
    expect(
      hideUserCommands([
        { name: "Create PR", aliases: ["create-pr"], description: "Open a pull request. (user)", argumentHint: "" },
      ]),
    ).toStrictEqual({ "Create PR": "off", "create-pr": "off" })
  })

  test("turns off only the user's own skills and commands", () => {
    expect(
      hideUserCommands([
        { name: "kalan-mode", description: "Kalan's working mode. (user)", argumentHint: "" },
        { name: "verify", description: "Drive the app. (project)", argumentHint: "" },
        { name: "docs", description: "Edit docs. (claude.ai sync)", argumentHint: "" },
        { name: "compact", description: "Summarize the conversation", argumentHint: "", builtin: true },
      ]),
    ).toStrictEqual({ "kalan-mode": "off" })
  })
})
