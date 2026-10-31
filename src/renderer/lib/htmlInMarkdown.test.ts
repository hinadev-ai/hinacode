import { describe, expect, test } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { parseBadgeBlock, rehypeEmbeddedHtml, remarkUnknownTagsAsText, segmentServiceBlocks } from "./htmlInMarkdown.ts"
import { remarkKbd } from "./remarkKbd.ts"

const render = (text: string) =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm, remarkKbd, remarkUnknownTagsAsText], rehypePlugins: [rehypeEmbeddedHtml] },
      text,
    ),
  )

const codesmithFooter = [
  "<!-- codesmith:footer -->",
  "---",
  '<a href="https://app.example/pr/1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://e/view-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://e/view-light.svg"><img alt="View with smith" src="https://e/view.png" width="162" height="28"></picture></a> <a href="https://e/autofix"><img alt="Autofix" src="https://e/autofix.png" width="190" height="28"></a>',
  "<sup>Need help? Tag <code>@smith-bot</code> here.</sup>",
  "<!-- codesmith:autofix:disabled -->",
  "<!-- /codesmith:footer -->",
].join("\n")

describe("html in markdown", () => {
  test("renders a bot comment's html table and drops its marker comments", () => {
    const html = render(
      '<!-- Preview URL -->\n<table><tr><td><b>Build:</b> Success</td><td><a href="https://example.com">View logs</a></td></tr></table>',
    )
    expect(html).toContain("<table>")
    expect(html).toContain("<b>Build:</b>")
    expect(html).not.toContain("Preview URL")
  })

  test("keeps placeholder tags in prose as visible text", () => {
    const html = render("Connecting to <hostname>, and <Suspense> wraps <your-name> today")
    expect(html).toContain("&lt;hostname&gt;")
    expect(html).toContain("&lt;Suspense&gt;")
    expect(html).toContain("&lt;your-name&gt;")
    expect(html).toContain("today")
  })

  test("renders br inside a table cell and details around markdown", () => {
    expect(render("| a |\n| --- |\n| one<br>two |")).toContain("one<br/>two")
    const folded = render("<details><summary>7 warnings</summary>\n\n- first\n- second\n\n</details>")
    expect(folded).toContain("<details>")
    expect(folded).toContain("<summary>7 warnings</summary>")
    expect(folded).toContain("<li>first</li>")
  })

  test("strips scripts, event handlers and javascript links", () => {
    const blocked = render(
      '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n<a href="javascript:alert(1)">x</a>',
    )
    expect(blocked).not.toContain("<script>")
    expect(blocked).not.toContain('onerror="')
    expect(blocked).not.toContain('href="javascript:')
    const nested = render("<div><script>alert(1)</script><p>safe</p></div>")
    expect(nested).not.toContain("<script>")
    expect(nested).not.toContain("alert(1)")
    expect(nested).toContain("safe")
  })

  test("leaves code alone", () => {
    const html = render("Use `<div>` and:\n\n```html\n<hostname>\n```")
    expect(html).toContain("&lt;div&gt;")
    expect(html).toContain("&lt;hostname&gt;")
    expect(html).not.toContain("<div>")
  })

  test("skips the html parse when the tree has no raw nodes", () => {
    const transform = rehypeEmbeddedHtml()
    const plain = { type: "root", children: [{ type: "element", children: [{ type: "text" }] }] }
    expect(transform(plain)).toBe(plain)
    const withRaw = {
      type: "root",
      children: [{ type: "element", tagName: "p", properties: {}, children: [{ type: "raw", value: "<br>" }] }],
    }
    const parsed = transform(withRaw as never) as unknown as { children: Array<{ children: Array<{ type: string }> }> }
    expect(parsed).not.toBe(withRaw)
    expect(parsed.children[0]?.children[0]?.type).toBe("element")
  })
})

describe("service badge blocks", () => {
  test("parses badge links with scheme variants and the note", () => {
    const parsed = parseBadgeBlock(codesmithFooter)
    expect(parsed?.badges).toHaveLength(2)
    expect(parsed?.badges[0]).toMatchObject({
      href: "https://app.example/pr/1",
      alt: "View with smith",
      src: "https://e/view.png",
      darkSrc: "https://e/view-dark.svg",
      lightSrc: "https://e/view-light.svg",
      width: 162,
      height: 28,
    })
    expect(parsed?.badges[1]).toMatchObject({ alt: "Autofix", darkSrc: null })
    expect(parsed?.note).toBe("Need help? Tag @smith-bot here.")
  })

  test("segments a delimited footer out of a pull request body", () => {
    const segments = segmentServiceBlocks(`## Overview\n\nBody text.\n\n${codesmithFooter}`)
    expect(segments.map((segment) => segment.type)).toEqual(["markdown", "badges"])
    const [lead, badges] = segments
    if (lead?.type !== "markdown" || badges?.type !== "badges") throw new Error("unexpected segments")
    expect(lead.text).toContain("Body text.")
    expect(badges.badges).toHaveLength(2)
    expect(badges.note).toBe("Need help? Tag @smith-bot here.")
  })

  test("falls back to one markdown segment when the block does not parse", () => {
    const changed = "Body.\n\n<!-- codesmith:footer -->\nJust text, no badges.\n<!-- /codesmith:footer -->"
    expect(segmentServiceBlocks(changed)).toEqual([{ type: "markdown", text: changed }])
    expect(render(changed)).toContain("Just text, no badges.")
    const unclosed = "Body.\n\n<!-- codesmith:footer -->\nTrailing"
    expect(segmentServiceBlocks(unclosed)).toEqual([{ type: "markdown", text: unclosed }])
  })

  test("leaves unknown markers and plain text in one segment", () => {
    const text = "<!-- bundle-size -->\n### Bundle size\n\n| a |\n| --- |\n| 1 |"
    expect(segmentServiceBlocks(text)).toEqual([{ type: "markdown", text }])
    expect(render(text)).not.toContain("bundle-size")
    expect(render(text)).toContain("<table>")
    expect(segmentServiceBlocks("No markers at all")).toEqual([{ type: "markdown", text: "No markers at all" }])
  })
})
