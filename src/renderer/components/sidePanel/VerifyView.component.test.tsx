import { beforeEach, expect, test } from "vitest"
import { page, userEvent } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { Artifact, ArtifactFeedback, VerifySpec } from "../../../shared/artifact.ts"
import { artifactUrl } from "../../../shared/channels.ts"
import type { HinacodeBridge, PushEvent } from "../../../shared/contract.ts"
import type { Thread } from "../../../shared/domain.ts"
import "../../index.css"
import { useArtifacts } from "../../stores/artifacts.ts"
import { ArtifactsHeader, ArtifactsView } from "./ArtifactsView.tsx"

const verification: Artifact = {
  id: "settings-check",
  kind: "verify",
  title: "Settings page",
  entry: "verify.json",
  version: 2,
  files: [
    { path: "verify.json", type: "application/json", size: 10 },
    { path: "actual/settings.png", type: "image/png", size: 10 },
  ],
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
  threadId: "t-1",
}

const spec: VerifySpec = {
  notes: "Built the **settings** page.",
  expected: [{ label: "Approved mock", artifactId: "gone-artifact" }],
  actual: [{ label: "Settings at 1280px", path: "actual/settings.png" }],
}

let feedback: ArtifactFeedback = { comments: [], verdicts: [] }
let decided: Array<unknown> = []
const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()

const bridge: HinacodeBridge = {
  rpc: async (method, payload) => {
    if (method === "artifacts.list") return { result: [verification] }
    if (method === "artifacts.file")
      return { result: { dataUrl: `data:application/json;base64,${btoa(JSON.stringify(spec))}` } }
    if (method === "artifacts.feedback") return { result: feedback }
    if (method === "artifacts.decide") {
      decided.push(payload)
      const { version, decision, reason } = payload as { version: number; decision: "pass" | "reject"; reason: string }
      feedback = {
        ...feedback,
        verdicts: [...feedback.verdicts, { version, decision, reason, decidedAt: "2026-11-08T01:00:00.000Z" }],
      }
      return { result: feedback }
    }
    if (method === "environments.list") return { result: { clouds: [] } }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const thread = { id: "t-1" } as Thread

beforeEach(() => {
  feedback = {
    comments: [],
    verdicts: [{ version: 1, decision: "pass", reason: "", decidedAt: "2026-11-07T00:00:00.000Z" }],
  }
  decided = []
  useArtifacts.getState().select(thread.id, verification.id)
})

const openVerification = async () => {
  await render(
    <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <ArtifactsHeader thread={thread} />
      <ArtifactsView thread={thread} />
    </div>,
  )
  await expect.element(page.getByRole("region", { name: "Actual" })).toBeInTheDocument()
}

test("shows what was approved beside what was built, pending for a new version, without an export menu", async () => {
  await openVerification()

  await expect.element(page.getByText("settings", { exact: true })).toBeInTheDocument()
  await expect
    .element(page.getByRole("region", { name: "Actual" }).getByRole("img", { name: "Settings at 1280px" }))
    .toHaveAttribute("src", `${artifactUrl(verification.id, "actual/settings.png")}?v=2`)
  await expect
    .element(page.getByRole("region", { name: "Expected" }).getByText("Artifact gone-artifact is gone"))
    .toBeInTheDocument()
  await expect.element(page.getByText("Pending", { exact: true })).toBeInTheDocument()
  await expect.element(page.getByRole("button", { name: "Export" })).not.toBeInTheDocument()
})

test("passes the current version", async () => {
  await openVerification()

  await page.getByRole("button", { name: "Pass", exact: true }).click()

  await expect.element(page.getByText("Passed", { exact: true })).toBeInTheDocument()
  expect(decided).toEqual([{ id: verification.id, version: 2, decision: "pass", reason: "" }])
  await expect.element(page.getByRole("button", { name: "Pass", exact: true })).toHaveAttribute("aria-pressed", "true")
})

test("rejects only with a reason, then lets the developer change the decision", async () => {
  await openVerification()

  await page.getByRole("button", { name: "Reject", exact: true }).click()
  const form = page.getByRole("form", { name: "Reason" })
  const reason = form.getByRole("textbox", { name: "Reason" })
  await expect.element(reason).toHaveFocus()
  await form.getByRole("button", { name: "Reject" }).click()
  expect(decided).toEqual([])
  expect((reason.element() as HTMLTextAreaElement).validity.valueMissing).toBe(true)

  await userEvent.keyboard("   ")
  await form.getByRole("button", { name: "Reject" }).click()
  expect(decided).toEqual([])

  await reason.fill("The spacing is off")
  await form.getByRole("button", { name: "Reject" }).click()

  await expect.element(page.getByText("Rejected: The spacing is off")).toBeInTheDocument()
  await expect.element(form).not.toBeInTheDocument()
  expect(decided).toEqual([{ id: verification.id, version: 2, decision: "reject", reason: "The spacing is off" }])

  await page.getByRole("button", { name: "Pass", exact: true }).click()
  await expect.element(page.getByText("Passed", { exact: true })).toBeInTheDocument()
  expect(decided).toHaveLength(2)
})
