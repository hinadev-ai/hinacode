import { expect } from "@playwright/test"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Given, Then, When } from "../support/fixtures.ts"
import { callTool, listTools, postAs } from "../support/mcp.ts"
import { rpc } from "../support/rpc.ts"
import { threadDetails } from "../support/ui.ts"

const connected = (agent: { connection: { url: string; headers: { authorization: string } } | null }) => {
  if (!agent.connection) throw new Error("no agent is connected; add the Given step")
  return agent.connection
}

Given("an agent connected to the thread {string}", async ({ app, agent, threadIds }, title: string) => {
  const threadId = threadIds.get(title)
  if (!threadId) throw new Error(`no seeded thread titled ${title}`)
  agent.connection = await rpc(app.page, "mcp.connection", { threadId })
})

When(
  "the agent reviews the changes after I change {string} in my repository",
  async ({ repo, agent }, file: string) => {
    appendFileSync(join(repo, file), "change\n")
    agent.result = await callTool(connected(agent), "review_changes")
  },
)

When("the agent links the pull request {string}", async ({ agent }, url: string) => {
  agent.result = await callTool(connected(agent), "link_pull_request", { url })
})

When("the agent calls {string} with {string}", async ({ agent }, tool: string, args: string) => {
  agent.result = await callTool(connected(agent), tool, JSON.parse(args))
})

When("I unlink {string} in the pull requests panel", async ({ app }, name: string) => {
  const panel = await threadDetails(app.page)
  await panel.getByRole("button", { name: `Unlink ${name}`, exact: true }).click()
})

Then("the agent sees the tools {string}", async ({ agent }, names: string) => {
  const tools = await listTools(connected(agent))
  for (const name of names.split(",").map((tool) => tool.trim())) expect(tools).toContain(name)
})

Then("a request with a wrong credential is rejected", async ({ agent }) => {
  expect(await postAs(connected(agent), "Bearer wrong")).toBe(401)
})

Then("the tool result contains {string}", ({ agent }, text: string) => {
  expect(agent.result?.isError).toBe(false)
  expect(agent.result?.text).toContain(text)
})

Then("the tool fails with {string}", ({ agent }, text: string) => {
  expect(agent.result?.isError).toBe(true)
  expect(agent.result?.text).toContain(text)
})

Then("the pull requests panel lists {string}", async ({ app }, name: string) => {
  const panel = await threadDetails(app.page)
  await expect(panel.getByRole("region", { name: "Pull requests" }).getByRole("link", { name })).toBeVisible()
})

Then("the pull requests panel is empty", async ({ app, agent, threadIds }) => {
  const panel = await threadDetails(app.page)
  await expect(panel.getByRole("region", { name: "Pull requests" })).toContainText("None linked yet")
  const [threadId] = threadIds.values()
  if (agent.connection && threadId) expect(await rpc(app.page, "pullRequests.list", { threadId })).toStrictEqual([])
})
