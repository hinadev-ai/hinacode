import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { Artifact } from "../../../shared/artifact.ts"
import type { HinacodeBridge, PushEvent } from "../../../shared/contract.ts"
import type { Environments, Thread } from "../../../shared/domain.ts"
import "../../index.css"
import { ArtifactsHeader, ArtifactsView } from "./ArtifactsView.tsx"

const artifact = (id: string, title: string, version: number, updatedAt: string, environmentId?: string): Artifact => ({
  id,
  title,
  entry: "index.html",
  version,
  files: [{ path: "index.html", type: "text/html; charset=utf-8", size: 10 }],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt,
  ...(environmentId !== undefined && { environmentId }),
})

let artifacts: ReadonlyArray<Artifact> = [
  artifact("older", "Benchmark chart", 1, "2026-11-01T01:00:00.000Z"),
  artifact("newer", "Release notes", 2, "2026-11-01T02:00:00.000Z", "cloud-1"),
]
const listeners = new Set<(event: typeof PushEvent.Encoded) => void>()

const environments: Environments = {
  clouds: [
    {
      id: "cloud-1",
      name: "build box",
      host: "10.0.0.2",
      port: 7420,
      relay: null,
      source: "pairing",
      createdAt: "2026-11-01T00:00:00.000Z",
      status: "connected",
      lastSeenAt: null,
    },
  ],
}

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "artifacts.list") return { result: artifacts }
    if (method === "environments.list") return { result: environments }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  pathForFile: () => "",
  liquidGlass: false,
}
Object.defineProperty(window, "hinacode", { value: bridge })

const thread = { id: "t-1" } as Thread

test("lists artifacts newest first, opens one in a sandboxed frame, follows new versions and goes back", async () => {
  await render(
    <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
      <ArtifactsHeader thread={thread} />
      <ArtifactsView thread={thread} />
    </div>,
  )

  const rows = page.getByRole("listitem")
  await expect.element(rows.first()).toMatchTextContent(/^Release notes.+ on build box$/)
  await expect.element(rows.nth(1)).toMatchTextContent(/^Benchmark chart/)

  await page.getByRole("button", { name: /Release notes/ }).click()
  const frame = page.getByTitle("Release notes")
  await expect.element(frame).toHaveAttribute("src", "hinacode-artifact://newer/index.html?v=2")
  await expect.element(frame).toHaveAttribute("sandbox", "allow-scripts")

  artifacts = [{ ...artifacts[1]!, version: 3, updatedAt: "2026-11-01T03:00:00.000Z" }, artifacts[0]!]
  for (const listener of listeners) listener({ type: "artifact.updated", artifact: artifacts[0]! })
  await expect.element(frame).toHaveAttribute("src", "hinacode-artifact://newer/index.html?v=3")

  await page.getByRole("button", { name: "Back to artifacts" }).click()
  await expect.element(page.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument()
  await expect.element(rows.first()).toMatchTextContent(/^Release notes/)
})
