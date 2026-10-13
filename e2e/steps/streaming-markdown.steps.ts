import { expect, type Page } from "@playwright/test"
import { randomUUID } from "node:crypto"
import type { AgentEvent } from "../../src/shared/agent.ts"
import type { TranscriptPush } from "../../src/shared/contract.ts"
import type { Message, Thread } from "../../src/shared/domain.ts"
import type { KkcodeApp } from "../support/app.ts"
import { Then, When } from "../support/fixtures.ts"
import { rpc } from "../support/rpc.ts"

interface Stream {
  readonly thread: Thread
  readonly message: Message
  seq: number
  text: string
  firstBoundary?: Awaited<ReturnType<typeof firstBoundaryText>>
  firstToolBoundary?: Awaited<ReturnType<typeof firstBoundaryText>>
  readingPosition?: number
}

const streams = new WeakMap<KkcodeApp, Stream>()
const streamOf = (app: KkcodeApp) => {
  const stream = streams.get(app)
  if (!stream) throw new Error("no active acceptance stream")
  return stream
}
const article = (page: Page) => page.locator("article[aria-busy]")
const renderedHtml = (page: Page) =>
  article(page).evaluate((node) => {
    const clone = node.cloneNode(true)
    if (!(clone instanceof HTMLElement)) throw new Error("assistant article is not HTML")
    for (const row of clone.querySelectorAll('[data-slot="worked-for"]')) row.remove()
    const generatedIds = new Map<string, string>()
    for (const element of clone.querySelectorAll("[id]")) {
      if (/^(base-ui-|_r_\w+_$|:r\w+:$)/.test(element.id)) {
        generatedIds.set(element.id, `generated-${generatedIds.size}`)
      }
    }
    for (const element of clone.querySelectorAll("*")) {
      for (const attribute of ["id", "aria-controls", "aria-describedby", "aria-labelledby"]) {
        const value = element.getAttribute(attribute)
        if (value !== null) {
          element.setAttribute(
            attribute,
            value
              .split(" ")
              .map((id) => generatedIds.get(id) ?? id)
              .join(" "),
          )
        }
      }
    }
    return clone.innerHTML
  })
const eventPush = (stream: Stream, event: AgentEvent): TranscriptPush => ({
  type: "thread.event",
  threadId: stream.thread.id,
  seq: ++stream.seq,
  event,
})

// Observe the first boundary render: retrying later could hide text appearing only on the cadence timer.
const firstBoundaryText = async (page: Page, selector: string) => {
  const observation = await page.evaluateHandle(
    (boundary) => ({
      text: new Promise<string>((resolve) => {
        const root = document.getElementById("root")
        if (!root) throw new Error("no renderer root")
        const observer = new MutationObserver(() => {
          if (!document.querySelector(boundary)) return
          observer.disconnect()
          resolve(document.querySelector("article[aria-busy]")?.textContent ?? "")
        })
        observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
      }),
    }),
    selector,
  )
  return async () => {
    try {
      return await observation.evaluate((value) => value.text)
    } finally {
      await observation.dispose()
    }
  }
}

When("the agent starts streaming in {string}", async ({ app, names }, title: string) => {
  await expect(app.page.getByRole("heading", { name: "Do anything", exact: true })).toBeVisible()
  const thread = (await rpc(app.page, "threads.list", undefined)).find((item) => item.title === names.of(title))
  if (!thread) throw new Error(`no seeded thread named ${title}`)
  const { seq } = await rpc(app.page, "threads.transcript", { threadId: thread.id })
  const message: Message = {
    id: randomUUID(),
    threadId: thread.id,
    role: "assistant",
    parts: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
    usage: null,
  }
  const stream: Stream = { thread, message, seq, text: "" }
  streams.set(app, stream)
  await app.pushEvents([
    { type: "thread.updated", thread: { ...thread, status: "running" } },
    { type: "message.created", seq: ++stream.seq, message },
  ])
  await expect(article(app.page)).toHaveAttribute("aria-busy", "true")
})

When("the agent appends Markdown", async ({ app }, text: string) => {
  const stream = streamOf(app)
  stream.text += text
  await app.pushEvents([eventPush(stream, { type: "text_delta", text })])
})

Then("the reply shows Writing while its trailing text is incomplete", async ({ app }) => {
  await expect(article(app.page)).toHaveText("Writing…")
  await expect(article(app.page).locator("pre code, table, a")).toHaveCount(0)
})

When("the agent finishes its reply", async ({ app }) => {
  const stream = streamOf(app)
  await app.pushEvents([eventPush(stream, { type: "turn_completed" })])
  await expect(article(app.page)).toHaveAttribute("aria-busy", "false")
  await expect(article(app.page)).not.toContainText("Writing…")
})

Then("the Markdown link {string} points to {string}", async ({ app }, label: string, href: string) => {
  await expect(article(app.page).getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href)
})

