import { describe, expect, test } from "@effect/vitest"
import { toImportedHistory } from "./sessions.ts"

const thread = { id: "t", name: null, model: "gpt-6.1-sol", cwd: "/work", createdAt: 1_790_000_000 }
const turn = (id: string, content: ReadonlyArray<Record<string, string>>, reply: string) => ({
  id,
  status: "completed",
  itemsView: "full",
  startedAt: 1_790_000_000,
  completedAt: 1_790_000_010,
  items: [
    { type: "userMessage", id: `${id}-user`, content },
    { type: "agentMessage", id: `${id}-reply`, text: reply },
  ],
})

describe("toImportedHistory", () => {
  test("keeps the images a prompt carried", () => {
    const { messages } = toImportedHistory({ thread }, [
      turn("1", [{ type: "image", url: "data:image/png;base64,aW1n" }], "A red square."),
      turn(
        "2",
        [
          { type: "text", text: "And this one?" },
          { type: "localImage", path: "/tmp/shot.png" },
        ],
        "Also red.",
      ),
    ])
    expect(messages?.map((message) => [message.role, message.parts.length, message.images])).toStrictEqual([
      ["user", 0, [{ dataUrl: "data:image/png;base64,aW1n", name: "image.png" }]],
      ["assistant", 1, undefined],
      ["user", 1, [{ path: "/tmp/shot.png" }]],
      ["assistant", 1, undefined],
    ])
  })

  test("reports no history when a prompt carries an image it can't keep", () => {
    const { messages } = toImportedHistory({ thread }, [
      turn("1", [{ type: "image", url: "https://example.com/a.png" }], "A red square."),
    ])
    expect(messages).toBeNull()
  })
})
