import { describe, expect, test } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { rehypeGitHubHtml } from "./rehypeGitHubHtml.ts"

const render = (text: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { rehypePlugins: rehypeGitHubHtml }, text))

describe("markdown with GitHub html", () => {
  test("renders a bot comment's html table", () => {
    const html = render(
      '<!-- Preview URL -->\n<table><tr><td><b>Build:</b> Success</td><td><a href="https://example.com">View logs</a></td></tr></table>',
    )
    expect(html).toContain("<table>")
    expect(html).toContain("<b>Build:</b>")
    expect(html).not.toContain("Preview URL")
  })

  test("strips scripts, event handlers and javascript links", () => {
    const html = render('<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>')
    expect(html).not.toContain("<script")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("javascript:")
  })
})