Then("the code block contains {string}", async ({ app }, text: string) => {
  await expect(article(app.page).locator("pre code")).toHaveText(text)
})

Then("there is no Markdown table yet", async ({ app }) => {
  await expect(article(app.page)).toContainText("| Name | Value |")
  await expect(article(app.page).getByRole("table")).toHaveCount(0)
})

Then("the Markdown table has a row {string} with value {string}", async ({ app }, name: string, value: string) => {
  const table = article(app.page).getByRole("table")
  await expect(table.getByRole("columnheader")).toHaveText(["Name", "Value"])
  await expect(
    table
      .getByRole("row")
      .filter({ has: app.page.getByRole("cell", { name, exact: true }) })
      .getByRole("cell"),
  ).toHaveText([name, value])
})

Then("the completed Markdown exactly matches its full snapshot", async ({ app }) => {
  const stream = streamOf(app)
  const rendered = article(app.page)
  await expect(rendered).toHaveAttribute("aria-busy", "false")
  const html = await renderedHtml(app.page)
  const snapshot: Message = {
    ...stream.message,
    completedAt: new Date().toISOString(),
    parts: [{ type: "text", text: stream.text }],
  }
  await app.pushEvents([
    {
      type: "message.updated",
      seq: ++stream.seq,
      message: { ...snapshot, parts: [{ type: "text", text: "Replacement" }] },
    },
  ])
  await expect(rendered.locator(":scope > div > p")).toHaveText(["Replacement"])
  await app.pushEvents([{ type: "message.updated", seq: ++stream.seq, message: snapshot }])
  await expect.poll(() => renderedHtml(app.page)).toBe(html)
})

When("the agent requests a tool and approval behind queued text", async ({ app }) => {
  const stream = streamOf(app)
  stream.firstToolBoundary = await firstBoundaryText(app.page, 'article [title="Running"]')
  stream.firstBoundary = await firstBoundaryText(app.page, '[aria-labelledby="approval-stream-approval"]')
  await app.pushEvents([
    eventPush(stream, { type: "text_delta", text: "Before tool." }),
    eventPush(stream, {
      type: "tool_call_started",
      callId: "stream-tool",
      name: "Read",
      input: { file_path: "README.md" },
    }),
    eventPush(stream, { type: "text_delta", text: "After tool." }),
    eventPush(stream, { type: "reasoning_delta", text: "Check the result." }),
    eventPush(stream, { type: "text_delta", text: "Before approval." }),
    eventPush(stream, {
      type: "approval_requested",
      request: {
        id: "stream-approval",
        threadId: stream.thread.id,
        provider: stream.thread.provider,
        kind: "tool",
        title: "Read the repository instructions",
        detail: "README.md",
      },
    }),
    { type: "thread.updated", thread: { ...stream.thread, status: "awaiting_approval" } },
  ])
})

Then("the approval first appears with finished text and Writing for the trailing text", async ({ app }) => {
  const stream = streamOf(app)
  if (!stream.firstBoundary || !stream.firstToolBoundary) throw new Error("boundary observations were not armed")
  expect(await stream.firstToolBoundary()).toContain("Before tool.")
  const text = await stream.firstBoundary()
  expect(text).toContain("Before tool.")
  expect(text).toContain("After tool.")
  expect(text).not.toContain("Before approval.")
  expect(text).toContain("Writing…")
  await expect(app.page.getByRole("region", { name: "Claude Code needs your approval" })).toBeVisible()
  await expect(app.page.getByRole("button", { name: "Allow", exact: true })).toBeEnabled()
})

Then("the transcript keeps text on both sides of the tool and reasoning", async ({ app }) => {
  const rendered = article(app.page)
  await expect(rendered.locator(":scope > div > p")).toHaveText(["Before tool.", "After tool."])
  await expect(rendered.getByRole("button", { name: /Read.*README\.md.*Running/ })).toBeVisible()
  await rendered.getByRole("button", { name: "Reasoning", exact: true }).click()
  await expect(rendered).toContainText("Check the result.")
  expect(await rendered.evaluate((node) => Array.from(node.children, (child) => child.textContent))).toEqual([
    "Before tool.",
    "ReadREADME.mdRunning",
    "After tool.",
    "ReasoningCheck the result.",
    "Writing…",
  ])
})

When("the tool and approval finish", async ({ app }) => {
  const stream = streamOf(app)
  await app.pushEvents([
    eventPush(stream, {
      type: "tool_call_finished",
      callId: "stream-tool",
      output: "Repository instructions",
      isError: false,
    }),
    eventPush(stream, { type: "approval_resolved", requestId: "stream-approval" }),
    eventPush(stream, { type: "turn_completed" }),
    { type: "thread.updated", thread: { ...stream.thread, status: "idle" } },
  ])
})

