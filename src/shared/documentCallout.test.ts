import { expect, test } from "vitest"
import { calloutMarker, splitCalloutMarker } from "./documentCallout.ts"

test("reads a GitHub alert marker on the first line in any case", () => {
  expect(splitCalloutMarker("[!NOTE]\nFirst line.")).toEqual({ tone: "note", rest: "First line." })
  expect(splitCalloutMarker("[!tip]")).toEqual({ tone: "tip", rest: "" })
  expect(splitCalloutMarker(" [!Caution] \nOne\nTwo")).toEqual({ tone: "caution", rest: "One\nTwo" })
})

test("leaves a quote alone unless the marker stands alone on its line", () => {
  expect(splitCalloutMarker("[!NOTE] inline text")).toBeNull()
  expect(splitCalloutMarker("Some quote\n[!NOTE]")).toBeNull()
  expect(splitCalloutMarker("[!INFO]")).toBeNull()
  expect(splitCalloutMarker("[NOTE]")).toBeNull()
})

test("writes the marker in upper case", () => {
  expect(calloutMarker("important")).toBe("[!IMPORTANT]")
})
