import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"
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
    assert.deepEqual(draftOf("a"), { text: "hello", attachments: [attachment("x")] })
    assert.deepEqual(draftOf("b"), emptyDraft)
  })

  test("take empties the draft and returns what was in it", () => {
    const { setText, addAttachments, take } = useDrafts.getState()
    setText("a", "hello")
    addAttachments("a", [attachment("x")])
    assert.deepEqual(take("a"), { text: "hello", attachments: [attachment("x")] })
    assert.deepEqual(draftOf("a"), emptyDraft)
  })

  test("text typed while a send is pending survives the send", () => {
    const { setText, take } = useDrafts.getState()
    setText("a", "first")
    take("a")
    setText("a", "second")
    assert.equal(draftOf("a").text, "second")
  })

  test("restore puts a failed send back in front of anything typed since", () => {
    const { setText, addAttachments, take, restore } = useDrafts.getState()
    setText("a", "first")
    addAttachments("a", [attachment("x")])
    const sent = take("a")
    setText("a", "second")
    addAttachments("a", [attachment("y")])
    restore("a", sent)
    assert.deepEqual(draftOf("a"), { text: "first\nsecond", attachments: [attachment("x"), attachment("y")] })
  })

  test("removing the last content and discarding both drop the entry", () => {
    const { setText, addAttachments, removeAttachment, discard } = useDrafts.getState()
    setText("a", "hello")
    setText("a", "")
    addAttachments("b", [attachment("x")])
    removeAttachment("b", "x")
    setText("c", "hello")
    discard("c")
    assert.deepEqual(useDrafts.getState().byThreadId, {})
  })
})
