import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { externalUrl } from "./security.ts"

const packagedDocument = "file:///opt/kkcode/resources/app.asar/out/renderer/index.html"
const resolved = (href: string) => new URL(href, packagedDocument).href

describe("externalUrl", () => {
  test("allows http and https", () => {
    assert.equal(externalUrl("https://github.com/kjj6198/kkcode/pull/1"), "https://github.com/kjj6198/kkcode/pull/1")
    assert.equal(externalUrl("http://example.com/a?b=1#c"), "http://example.com/a?b=1#c")
  })

  test("rejects file URLs, including relative and UNC-style links resolved against the app document", () => {
    assert.equal(externalUrl("file:///etc/passwd"), null)
    assert.equal(externalUrl(resolved("/tmp/kkcode-audit-link-target.txt")), null)
    assert.equal(externalUrl(resolved("notes/readme.md")), null)
    assert.equal(externalUrl(resolved("//host/share/payload.exe")), null)
    assert.equal(externalUrl(resolved("\\\\host\\share\\payload.exe")), null)
  })

  test("rejects unparseable input and paths that are not URLs", () => {
    assert.equal(externalUrl("\\\\host\\share\\payload.exe"), null)
    assert.equal(externalUrl("/tmp/x"), null)
    assert.equal(externalUrl(""), null)
  })

  test("rejects script and custom protocol handlers", () => {
    assert.equal(externalUrl("javascript:alert(1)"), null)
    assert.equal(externalUrl("JaVaScRiPt:alert(1)"), null)
    assert.equal(externalUrl("data:text/html,<script>alert(1)</script>"), null)
    assert.equal(externalUrl("mailto:someone@example.com"), null)
    assert.equal(externalUrl("vscode://file/etc/passwd"), null)
    assert.equal(externalUrl("ms-msdt:/id PCWDiagnostic"), null)
    assert.equal(externalUrl("smb://host/share"), null)
  })
})
