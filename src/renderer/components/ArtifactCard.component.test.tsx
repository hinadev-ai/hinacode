import { expect, test, vi } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { MessagePart } from "../../shared/domain.ts"
import "../index.css"
import { ArtifactCard } from "./ArtifactCard.tsx"
import { FindPatternContext } from "./FindHighlight.tsx"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const markdown = `# Release plan

> [!NOTE]
> Ship the editor **on Friday**, after one [dogfood](https://example.com) week.

## Problem

Agents write documents nobody can edit.

## Design

- [x] Store
- [ ] Editor
`

const publishDocument = (input: Record<string, unknown>, status: ToolCall["status"] = "done"): ToolCall => ({
  type: "tool_call",
  callId: "call-1",
  name: "mcp__hinacode__publish_document",
  input,
  status,
})

const published = 'Published document doc-1 version 2: "Release plan". To update it, pass id "doc-1" and revision 4.'

test("shows the kind, version, title and lede of a published document", async () => {
  await render(
    <ArtifactCard call={publishDocument({ title: "Release plan", markdown })} result={published} onOpen={() => {}} />,
  )

  const card = page.getByRole("button", { name: "Open Release plan" })
  await expect
    .element(card)
    .toHaveTextContent("Document·v2Release planShip the editor on Friday, after one dogfood week.")
})

test("opens the published artifact by its id", async () => {
  const onOpen = vi.fn()
  await render(
    <ArtifactCard call={publishDocument({ title: "Release plan", markdown })} result={published} onOpen={onOpen} />,
  )

  await page.getByRole("button", { name: "Open Release plan" }).click()

  expect(onOpen).toHaveBeenCalledWith("doc-1")
})

test("says it is publishing while the call runs", async () => {
  await render(
    <ArtifactCard
      call={publishDocument({ title: "Release plan", markdown }, "running")}
      result={null}
      onOpen={() => {}}
    />,
  )

  const card = page.getByRole("button", { name: "Open Release plan" })
  await expect.element(card).toMatchTextContent(/^Document·Publishing…Release plan/)
  await expect.element(card).not.toMatchTextContent(/v2/)
})

test("takes the title of an update from its first heading and lists sections without a lede", async () => {
  const skeleton = "# Startup audit\n\n## Findings\n\n## Causes\n\n## Fixes\n\n## Risks\n\n## Next steps\n"
  await render(
    <ArtifactCard
      call={publishDocument({ id: "doc-1", revision: 3, markdown: skeleton })}
      result={published}
      onOpen={() => {}}
    />,
  )

  await expect
    .element(page.getByRole("button", { name: "Open Startup audit" }))
    .toHaveTextContent("Document·v2Startup auditFindings, Causes, Fixes +2")
})

test("falls back to an untitled page with a wireframe preview while it publishes", async () => {
  const call: ToolCall = {
    type: "tool_call",
    callId: "call-2",
    name: "mcp__hinacode__publish_artifact",
    input: { id: "page-1", files: [{ path: "index.html", content: "<h1>Hi</h1>" }] },
    status: "running",
  }
  await render(<ArtifactCard call={call} result={null} onOpen={() => {}} />)

  await expect
    .element(page.getByRole("button", { name: "Open Untitled artifact" }))
    .toHaveTextContent("Page·Publishing…Untitled artifact")
})

test("titles an update that leaves out its title with the name it was published under", async () => {
  const call: ToolCall = {
    type: "tool_call",
    callId: "call-3",
    name: "mcp__hinacode__publish_whiteboard",
    input: { id: "board-1", elements: [{ id: "note", type: "rectangle", x: 0, y: 0 }] },
    status: "done",
  }
  await render(
    <ArtifactCard
      call={call}
      result='Published whiteboard board-1 version 3: "Feedback Loop". Pass id "board-1" to publish_whiteboard to add, change or remove elements.'
      onOpen={() => {}}
    />,
  )

  await expect
    .element(page.getByRole("button", { name: "Open Feedback Loop" }))
    .toHaveTextContent("Whiteboard·v3Feedback Loop")
})

test("highlights a search match in the title", async () => {
  await render(
    <FindPatternContext value={/plan/giu}>
      <ArtifactCard call={publishDocument({ title: "Release plan", markdown })} result={published} onOpen={() => {}} />
    </FindPatternContext>,
  )

  await expect
    .element(page.getByRole("button", { name: "Open Release plan" }).getByText("plan", { exact: true }))
    .toBeVisible()
  expect(document.querySelector("mark[data-find-match]")?.textContent).toBe("plan")
})