Then("the tool result is inspectable and the approval disappears", async ({ app }) => {
  const rendered = article(app.page)
  await expect(app.page.getByRole("button", { name: "Allow", exact: true })).toHaveCount(0)
  await rendered.getByRole("button", { name: /Read.*README\.md.*Done/ }).click()
  await expect(rendered.getByRole("heading", { name: "Output", exact: true })).toBeVisible()
  await expect(rendered.locator("pre").last()).toHaveText("Repository instructions")
  await expect(rendered).toHaveAttribute("aria-busy", "false")
  await expect(rendered).toContainText("Before approval.")
  await expect(rendered).not.toContainText("Writing…")
})

When("the agent sends its final text and {word} in one burst", async ({ app }, ending: string) => {
  const stream = streamOf(app)
  stream.firstBoundary = await firstBoundaryText(app.page, 'article[aria-busy="false"]')
  const event: AgentEvent =
    ending === "completes"
      ? { type: "turn_completed", usage: { inputTokens: 1, outputTokens: 2 } }
      : { type: "turn_failed", message: "Interrupted locally" }
  await app.pushEvents([
    eventPush(stream, { type: "text_delta", text: "Final **queued** text." }),
    eventPush(stream, event),
    { type: "thread.updated", thread: { ...stream.thread, status: "idle" } },
  ])
})

Then("the first completed rendering contains its final text and {word}", async ({ app }, ending: string) => {
  const stream = streamOf(app)
  if (!stream.firstBoundary) throw new Error("completion observation was not armed")
  const text = await stream.firstBoundary()
  expect(text).toMatch(
    ending === "completes"
      ? /^Worked for \d{2}:\d{2}Final queued text\.$/
      : /^Worked for \d{2}:\d{2}Final queued text\.Error: Interrupted locally$/,
  )
  await expect(article(app.page).locator("strong")).toHaveText(
    ending === "completes" ? ["queued"] : ["queued", "Error:"],
  )
  await expect(app.page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
})

const scrollContainer = (page: Page) =>
  page
    .locator('div[style*="overflow: auto"]')
    .filter({ has: article(page) })
    .first()

When("I type and scroll while the agent streams many Markdown blocks", async ({ app }) => {
  const stream = streamOf(app)
  const initial = Array.from({ length: 80 }, (_, index) => `Paragraph ${index}: inspect **this** output.\n\n`).join("")
  await app.pushEvents([
    eventPush(stream, { type: "text_delta", text: initial }),
    eventPush(stream, { type: "reasoning_delta", text: "Continue the reply." }),
  ])
  await expect(article(app.page)).toContainText("Paragraph 79:")
  const viewport = scrollContainer(app.page)
  await expect.poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(500)
  await expect
    .poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
    .toBeLessThan(5)
  const chunks = Array.from({ length: 300 }, (_, index) => `Live ${index}: **still working**.\n\n`)
  const production = app.pushEvents(
    chunks.map((text) => eventPush(stream, { type: "text_delta", text })),
    10,
  )
  try {
    await expect(article(app.page)).toContainText("Writing…")
    const composer = app.page.getByLabel("Message", { exact: true })
    await composer.pressSequentially("Keep this draft")
    await expect(article(app.page)).not.toContainText("Live 0:")
    await composer.pressSequentially(" while output arrives")
    await expect(composer).toHaveValue("Keep this draft while output arrives")
    await expect
      .poll(() => viewport.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThan(5)
    await expect(article(app.page)).not.toContainText("Live 299:")
    const box = await viewport.boundingBox()
    if (!box) throw new Error("transcript viewport has no bounds")
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await app.page.mouse.wheel(0, -100_000)
    await expect.poll(() => viewport.evaluate((node) => node.scrollTop)).toBeLessThan(10)
    await expect(article(app.page)).not.toContainText("Live 299:")
    stream.readingPosition = await viewport.evaluate((node) => node.scrollTop)
    await production
    await expect(article(app.page)).toContainText("Writing…")
    await expect(article(app.page)).not.toContainText("Live 299:")
  } finally {
    await production
  }
})

Then("my draft and reading position survive the continuing stream", async ({ app }) => {
  const stream = streamOf(app)
  if (stream.readingPosition === undefined) throw new Error("reading position was not recorded")
  await expect(app.page.getByLabel("Message", { exact: true })).toHaveValue("Keep this draft while output arrives")
  await expect.poll(() => scrollContainer(app.page).evaluate((node) => node.scrollTop)).toBe(stream.readingPosition)
  await expect(article(app.page)).toHaveAttribute("aria-busy", "true")
  await app.pushEvents([eventPush(stream, { type: "turn_completed" })])
  await expect(article(app.page)).toContainText("Live 299:")
  await expect(article(app.page)).not.toContainText("Writing…")
  await expect.poll(() => scrollContainer(app.page).evaluate((node) => node.scrollTop)).toBe(stream.readingPosition)
})
