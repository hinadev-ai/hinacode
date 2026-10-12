import { describe, expect, test } from "@effect/vitest"
import { linkify } from "./linkify.ts"

const links = (text: string) => linkify(text).flatMap((segment) => (segment.type === "link" ? [segment.href] : []))

describe("linkify", () => {
  test("splits text around urls and keeps every character", () => {
    const text = "see https://linear.app/ and\nhttp://localhost:5173/a?b=1#c too"
    const segments = linkify(text)
    expect(segments.map((segment) => segment.text).join("")).toBe(text)
    expect(segments).toStrictEqual([
      { type: "text", text: "see " },
      { type: "link", text: "https://linear.app/", href: "https://linear.app/" },
      { type: "text", text: " and\n" },
      { type: "link", text: "http://localhost:5173/a?b=1#c", href: "http://localhost:5173/a?b=1#c" },
      { type: "text", text: " too" },
    ])
  })

  test("leaves trailing punctuation out of the url", () => {
    expect(
      links("go to https://a.dev/x. Then https://b.dev, https://c.dev; https://d.dev! https://e.dev?"),
    ).toStrictEqual(["https://a.dev/x", "https://b.dev", "https://c.dev", "https://d.dev", "https://e.dev"])
  })

  test("keeps a closing paren only when the url opened one", () => {
    expect(links("(see https://a.dev/x)")).toStrictEqual(["https://a.dev/x"])
    expect(links("https://en.wikipedia.org/wiki/Mars_(planet)")).toStrictEqual([
      "https://en.wikipedia.org/wiki/Mars_(planet)",
    ])
  })

  test("only links http and https", () => {
    expect(links("file:///etc/passwd javascript:alert(1) ftp://x.dev https://")).toStrictEqual([])
  })

  test("text without urls is one text segment", () => {
    expect(linkify("plain")).toStrictEqual([{ type: "text", text: "plain" }])
    expect(linkify("")).toStrictEqual([])
  })
})
