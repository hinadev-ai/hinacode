import { beforeEach, describe, expect, test } from "@effect/vitest"
import type { Attachment } from "../../shared/domain.ts"
import { emptyDraft, useDrafts } from "./drafts.ts"

const attachment = (id: string): Attachment => ({
  id,
  name: `${id}.png`,
  path: `/tmp/${id}.png`,
  mime: "image/png",
  kind: "image",
  bytes: 1,
})

const draftOf = (threadId: string) => useDrafts.getState().byThreadId[threadId] ?? emptyDraft

describe("useDrafts", () => {
  beforeEach(() => useDrafts.setState({ byThreadId: {} }))

  test("keeps a draft per thread", () => {
    const { setText, addAttachments } = useDrafts.getState()
    setText("a", "hello")
    addAttachments("a", [attachment("x")])
    expect(draftOf("a")).toStrictEqual({ text: "hello", attachments: [attachment("x")], worktree: null })
    expect(draftOf("b")).toStrictEqual(emptyDraft)
  })

  test("take empties the draft and returns what was in it", () => {
    const { setText, addAttachments, take } = useDrafts.getState()
    setText("a", "hello")
    addAttachments("a", [attachment("x")])
    expect(take("a")).toStrictEqual({ text: "hello", attachments: [attachment("x")], worktree: null })
    expect(draftOf("a")).toStrictEqual(emptyDraft)
  })

  test("text typed while a send is pending survives the send", () => {
    const { setText, take } = useDrafts.getState()
    setText("a", "first")
    take("a")
    setText("a", "second")
    expect(draftOf("a").text).toBe("second")
  })

  test("restore puts a failed send back in front of anything typed since", () => {
    const { setText, addAttachments, take, restore } = useDrafts.getState()
    setText("a", "first")
    addAttachments("a", [attachment("x")])
    const sent = take("a")
    setText("a", "second")
    addAttachments("a", [attachment("y")])
    restore("a", sent)
    expect(draftOf("a")).toStrictEqual({
      text: "first\nsecond",
      attachments: [attachment("x"), attachment("y")],
      worktree: null,
    })
  })

  test("removing the last content and discarding both drop the entry", () => {
    const { setText, addAttachments, removeAttachment, discard } = useDrafts.getState()
    setText("a", "hello")
    setText("a", "")
    addAttachments("b", [attachment("x")])
    removeAttachment("b", "x")
    setText("c", "hello")
    discard("c")
    expect(useDrafts.getState().byThreadId).toStrictEqual({})
  })
})
