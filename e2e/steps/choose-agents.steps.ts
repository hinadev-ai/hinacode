import { expect } from "@playwright/test"
import { ProviderId } from "../../src/shared/agent.ts"
import type { HinacodeApp } from "../support/app.ts"
import { AfterScenario, Given, Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

const providerOf: Record<string, ProviderId> = {
  "Claude Code": "claude",
  Codex: "codex",
  "Muse Code": "muse",
  Cursor: "cursor",
  opencode: "opencode",
}

const agentSwitch = (app: HinacodeApp, agent: string) => app.page.getByRole("switch", { name: agent, exact: true })

Given("HinaCode has not asked which agents to use", ({ seed }) => {
  seed.setting("enabledProviders", null)
})

AfterScenario({ tags: "@choose-agents" }, async ({ app }) => {
  await rpc(app.page, "settings.set", { enabledProviders: ProviderId.literals })
  await app.reload()
})

Given("only {string} is enabled", async ({ app }, agent: string) => {
  await rpc(app.page, "settings.set", { enabledProviders: [providerOf[agent]!] })
  await app.reload()
})

When("the app reloads", async ({ app }) => {
  await app.reload()
})

Then("HinaCode asks which agents to use", async ({ app }) => {
  await expect(app.page.getByRole("heading", { name: "Choose your agents", exact: true })).toBeVisible()
  await expect(app.page.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0)
  for (const agent of Object.keys(providerOf)) {
    await expect(agentSwitch(app, agent)).toBeVisible()
  }
})

Then("Start is disabled until an agent is on", async ({ app }) => {
  for (const agent of await app.page.getByRole("switch").all()) await agent.uncheck()
  await expect(app.page.getByRole("button", { name: "Start", exact: true })).toBeDisabled()
})

When("I turn on only {string} and {string}", async ({ app }, first: string, second: string) => {
  for (const agent of await app.page.getByRole("switch").all()) await agent.uncheck()
  await agentSwitch(app, first).check()
  await agentSwitch(app, second).check()
})

When("I press Start", async ({ app }) => {
  await app.page.getByRole("button", { name: "Start", exact: true }).click()
})

Then("the app opens", async ({ app }) => {
  await expect(app.page.getByRole("link", { name: "Settings", exact: true })).toBeVisible()
})

Then("the enabled agents are {string}", async ({ app }, expected: string) => {
  await expect
    .poll(async () => (await rpc(app.page, "settings.get", undefined)).enabledProviders?.join(", "))
    .toBe(expected)
})

Then("the agent {string} cannot be turned off", async ({ app }, agent: string) => {
  await expect(agentSwitch(app, agent)).toBeChecked()
  await expect(agentSwitch(app, agent)).toBeDisabled()
})

When("I turn on the agent {string}", async ({ app }, agent: string) => {
  await agentSwitch(app, agent).check()
})
