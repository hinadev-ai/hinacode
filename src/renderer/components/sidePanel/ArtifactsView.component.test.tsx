import { expect, onTestFinished, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { Artifact } from "../../../shared/artifact.ts"
import type { HinacodeBridge, PushEvent } from "../../../shared/contract.ts"
import type { Environments, Thread } from "../../../shared/domain.ts"
import "../../index.css"
import { useArtifacts } from "../../stores/artifacts.ts"
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

const deleted: Array<{ payload: unknown; environment: string | undefined }> = []

const bridge: HinacodeBridge = {
  rpc: async (method, payload, environment) => {
    if (method === "artifacts.list") return { result: artifacts }
    if (method === "artifacts.delete") {
      deleted.push({ payload, environment })
      return { result: undefined }
    }
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
  await expect
    .element(frame)
    .toHaveAttribute("src", expect.stringMatching(/^hinacode-artifact:\/\/newer\/index\.html\?v=2&/))
  await expect.element(frame).toHaveAttribute("sandbox", "allow-scripts")

  artifacts = [{ ...artifacts[1]!, version: 3, updatedAt: "2026-11-01T03:00:00.000Z" }, artifacts[0]!]
  for (const listener of listeners) listener({ type: "artifact.updated", artifact: artifacts[0]! })
  await expect
    .element(frame)
    .toHaveAttribute("src", expect.stringMatching(/^hinacode-artifact:\/\/newer\/index\.html\?v=3&/))

  await page.getByRole("button", { name: "Back to artifacts" }).click()
  await expect.element(page.getByRole("heading", { name: "Artifacts" })).toBeInTheDocument()
  await expect.element(rows.first()).toMatchTextContent(/^Release notes/)
})

test("passes the app theme to the frame and follows a theme switch", async () => {
  await render(<ArtifactsView thread={thread} />)
  await page.getByRole("button", { name: /Release notes/ }).click()
  const frame = page.getByTitle("Release notes")
  const theme = () => JSON.parse(new URL(frame.element().getAttribute("src")!).searchParams.get("theme")!)

  await expect.poll(() => theme().scheme).toBe("light")
  expect(theme().tokens["--background"]).toBe("oklch(1 0 0)")

  document.documentElement.classList.add("dark")
  onTestFinished(() => document.documentElement.classList.remove("dark"))
  await expect.poll(() => theme().scheme).toBe("dark")
  expect(theme().tokens["--background"]).toBe("oklch(0.145 0 0)")
})

test("deletes an artifact from its context menu on the machine that holds it", async () => {
  useArtifacts.getState().select(thread.id, null)
  await render(<ArtifactsView thread={thread} />)
  await page.getByRole("button", { name: /Release notes/ }).click({ button: "right" })
  await page.getByRole("menuitem", { name: "Delete" }).click()

  await expect.poll(() => deleted).toEqual([{ payload: { id: "newer" }, environment: "cloud-1" }])
})
