import { describe, expect, test } from "@effect/vitest"
import { faviconOrigins, linkify } from "./linkify.ts"

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

describe("faviconOrigins", () => {
  test("keeps the first distinct origins in reading order, up to the limit", () => {
    const texts = ["https://a.dev/1 https://b.dev https://a.dev/2", "[c](https://c.dev/x) https://d.dev"]
    expect([...faviconOrigins(texts, 3)]).toStrictEqual(["https://a.dev", "https://b.dev", "https://c.dev"])
  })

  test("allows 20 origins by default", () => {
    const text = Array.from({ length: 25 }, (_, index) => `https://site${index}.dev`).join(" ")
    const origins = faviconOrigins([text])
    expect(origins.size).toBe(20)
    expect(origins.has("https://site19.dev")).toBe(true)
    expect(origins.has("https://site20.dev")).toBe(false)
  })
})
