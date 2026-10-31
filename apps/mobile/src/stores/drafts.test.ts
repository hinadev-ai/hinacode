import type { Attachment } from "@shared/domain.ts"
import { beforeEach, expect, it } from "vitest"
import { type DraftImage, useDrafts } from "./drafts"

const image = (id: string): DraftImage => ({
  attachment: {
    id,
    name: `${id}.png`,
    path: `/staged/${id}.png`,
    mime: "image/png",
    kind: "image",
    bytes: 1,
  } as Attachment,
  preview: `file:///${id}.png`,
})

beforeEach(() => useDrafts.setState({ byThreadId: {}, images: {}, workspaces: {}, sending: {} }))

it("takes the text and images together and leaves the composer empty", () => {
  useDrafts.getState().setText("t1", "describe this")
  useDrafts.getState().addImages("t1", [image("a")])

  expect(useDrafts.getState().take("t1")).toEqual({ text: "describe this", images: [image("a")] })
  expect(useDrafts.getState().byThreadId.t1).toBeUndefined()
  expect(useDrafts.getState().images.t1).toBeUndefined()
})

it("puts a failed draft's images back ahead of the ones attached since", () => {
  useDrafts.getState().addImages("t1", [image("a")])
  const sent = useDrafts.getState().take("t1")
  useDrafts.getState().addImages("t1", [image("b")])

  useDrafts.getState().restore("t1", sent)

  expect(useDrafts.getState().images.t1).toEqual([image("a"), image("b")])
})

it("removes one image by its attachment id", () => {
  useDrafts.getState().addImages("t1", [image("a"), image("b")])

  useDrafts.getState().removeImage("t1", "a")

  expect(useDrafts.getState().images.t1).toEqual([image("b")])
})
