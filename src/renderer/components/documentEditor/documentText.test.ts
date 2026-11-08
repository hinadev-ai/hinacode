import { Schema } from "@tiptap/pm/model"
import { expect, test } from "vitest"
import { documentText } from "./documentText.ts"

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    heading: { group: "block", content: "text*" },
    paragraph: { group: "block", content: "text*" },
    text: {},
  },
  marks: { bold: {} },
})

const plan = schema.node("doc", null, [
  schema.node("heading", null, [schema.text("Plan")]),
  schema.node("paragraph", null, [
    schema.text("Ship the "),
    schema.text("editor", [schema.mark("bold")]),
    schema.text(" first."),
  ]),
])

test("joins the text of every block with a line break, across marks", () => {
  expect(documentText(plan).text).toBe("Plan\nShip the editor first.")
})

test("maps a selection to the text it covers and back", () => {
  const mapped = documentText(plan)
  const editor = { from: 16, to: 22 }

  const range = mapped.textRange(editor)

  expect(mapped.text.slice(range.from, range.to)).toBe("editor")
  expect(mapped.documentRange(range)).toEqual(editor)
})

test("maps a selection that crosses blocks", () => {
  const mapped = documentText(plan)

  const range = mapped.textRange({ from: 3, to: 11 })

  expect(mapped.text.slice(range.from, range.to)).toBe("an\nShip")
  expect(mapped.documentRange(range)).toEqual({ from: 3, to: 11 })
})

test("clamps positions between blocks to the text next to them", () => {
  const mapped = documentText(plan)

  expect(mapped.textRange({ from: 0, to: plan.content.size })).toEqual({ from: 0, to: mapped.text.length })
  expect(mapped.textRange({ from: 5, to: 7 })).toEqual({ from: 5, to: 5 })
})
