import { Schema } from "effect"
import { Suspense } from "react"
import { expect, test } from "vitest"
import { page } from "vitest/browser"
import { render } from "vitest-browser-react"
import { type HinacodeBridge, RpcMethods } from "../../shared/contract.ts"
import { defaultClientSettings, type Message } from "../../shared/domain.ts"
import "../index.css"
import { MessageList } from "./MessageList.tsx"

const bridge: HinacodeBridge = {
  rpc: async (method) =>
    method === "clientSettings.get"
      ? { result: Schema.encodeSync(RpcMethods["clientSettings.get"].response)(defaultClientSettings) }
      : { error: { tag: "NotStubbed", message: method } },
  onEvent: () => () => {},
  pathForFile: () => "",
  liquidGlass: false,
}
Object.defineProperty(window, "hinacode", { value: bridge })

const sent = (text: string) =>
  ({
    id: "m-1",
    threadId: "t-1",
    role: "user",
    parts: [{ type: "text", text }],
    createdAt: "2026-11-01T00:00:00.000Z",
    completedAt: null,
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
