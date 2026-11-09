import { expect, test } from "vitest"
import { documentPrintHtml } from "./documentPrint.ts"

test("wraps the editor's HTML in a page that can run no script and load nothing from outside", () => {
  const html = documentPrintHtml("Plan </title><script>alert(1)</script>", "<h1>Plan</h1><p>Body</p>")

  expect(html).toMatch(/^<!doctype html><html><head>/)
  expect(html).toContain(
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
  )
  expect(html).toContain("<title>Plan &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>")
  expect(html).toContain('<main class="document"><h1>Plan</h1><p>Body</p></main>')
})
