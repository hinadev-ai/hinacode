import { Schema } from "effect"
import { Suspense } from "react"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import type { Artifact } from "../../shared/artifact.ts"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings, type Message, type TerminalSession } from "../../shared/domain.ts"
import { useArtifacts } from "../stores/artifacts.ts"
import { useTerminals } from "../stores/terminals.ts"
import "../index.css"
import { MessageList } from "./MessageList.tsx"

const plan: Artifact = {
  id: "plan-1",
  kind: "document",
  title: "Login plan",
  entry: "document.md",
  version: 1,
  files: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  threadId: "t-1",
}

const bridge: HinacodeBridge = {
  rpc: async (method) => {
    if (method === "clientSettings.get")
      return { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
    if (method === "artifacts.list") return { result: [plan] }
    return { error: { tag: "NotStubbed", message: method } }
  },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
  runtime: { kind: "desktop" },
}
Object.defineProperty(window, "hinacode", { value: bridge })

const sent = (text: string, role: Message["role"] = "user") =>
  ({
    id: `m-${role}`,
    threadId: "t-1",
    role,
    parts: [{ type: "text", text }],
    createdAt: "2026-11-01T00:00:00.000Z",
    completedAt: "2026-11-01T00:00:01.000Z",
    usage: null,
    forkPoint: null,
  }) as unknown as Message

test("shows a sent bullet as a dot, the way the composer did", async () => {
  await render(
    <Suspense>
      <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
        <MessageList messages={[sent("- 123\n2. two")]} providerLabel="Claude" />
      </div>
    </Suspense>,
  )
  const bubble = page.getByRole("article", { name: "You" })
  await expect.element(bubble).toHaveTextContent("• 123 2. two")
})

const session = (id: string, title: string | null): TerminalSession => ({
  id,
  threadId: "t-1",
  cwd: "/repo",
  cols: 80,
  rows: 24,
  status: "running",
  exitCode: null,
  title,
  command: null,
  lastExitCode: null,
})

test("a terminal mention opens that terminal, and a closed one shows no id", async () => {
  useTerminals.setState({
    byThreadId: {
      "t-1": { sessions: [session("term-1", null), session("term-2", "pnpm dev")], activeId: "term-1", open: false },
    },
  })
  await render(
    <Suspense>
      <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
        <MessageList
          messages={[
            sent("why does @terminal:term-1 fail but not @terminal:gone-1?"),
            sent("The server in @terminal:term-2 printed the error.", "assistant"),
          ]}
          providerLabel="Claude"
        />
      </div>
    </Suspense>,
  )
  await expect
    .element(page.getByRole("article", { name: "You" }))
    .toHaveTextContent("why does @Terminal 1 fail but not closed terminal?")

  await page.getByRole("button", { name: "@pnpm dev" }).click()
  expect(useTerminals.getState().byThreadId["t-1"]).toMatchObject({ open: true, activeId: "term-2" })
})

test("an artifact mention shows its title and opens it beside the thread", async () => {
  await render(
    <Suspense>
      <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
        <MessageList
          messages={[
            sent("follow @artifact:plan-1, not @artifact:gone-1"),
            sent("I updated @artifact:plan-1.", "assistant"),
          ]}
          providerLabel="Claude"
        />
      </div>
    </Suspense>,
  )
  await expect
    .element(page.getByRole("article", { name: "You" }))
    .toHaveTextContent("follow @Login plan, not @artifact:gone-1")

  await page.getByRole("button", { name: "@Login plan" }).last().click()
  expect(useArtifacts.getState().selected["t-1"]).toBe("plan-1")
})
